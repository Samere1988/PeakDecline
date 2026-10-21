"""Isolated YouTube routes/worker tests; no production DB or internet access."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from flask import Flask
from app import db, login_manager, socketio, routes
from app.models import Room, User
from app.services.youtube import parse_youtube_url
from app.services.youtube_downloads import youtube_downloads
from app.services.streamer import streamer


class YouTubeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = Flask(__name__, instance_path=self.temp.name)
        self.app.config.update(TESTING=True, SECRET_KEY='isolated', SQLALCHEMY_DATABASE_URI='sqlite://',
                               SQLALCHEMY_BINDS={'channels_db': 'sqlite://'})
        db.init_app(self.app)
        login_manager.init_app(self.app)
        socketio.init_app(self.app, async_mode='threading')
        self.app.register_blueprint(routes.main_bp)
        self.ctx = self.app.app_context()
        self.ctx.push()
        db.create_all()
        db.session.add_all([User(id='host', username='host', email='host@example.test'),
                            User(id='viewer', username='viewer', email='viewer@example.test'),
                            Room(id=1, name='Test', host_id='host', current_media_url='/old.m3u8')])
        db.session.commit()
        routes.room_states.clear()
        routes._save_room_playback_state(1, 'paused', 0, new_media=True)
        youtube_downloads.jobs.clear()
        self.http = self.app.test_client()
        self.login('host')
        self.tasks = []
        self.background = patch.object(socketio, 'start_background_task', lambda fn, *args: self.tasks.append((fn, args)))
        self.background.start()

    def tearDown(self):
        self.background.stop()
        db.session.remove()
        db.drop_all()
        self.ctx.pop()
        self.temp.cleanup()

    def login(self, user):
        with self.http.session_transaction() as session:
            session['_user_id'] = user
            session['_fresh'] = True

    def start(self):
        return self.http.post('/api/room/1/set_youtube', json={'url': 'https://youtu.be/BaW_jenozKc?t=2'})

    def fixture_execute(self, command, directory, socket, **kwargs):
        if 'yt_dlp' in command:
            (directory / 'source.mp4').write_bytes(b'fixture')
            (directory / 'source.info.json').write_text(json.dumps({'title': 'A test video', 'duration': 10}))
        else:
            (directory / 'index.m3u8').write_text('#EXTM3U\n#EXTINF:10,\nseg_000000.ts\n#EXT-X-ENDLIST\n')
            (directory / 'seg_000000.ts').write_bytes(b'segment')

    def run_job(self):
        with patch.object(youtube_downloads, 'execute', self.fixture_execute):
            fn, args = self.tasks.pop(0)
            fn(*args)

    def test_validation(self):
        for url in ('https://youtube.com/watch?v=BaW_jenozKc', 'https://youtu.be/BaW_jenozKc',
                    'https://m.youtube.com/shorts/BaW_jenozKc', 'https://youtube.com/live/BaW_jenozKc'):
            self.assertEqual(parse_youtube_url(url)[0], 'BaW_jenozKc')
        self.assertEqual(parse_youtube_url('https://youtu.be/BaW_jenozKc?t=1h2m3s')[1], 3723)
        for url in (None, [], 'file:///secret', 'https://youtube.com.evil/watch?v=BaW_jenozKc',
                    'https://youtube.com/playlist?list=foo', 'https://youtu.be/../secret',
                    'https://youtu.be/BaW_jenozKc?t=NaN', 'https://evil@youtube.com/watch?v=BaW_jenozKc'):
            with self.assertRaises(ValueError): parse_youtube_url(url)

    def test_worker_uses_project_environment_when_app_runs_global_python(self):
        with patch('app.services.youtube_downloads.sys.executable', 'global-python.exe'):
            interpreter = youtube_downloads.python_path(self.app)
        self.assertIn('.venv', interpreter)
        result = subprocess.run([interpreter, '-m', 'yt_dlp', '--version'], capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.app.config['YOUTUBE_PYTHON'] = 'configured-python'
        self.assertEqual(youtube_downloads.python_path(self.app), 'configured-python')

    def test_missing_downloader_has_specific_error(self):
        directory = Path(self.temp.name)
        (directory / 'worker.log').write_text('python.exe: No module named yt_dlp\n')
        message = youtube_downloads.failure_message(['python', '-m', 'yt_dlp'], directory)
        self.assertIn('not installed', message)
        self.assertNotIn('restricted', message)

    def test_preparation_progress_and_stall_detection(self):
        directory = Path(self.temp.name)
        progress = directory / 'progress.txt'
        progress.write_bytes(b'out_time_us=50000000\r\nspeed=2.0x\r\nprogress=continue\r\n')
        job = dict(state='preparing', duration=200, stage_started=time.monotonic())
        youtube_downloads.update_progress(directory, job)
        self.assertEqual(job['percent'], 25)
        self.assertEqual(job['eta_seconds'], 75)
        job['last_progress'] -= 121
        youtube_downloads.update_progress(directory, job)
        self.assertTrue(job['stalled'])
        progress.write_text('out_time_us=100000000\nspeed=4.0x\n')
        youtube_downloads.update_progress(directory, job)
        self.assertEqual(job['percent'], 50)
        self.assertFalse(job['stalled'])

    def test_download_progress_handles_partial_lines_and_unknown_size(self):
        directory = Path(self.temp.name)
        log = directory / 'worker.log'
        log.write_text('PD_PROGRESS:{"downloaded_bytes": 40, "total_bytes": 100, "eta": 3}\nPD_PROGRESS:{')
        job = dict(state='downloading')
        youtube_downloads.update_progress(directory, job)
        self.assertEqual(job['percent'], 40)
        self.assertEqual(job['eta_seconds'], 3)
        log.write_text('PD_PROGRESS:{"downloaded_bytes": 40}\n')
        youtube_downloads.update_progress(directory, job)
        self.assertIsNone(job['percent'])

    def test_authorization(self):
        self.login('viewer')
        self.assertEqual(self.start().status_code, 403)
        self.assertEqual(len(self.tasks), 0)

    def test_download_publishes_local_media_and_reconnect(self):
        self.assertEqual(self.start().status_code, 202)
        self.assertEqual(db.session.get(Room, 1).current_media_url, '/old.m3u8')
        self.assertEqual(self.start().status_code, 409)
        self.run_job()
        db.session.expire_all()
        room = db.session.get(Room, 1)
        self.assertEqual(room.current_media_key, 'youtube:BaW_jenozKc')
        self.assertEqual(room.current_media_title, 'A test video')
        self.assertEqual(room.current_time, 2)
        with self.http.get(room.current_media_url) as response:
            self.assertEqual(response.status_code, 200)
        self.assertEqual(self.http.get(room.current_media_url.replace('index.m3u8', 'worker.log')).status_code, 404)
        routes.room_states.clear()
        self.assertEqual(routes._get_room_state_payload(room)['url'], room.current_media_url)
        self.assertEqual(self.http.get('/api/room/1/youtube-status').json['state'], 'ready')

    def test_obsolete_download_cannot_replace_new_media(self):
        self.start()
        routes._save_room_playback_state(1, 'paused', 20, new_media=True)
        self.run_job()
        self.assertEqual(db.session.get(Room, 1).current_media_url, '/old.m3u8')
        self.assertEqual(youtube_downloads.jobs['1']['state'], 'cancelled')

    def test_failure_preserves_playback(self):
        self.start()
        with patch.object(youtube_downloads, 'execute', side_effect=RuntimeError('Download unavailable')):
            fn, args = self.tasks.pop(0)
            fn(*args)
        self.assertEqual(youtube_downloads.jobs['1']['state'], 'error')
        self.assertEqual(db.session.get(Room, 1).current_media_url, '/old.m3u8')

    def test_early_publication_requires_buffer_and_completion_keeps_pause(self):
        self.start()
        job = youtube_downloads.jobs['1']
        job.update(state='preparing', title='Progressive test', duration=400)
        directory = youtube_downloads.root(self.app) / job['id']
        directory.mkdir(parents=True)
        (directory / 'seg_000000.ts').write_bytes(b'segment')
        playlist = directory / 'index.m3u8'
        playlist.write_text('#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXTINF:13,\nseg_000000.ts\n')
        youtube_downloads.publish(self.app, job, socketio)
        self.assertFalse(job.get('published', False))  # selected offset 2 + 12-second startup buffer
        playlist.write_text('#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXTINF:14,\nseg_000000.ts\n')
        youtube_downloads.publish(self.app, job, socketio)
        self.assertTrue(job['published'])
        db.session.expire_all()
        room = db.session.get(Room, 1)
        self.assertFalse(routes._get_room_state_payload(room)['youtube']['complete'])
        with self.http.get(room.current_media_url) as response:
            self.assertEqual(response.headers['Cache-Control'], 'no-store')
            self.assertIn('TIME-OFFSET=0', response.text)
        client = socketio.test_client(self.app, flask_test_client=self.http)
        client.emit('user_seek', {'room_id': '1', 'current_time': 999,
                                 'media_version': routes.room_states['1']['media_version']})
        self.assertEqual(routes.room_states['1']['offset'], 12)
        client.disconnect()
        routes._save_room_playback_state(1, 'paused', 15)
        version = routes.room_states['1']['media_version']
        playlist.write_text(playlist.read_text() + '#EXT-X-ENDLIST\n')
        youtube_downloads.publish(self.app, job, socketio, complete=True)
        self.assertEqual(routes.room_states['1']['status'], 'paused')
        self.assertEqual(routes.room_states['1']['offset'], 15)
        self.assertEqual(routes.room_states['1']['media_version'], version)

    def test_partial_failure_pauses_only_its_own_room_media(self):
        self.start()
        job = youtube_downloads.jobs['1']
        job.update(state='preparing', title='Progressive test', duration=400)
        directory = youtube_downloads.root(self.app) / job['id']
        directory.mkdir(parents=True)
        (directory / 'seg_000000.ts').write_bytes(b'segment')
        (directory / 'index.m3u8').write_text('#EXTM3U\n#EXTINF:130,\nseg_000000.ts\n')
        youtube_downloads.publish(self.app, job, socketio)
        youtube_downloads.pause_failed_stream(self.app, job, socketio)
        self.assertEqual(routes.room_states['1']['status'], 'paused')
        room = db.session.get(Room, 1)
        room.current_media_url = '/new.m3u8'
        routes._save_room_playback_state(1, 'playing', 20, new_media=True)
        youtube_downloads.pause_failed_stream(self.app, job, socketio)
        self.assertEqual(routes.room_states['1']['status'], 'playing')

    def test_playlist_ignores_unfinished_segments(self):
        directory = Path(self.temp.name)
        (directory / 'index.m3u8').write_text('#EXTM3U\n#EXTINF:130,\nseg_000000.ts\n')
        self.assertEqual(youtube_downloads.playlist_snapshot(directory)['prepared_seconds'], 0)

    def test_real_ffmpeg_vod_is_seekable_and_does_not_touch_live_process(self):
        directory = Path(self.temp.name)
        source = directory / 'fixture.mp4'
        subprocess.run([streamer.get_ffmpeg_path(), '-hide_banner', '-loglevel', 'error',
                        '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15', '-f', 'lavfi',
                        '-i', 'sine=frequency=440', '-t', '5', '-c:v', 'libx264', '-c:a', 'aac', str(source)], check=True)
        previous = streamer.process
        subprocess.run(streamer.vod_command(source, str(directory)), check=True)
        text = (directory / 'index.m3u8').read_text()
        self.assertIn('#EXT-X-PLAYLIST-TYPE:EVENT', text)
        self.assertIn('#EXT-X-ENDLIST', text)
        self.assertGreaterEqual(len(list(directory.glob('seg_*.ts'))), 3)
        self.assertIs(streamer.process, previous)
        # A compatible source should also produce playable VOD without encoding video.
        subprocess.run(streamer.vod_command(source, str(directory), copy_video=True), check=True)
        self.assertIn('#EXT-X-ENDLIST', (directory / 'index.m3u8').read_text())


if __name__ == '__main__':
    unittest.main()
