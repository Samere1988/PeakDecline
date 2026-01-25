import os
import subprocess
import uuid
import threading
import time


class StreamService:
    def __init__(self):
        self.process = None
        self.current_channel_id = None

        current_file = os.path.abspath(__file__)
        services_dir = os.path.dirname(current_file)
        app_dir = os.path.dirname(services_dir)

        # 3. Build the path to app/static/stream
        self.stream_dir = os.path.join(app_dir, 'static', 'stream')

        # Debug print to confirm it matches what you expect
        print(f"STREAMER PATH SET TO: {self.stream_dir}")

        self._ensure_dir()

    def _ensure_dir(self):
        if not os.path.exists(self.stream_dir):
            os.makedirs(self.stream_dir)

    def _ensure_dir(self):
        if not os.path.exists(self.stream_dir):
            os.makedirs(self.stream_dir)

    def get_ffmpeg_path(self):
        known_paths = [
            r"C:\ffmpeg\bin\ffmpeg.exe",
            r"C:\Program Files\ffmpeg\bin\ffmpeg.exe"
        ]
        for p in known_paths:
            if os.path.exists(p): return p
        return "ffmpeg"

    def stop_stream(self):
        if self.process:
            try:
                self.process.terminate()
                self.process.wait(timeout=2)
            except:
                try:
                    self.process.kill()
                except:
                    pass
            self.process = None
        self.current_channel_id = None
        self._cleanup_files()

    def _cleanup_files(self):
        for f in os.listdir(self.stream_dir):
            if f.endswith(".ts") or f.endswith(".m3u8"):
                try:
                    os.remove(os.path.join(self.stream_dir, f))
                except:
                    pass

    def start_stream(self, channel_id, channel_url, channel_name):
        self.stop_stream()

        session_id = str(uuid.uuid4())[:8]
        output_path = os.path.join(self.stream_dir, "stream.m3u8")

        print(f"DEBUG: Output Path -> {output_path}")
        print(f"DEBUG: Stream URL -> {channel_url}")

        # 1. Construct the command
        ffmpeg_exe = self.get_ffmpeg_path()
        print(f"DEBUG: Using FFmpeg at -> {ffmpeg_exe}")

        cmd = [
            ffmpeg_exe,
            '-hide_banner', '-loglevel', 'info',  # Changed to 'info' for more detail
            '-i', channel_url,
            '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
            '-crf', '15', '-maxrate', '15M', '-bufsize', '30M',
            '-force_key_frames', 'expr:gte(t,n_forced*2)', '-sc_threshold', '0',
            '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-ar', '48000', '-b:a', '320k',
            '-f', 'hls', '-hls_time', '2', '-hls_list_size', '6',
            '-hls_flags', 'delete_segments',
            '-hls_segment_filename', os.path.join(self.stream_dir, f'seg_{session_id}_%03d.ts'),
            '-y', output_path
        ]

        try:
            # 2. Start Process with PIPES so we can read the error
            self.process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True  # This makes the output readable text instead of bytes
            )

            # 3. IMMEDIATE DEATH CHECK
            # Wait 0.5 seconds and see if it's already dead
            time.sleep(0.5)
            if self.process.poll() is not None:
                # IT DIED! Get the error message
                stdout, stderr = self.process.communicate()
                print("\n" + "=" * 40)
                print("CRITICAL: FFmpeg Crashed Immediately!")
                print(f"STDOUT: {stdout}")
                print(f"STDERR: {stderr}")  # <--- THIS IS THE SMOKING GUN
                print("=" * 40 + "\n")
                return False, f"FFmpeg crashed: {stderr[:100]}..."

            # 4. If it survived the first 0.5s, wait for the file
            print("FFmpeg started successfully... waiting for file.")
            for i in range(15):
                time.sleep(1)
                # Check if it died while we were waiting
                if self.process.poll() is not None:
                    _, stderr = self.process.communicate()
                    print(f"FFmpeg died during wait loop: {stderr}")
                    return False, "Stream crashed during startup"

                if os.path.exists(output_path) and os.path.getsize(output_path) > 0:
                    print(f"Stream ready after {i + 1} seconds!")
                    self.current_channel_id = channel_id
                    return True, f"Playing {channel_name}"

            self.stop_stream()
            return False, "Timed out waiting for file generation"

        except Exception as e:
            print(f"Python Error: {e}")
            return False, str(e)


# Create a singleton instance to be used by routes
streamer = StreamService()