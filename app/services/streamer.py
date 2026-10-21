import os
import subprocess
import uuid
import time
import glob
from gevent import sleep
from gevent.lock import RLock


class StreamService:
    def __init__(self):
        self.process = None
        self.current_channel_id = None
        self.current_channel_dir = None
        self.clock_playlist_path = None
        self.lock = RLock()
        self.epoch = uuid.uuid4().hex
        self.revision = 0
        self.session_id = None

        # ─── Resolve project root safely ───────────────────────────────
        current_file = os.path.abspath(__file__)
        services_dir = os.path.dirname(current_file)     # app/services
        app_dir = os.path.dirname(services_dir)          # app
        project_root = os.path.dirname(app_dir)          # PeakDecline

        # ─── STATIC STREAM ROOT ───────────────────────────────────────
        self.stream_root = os.path.join(project_root, "static", "stream")
        os.makedirs(self.stream_root, exist_ok=True)

        print(f"[STREAM] Root: {self.stream_root}")

    # ────────────────────────────────────────────────────────────────

    def get_ffmpeg_path(self):
        for p in (
            r"C:\ffmpeg\bin\ffmpeg.exe",
            r"C:\Program Files\ffmpeg\bin\ffmpeg.exe",
        ):
            if os.path.exists(p):
                return p
        return "ffmpeg"

    def vod_command(self, source, directory, copy_video=False):
        """Build seekable room HLS without touching the singleton Live TV process."""
        video_options = ['-c:v', 'copy'] if copy_video else [
            '-vf', "scale=w='min(1920,iw)':h=-2",
            '-c:v', 'libx264', '-preset', 'faster', '-crf', '21',
            '-pix_fmt', 'yuv420p', '-force_key_frames', 'expr:gte(t,n_forced*2)',
            '-sc_threshold', '0']
        return [
            self.get_ffmpeg_path(), '-hide_banner', '-loglevel', 'error',
            '-nostdin', '-progress', os.path.join(directory, 'progress.txt'), '-nostats',
            '-i', str(source), '-map', '0:v:0', '-map', '0:a:0?',
            *video_options, '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
            '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0',
            '-hls_playlist_type', 'event', '-hls_flags', 'independent_segments+temp_file',
            '-hls_segment_filename', os.path.join(directory, 'seg_%06d.ts'),
            '-y', os.path.join(directory, 'index.m3u8')
        ]

    # ────────────────────────────────────────────────────────────────

    def stop_stream(self):
        with self.lock:
            return self._stop_stream()

    def _stop_stream(self):
        if self.process:
            try:
                self.process.terminate()
                self._wait_for_exit(self.process, 3)
            except Exception:
                try:
                    self.process.kill()
                    self._wait_for_exit(self.process, 3)
                except Exception:
                    pass

        self.process = None
        self._cleanup_channel()
        self.current_channel_id = None
        self.current_channel_dir = None
        self.clock_playlist_path = None
        self.session_id = None

    @staticmethod
    def _wait_for_exit(process, seconds):
        deadline = time.monotonic() + seconds
        while process.poll() is None:
            if time.monotonic() >= deadline:
                raise subprocess.TimeoutExpired('ffmpeg', seconds)
            sleep(0.05)

    # ────────────────────────────────────────────────────────────────

    def _cleanup_channel(self):
        if not self.current_channel_dir:
            return

        try:
            for f in glob.glob(os.path.join(self.current_channel_dir, "**", "*.ts"), recursive=True):
                if f.endswith(".ts") or f.endswith(".m3u8"):
                    os.remove(f)
            for f in glob.glob(os.path.join(self.current_channel_dir, "**", "*.m3u8"), recursive=True):
                os.remove(f)
        except Exception as e:
            print(f"[STREAM] Cleanup warning: {e}")

    # ────────────────────────────────────────────────────────────────

    def start_stream(self, channel_id, channel_url, channel_name):
        with self.lock:
            self.revision += 1
            try:
                return self._start_stream(channel_id, channel_url, channel_name)
            finally:
                self.revision += 1

    def _start_stream(self, channel_id, channel_url, channel_name):
        self.stop_stream()

        session_id = str(uuid.uuid4())[:8]

        # ─── Per-channel directory ────────────────────────────────────
        channel_dir = os.path.join(self.stream_root, str(channel_id))
        os.makedirs(channel_dir, exist_ok=True)
        self.current_channel_dir = channel_dir

        playlist_path = os.path.join(channel_dir, "index.m3u8")
        native_playlist_path = os.path.join(channel_dir, "0", "index.m3u8")

        print(f"[STREAM] Channel {channel_id}: {channel_name}")
        print(f"[STREAM] URL: {channel_url}")

        ffmpeg = self.get_ffmpeg_path()

        cmd = [
            ffmpeg,
            "-hide_banner",
            "-loglevel", "info",
            "-user_agent", "VLC/3.0.20 LibVLC/3.0.20",
            "-i", channel_url,

            # Split once, then encode three synchronized video renditions.
            # The first keeps source dimensions; the others cap width at 720p
            # and 480p while preserving the source aspect ratio.
            "-filter_complex",
            "[0:v]split=3[vnative][v720src][v480src];"
            "[v720src]scale=w='min(1280,iw)':h=-2[v720];"
            "[v480src]scale=w='min(854,iw)':h=-2[v480]",
            "-map", "[vnative]", "-map", "0:a:0?",
            "-map", "[v720]", "-map", "0:a:0?",
            "-map", "[v480]", "-map", "0:a:0?",
            # Keep the native rendition on libx264's prior CRF-based behavior;
            # the quality ladder should not make the default picture softer.
            "-c:v:0", "libx264", "-preset:v:0", "faster", "-tune:v:0", "zerolatency",
            "-c:v:1", "libx264", "-preset:v:1", "superfast", "-tune:v:1", "zerolatency",
            "-b:v:1", "1.8M", "-maxrate:v:1", "2.2M", "-bufsize:v:1", "4M",
            "-c:v:2", "libx264", "-preset:v:2", "superfast", "-tune:v:2", "zerolatency",
            "-b:v:2", "650k", "-maxrate:v:2", "800k", "-bufsize:v:2", "1.3M",
            "-pix_fmt", "yuv420p",
            "-profile:v", "baseline",
            "-g", "90",
            "-force_key_frames", "expr:gte(t,n_forced*2)",
            "-sc_threshold", "0",
            "-c:a:0", "aac", "-ar:a:0", "48000", "-b:a:0", "192k",
            "-c:a:1", "aac", "-ar:a:1", "48000", "-b:a:1", "96k",
            "-c:a:2", "aac", "-ar:a:2", "48000", "-b:a:2", "64k",

            # ─── HLS ──────────────────────────────────────────────────
            "-f", "hls",
            # Forced keyframes keep segment boundaries at two seconds across
            # input frame rates. PDT maps them onto the shared server target.
            "-hls_time", "2",
            "-hls_list_size", "8",
            "-hls_flags", "delete_segments+independent_segments+program_date_time",
            "-hls_allow_cache", "0",
            "-master_pl_name", "index.m3u8",
            "-var_stream_map", "v:0,a:0 v:1,a:1 v:2,a:2",
            "-hls_segment_filename", os.path.join(channel_dir, "%v", f"seg_{session_id}_%03d.ts"),

            "-y", os.path.join(channel_dir, "%v", "index.m3u8")
        ]

        try:
            # 🔥 CRITICAL FIX: DO NOT PIPE STDERR
            log_path = os.path.join(channel_dir, "ffmpeg_error.log")

            with open(log_path, "w", encoding="utf-8", errors="replace") as log_file:
                self.process = subprocess.Popen(cmd, stdout=log_file, stderr=log_file)
            # ─── Wait for playlist ─────────────────────────────────────
            for i in range(20):
                sleep(0.5)

                if self.process.poll() is not None:
                    self.stop_stream()
                    return False, "FFmpeg exited during startup"

                if (os.path.exists(playlist_path) and os.path.getsize(playlist_path) > 0
                        and os.path.exists(native_playlist_path)):
                    # Capture zero while the very first chunks still exist.
                    # Later viewers retain this origin after the playlist slides.
                    from .live_clock import live_clock
                    try:
                        live_clock.snapshot(native_playlist_path, channel_id)
                    except (OSError, ValueError):
                        continue
                    self.current_channel_id = channel_id
                    self.session_id = session_id
                    self.clock_playlist_path = native_playlist_path
                    print(f"[STREAM] Ready in {i * 0.5:.1f}s")
                    return True, f"Playing {channel_name}"

            self.stop_stream()
            return False, "Timed out waiting for stream"

        except Exception as e:
            self.stop_stream()
            return False, str(e)


# ─── Singleton ────────────────────────────────────────────────────────
streamer = StreamService()
