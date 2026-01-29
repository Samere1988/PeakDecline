import os
import subprocess
import uuid
import time
import glob


class StreamService:
    def __init__(self):
        self.process = None
        self.current_channel_id = None
        self.current_channel_dir = None

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

    # ────────────────────────────────────────────────────────────────

    def stop_stream(self):
        if self.process:
            try:
                self.process.terminate()
                self.process.wait(timeout=3)
            except Exception:
                try:
                    self.process.kill()
                except Exception:
                    pass

        self.process = None
        self._cleanup_channel()
        self.current_channel_id = None
        self.current_channel_dir = None

    # ────────────────────────────────────────────────────────────────

    def _cleanup_channel(self):
        if not self.current_channel_dir:
            return

        try:
            for f in glob.glob(os.path.join(self.current_channel_dir, "*")):
                if f.endswith(".ts") or f.endswith(".m3u8"):
                    os.remove(f)
        except Exception as e:
            print(f"[STREAM] Cleanup warning: {e}")

    # ────────────────────────────────────────────────────────────────

    def start_stream(self, channel_id, channel_url, channel_name):
        self.stop_stream()

        session_id = str(uuid.uuid4())[:8]

        # ─── Per-channel directory ────────────────────────────────────
        channel_dir = os.path.join(self.stream_root, str(channel_id))
        os.makedirs(channel_dir, exist_ok=True)
        self.current_channel_dir = channel_dir

        playlist_path = os.path.join(channel_dir, "index.m3u8")
        segment_pattern = os.path.join(channel_dir, f"seg_{session_id}_%03d.ts")

        print(f"[STREAM] Channel {channel_id}: {channel_name}")
        print(f"[STREAM] URL: {channel_url}")

        ffmpeg = self.get_ffmpeg_path()

        cmd = [
            ffmpeg,
            "-hide_banner",
            "-loglevel", "warning",
            "-i", channel_url,

            # ─── VIDEO ────────────────────────────────────────────────
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-tune", "zerolatency",
            "-pix_fmt", "yuv420p",
            "-profile:v", "baseline",
            "-level", "3.0",
            "-g", "60",
            "-keyint_min", "60",
            "-sc_threshold", "0",

            # ─── AUDIO ────────────────────────────────────────────────
            "-c:a", "aac",
            "-ar", "48000",
            "-b:a", "192k",

            # ─── HLS ──────────────────────────────────────────────────
            "-f", "hls",
            "-hls_time", "2",
            "-hls_list_size", "12",
            "-hls_flags", "delete_segments+append_list",
            "-hls_allow_cache", "0",
            "-hls_segment_filename", segment_pattern,

            "-y", playlist_path
        ]

        try:
            # 🔥 CRITICAL FIX: DO NOT PIPE STDERR
            self.process = subprocess.Popen(
                cmd,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL
            )

            # ─── Wait for playlist ─────────────────────────────────────
            for i in range(20):
                time.sleep(0.5)

                if self.process.poll() is not None:
                    self.stop_stream()
                    return False, "FFmpeg exited during startup"

                if os.path.exists(playlist_path) and os.path.getsize(playlist_path) > 0:
                    self.current_channel_id = channel_id
                    print(f"[STREAM] Ready in {i * 0.5:.1f}s")
                    return True, f"Playing {channel_name}"

            self.stop_stream()
            return False, "Timed out waiting for stream"

        except Exception as e:
            self.stop_stream()
            return False, str(e)


# ─── Singleton ────────────────────────────────────────────────────────
streamer = StreamService()
