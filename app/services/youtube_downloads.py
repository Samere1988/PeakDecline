"""Background local downloads and VOD preparation, isolated from Live TV."""
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import uuid

from gevent.lock import RLock
from .streamer import streamer


class PreparationCancelled(Exception):
    """The room changed before this preparation could be published."""


class YouTubeDownloads:
    def __init__(self):
        self.jobs = {}
        self.lock = RLock()

    def root(self, app):
        return Path(app.instance_path) / 'youtube'

    @staticmethod
    def python_path(app):
        override = app.config.get('YOUTUBE_PYTHON') or os.environ.get('YOUTUBE_PYTHON')
        if override:
            return str(override)
        project = Path(__file__).resolve().parents[2]
        relative = 'Scripts/python.exe' if os.name == 'nt' else 'bin/python'
        candidate = project / '.venv' / relative
        return str(candidate) if candidate.is_file() else sys.executable

    @staticmethod
    def node_runtime(app):
        override = app.config.get('YOUTUBE_NODE') or os.environ.get('YOUTUBE_NODE')
        candidates = [override, shutil.which('node')]
        if os.name == 'nt':
            candidates.extend([
                Path(os.environ.get('ProgramFiles', 'C:/Program Files')) / 'nodejs/node.exe',
                Path.home() / '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe',
            ])
        for candidate in candidates:
            if candidate and Path(candidate).is_file():
                return 'node:' + str(candidate)
        return 'node'

    @staticmethod
    def failure_message(command, directory):
        # Only classify known failures; never expose raw URLs, paths or log contents.
        with (directory / 'worker.log').open('rb') as log:
            log.seek(0, 2)
            log.seek(max(0, log.tell() - 16384))
            tail = log.read().decode('utf-8', errors='replace')
        if 'No module named yt_dlp' in tail:
            return 'The server downloader is not installed in its Python environment. Install requirements-youtube.txt using YOUTUBE_PYTHON or the project .venv, then retry.'
        if 'yt_dlp' in command:
            return 'YouTube download failed. The video may be restricted or unavailable. The server worker log has details.'
        return 'The video downloaded, but local video conversion failed. The server worker log has details.'

    def start(self, app, room_id, host_id, video_id, offset, media_version, media_url, socketio):
        with self.lock:
            previous = self.jobs.get(str(room_id))
            if previous and previous['state'] in ('downloading', 'preparing'):
                raise ValueError('A video is already being prepared for this room.')
            if sum(job['state'] in ('downloading', 'preparing') for job in self.jobs.values()) >= 2:
                raise ValueError('The server is preparing other videos. Please try again shortly.')
            self.cleanup(app)
            root = self.root(app)
            root.mkdir(parents=True, exist_ok=True)
            if shutil.disk_usage(root).free < 6 * 1024 ** 3:
                raise ValueError('The server needs at least 6 GB free to prepare a video.')
            job = dict(id=uuid.uuid4().hex, state='downloading', message='Downloading video/audio (current file)…',
                       percent=None, eta_seconds=None, stage_started=time.monotonic(),
                       room_id=str(room_id), host_id=str(host_id), video_id=video_id, offset=offset,
                       media_version=media_version, media_url=media_url)
            self.jobs[str(room_id)] = job
            socketio.start_background_task(self.run, app, job, socketio)
            return self.public(job)

    @staticmethod
    def public(job):
        payload = {key: job[key] for key in ('id', 'state', 'message')}
        payload.update(percent=job.get('percent'), eta_seconds=job.get('eta_seconds'),
                       elapsed_seconds=round(time.monotonic() - job.get('stage_started', time.monotonic())),
                       stalled=job.get('stalled', False), published=job.get('published', False),
                       prepared_seconds=job.get('prepared_seconds', 0),
                       media_url=job.get('media_url_published'))
        return payload

    @staticmethod
    def playlist_snapshot(directory):
        """Only count closed segments advertised by the atomically written playlist."""
        try:
            text = (directory / 'index.m3u8').read_text()
        except OSError:
            return {'prepared_seconds': 0, 'complete': False}
        durations = re.findall(r'^#EXTINF:([\d.]+)', text, re.MULTILINE)
        segments = re.findall(r'^(seg_\d+\.ts)\s*$', text, re.MULTILINE)
        if not segments or len(segments) != len(durations) or not (directory / segments[-1]).is_file():
            return {'prepared_seconds': 0, 'complete': False}
        return {'prepared_seconds': sum(map(float, durations)), 'complete': '#EXT-X-ENDLIST' in text}

    def publish(self, app, job, socketio, complete=False):
        snapshot = self.playlist_snapshot(self.root(app) / job['id'])
        job['prepared_seconds'] = snapshot['prepared_seconds']
        if job.get('published') or job.get('state') == 'cancelled':
            return
        # Publish as soon as a small safety buffer is available.  The room
        # status bar then reflects preparation of the remaining video while
        # the shared player starts after roughly 10–15 seconds are ready.
        buffer_seconds = max(10, min(180, float(app.config.get('YOUTUBE_START_BUFFER_SECONDS', 12))))
        if not complete and not snapshot['complete'] and snapshot['prepared_seconds'] < job['offset'] + buffer_seconds:
            return
        with app.app_context():
            from app import db, routes
            from app.models import Room
            room = db.session.get(Room, job['room_id'])
            state = routes.room_states.get(job['room_id'], {})
            if (not room or str(room.host_id) != job['host_id']
                    or room.current_media_url != job['media_url']
                    or state.get('media_version', '') != job['media_version']
                    or state.get('status') == 'game'):
                job.update(state='cancelled', message='The room or host changed. Select the video again to play it.')
                return
            room.current_media_key = 'youtube:' + job['video_id']
            room.current_media_url = f"/api/room/youtube-files/{job['id']}/index.m3u8"
            room.current_media_title = job['title']
            routes._save_room_playback_state(room.id, 'playing', job['offset'], routes._now(), new_media=True)
            job.update(published=True, media_url_published=room.current_media_url,
                       message='Playing in the room. Preparing the rest…')
            socketio.emit('media_updated', routes._get_room_state_payload(room), to=f'room_{room.id}')

    def pause_failed_stream(self, app, job, socketio):
        # Keep the prepared portion, but stop the shared clock if production fails.
        with app.app_context():
            from app import db, routes
            from app.models import Room
            room = db.session.get(Room, job['room_id'])
            if room and room.current_media_url == job.get('media_url_published'):
                state = routes._get_room_state_payload(room)
                if state:
                    position = min(state['current_time'], max(0, job.get('prepared_seconds', 0) - 1))
                    routes._save_room_playback_state(room.id, 'paused', position)
                    routes._broadcast_playback(room.id, 'force_pause')

    @staticmethod
    def update_progress(directory, job):
        path = directory / ('progress.txt' if job['state'] == 'preparing' else 'worker.log')
        now = time.monotonic()
        job.setdefault('last_progress', job.get('stage_started', now))
        job['stalled'] = now - job['last_progress'] > 120
        if not path.exists():
            return
        with path.open('rb') as stream:
            stream.seek(0, 2)
            stream.seek(max(0, stream.tell() - 32768))
            text = stream.read().decode('utf-8', errors='replace').replace('\r', '')
        percent = eta = None
        if job['state'] == 'preparing':
            times = re.findall(r'^out_time_us=(\d+)$', text, re.MULTILINE)
            speeds = re.findall(r'^speed=\s*([\d.]+)x$', text, re.MULTILINE)
            if times and job.get('duration', 0) > 0:
                position = int(times[-1]) / 1000000
                percent = position / job['duration'] * 100
                speed = float(speeds[-1]) if speeds else 0
                if speed > 0:
                    eta = max(0, job['duration'] - position) / speed
        else:
            for line in reversed(text.splitlines()):
                if not line.startswith('PD_PROGRESS:'):
                    continue
                try:
                    progress = json.loads(line.removeprefix('PD_PROGRESS:'))
                    total = progress.get('total_bytes') or progress.get('total_bytes_estimate')
                    if total:
                        percent = progress.get('downloaded_bytes', 0) / total * 100
                    eta = progress.get('eta')
                    break
                except (ValueError, TypeError):
                    continue
        if percent is not None and percent != job.get('raw_percent'):
            job.update(last_progress=now, raw_percent=percent, stalled=False)
        job['percent'] = min(99, max(0, percent)) if percent is not None and math.isfinite(percent) else None
        job['eta_seconds'] = round(eta) if isinstance(eta, (float, int)) and math.isfinite(eta) else None

    def cleanup(self, app):
        from app.models import Room
        protected = {room.current_media_url for room in Room.query.all()}
        running = {job['id'] for job in self.jobs.values() if job['state'] in ('downloading', 'preparing')}
        root = self.root(app).resolve()
        if not root.exists():
            return
        for directory in root.iterdir():
            if (not re.fullmatch(r'[a-f0-9]{32}', directory.name) or directory.is_symlink()
                    or not directory.is_dir() or directory.resolve().parent != root):
                continue
            url = f'/api/room/youtube-files/{directory.name}/index.m3u8'
            if directory.name not in running and url not in protected and time.time() - directory.stat().st_mtime > 86400:
                shutil.rmtree(directory)

    @staticmethod
    def execute(command, directory, socketio, seconds=3600, job=None, on_progress=None):
        # Poll cooperatively: blocking subprocess.wait() would freeze gevent rooms.
        with (directory / 'worker.log').open('a', encoding='utf-8') as log:
            process = subprocess.Popen(command, stdout=log, stderr=log,
                                       creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            deadline = time.monotonic() + seconds
            try:
                while process.poll() is None:
                    if job is not None:
                        YouTubeDownloads.update_progress(directory, job)
                        if job.get('stalled') and job['state'] == 'preparing':
                            if time.monotonic() - job['last_progress'] > 300:
                                raise RuntimeError('Video preparation stopped making progress for five minutes. Please retry.')
                    if on_progress is not None:
                        on_progress()
                        if job and job.get('state') == 'cancelled':
                            raise PreparationCancelled()
                    if time.monotonic() > deadline:
                        raise RuntimeError('Video preparation timed out. Try a shorter video.')
                    if sum(p.stat().st_size for p in directory.iterdir() if p.is_file()) > 4 * 1024 ** 3:
                        raise RuntimeError('This video exceeds the 4 GB preparation limit.')
                    socketio.sleep(0.5)
                if process.returncode:
                    raise RuntimeError(YouTubeDownloads.failure_message(command, directory))
            finally:
                if process.poll() is None:
                    process.kill()
                    while process.poll() is None:
                        socketio.sleep(0.05)

    def run(self, app, job, socketio):
        directory = self.root(app) / job['id']
        try:
            directory.mkdir(parents=True)
            command = [self.python_path(app), '-m', 'yt_dlp', '--ignore-config', '--no-playlist',
                       '--newline', '--progress', '--progress-template', 'download:PD_PROGRESS:%(progress)j',
                       '--no-warnings', '--socket-timeout', '30', '--retries', '2',
                       '--js-runtimes', self.node_runtime(app), '--ffmpeg-location', streamer.get_ffmpeg_path(),
                       '--match-filters', '!is_live & !is_upcoming & duration <= 14400',
                       '--max-filesize', '2G', '-f',
                       'bv*[vcodec^=avc1][height<=1080]+ba/b[vcodec^=avc1][height<=1080]/bv*[height<=1080]+ba/b[height<=1080]',
                       '--merge-output-format', 'mkv', '--write-info-json',
                       '-o', str(directory / 'source.%(ext)s'),
                       '--', 'https://www.youtube.com/watch?v=' + job['video_id']]
            self.execute(command, directory, socketio, job=job)
            sources = [p for p in directory.glob('source.*') if p.suffix in ('.mkv', '.mp4', '.webm')]
            if len(sources) != 1:
                raise RuntimeError('No downloadable video was found. Use a recorded video under four hours and 2 GB.')
            info = json.loads((directory / 'source.info.json').read_text(encoding='utf-8'))
            job['title'] = str(info.get('title') or 'YouTube video')[:200]
            job['duration'] = float(info.get('duration') or 0)
            if job['duration']:
                job['offset'] = min(job['offset'], max(0, job['duration'] - 1))
            copy_video = str(info.get('vcodec', '')).startswith(('avc1', 'h264'))
            job.update(state='preparing', percent=0, eta_seconds=None, stalled=False,
                       last_progress=time.monotonic(), raw_percent=None,
                       duration=float(info.get('duration') or 0), stage_started=time.monotonic(),
                       message='Download complete. Packaging for playback…' if copy_video else
                               'Download complete. Converting video for playback…')
            self.execute(streamer.vod_command(sources[0], str(directory), copy_video=copy_video),
                         directory, socketio, job=job,
                         on_progress=lambda: self.publish(app, job, socketio))
            playlist = directory / 'index.m3u8'
            if not playlist.exists() or '#EXT-X-ENDLIST' not in playlist.read_text():
                raise RuntimeError('The server could not finish preparing this video.')
            sources[0].unlink()
            (directory / 'source.info.json').unlink()
            self.publish(app, job, socketio, complete=True)
            if job.get('state') == 'cancelled':
                return
            job.update(state='ready', percent=100, eta_seconds=0, stalled=False, message='Ready. Playing in the room.')
        except PreparationCancelled:
            return
        except Exception as error:
            if job.get('published'):
                self.pause_failed_stream(app, job, socketio)
            job.update(state='error', message=str(error) if isinstance(error, RuntimeError) else 'The server could not prepare this video. Check the downloader installation and available disk space.')
            app.logger.warning('YouTube preparation failed for job %s: %s', job['id'], type(error).__name__)


youtube_downloads = YouTubeDownloads()
