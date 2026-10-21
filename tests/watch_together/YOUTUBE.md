# Local YouTube playback

In Select Media, paste a YouTube watch, share, Shorts, or live-recording link and
choose **Download & Play**. Optional `t` / `start` timestamps are supported.
The existing video continues while the server downloads and prepares the new one.
The download completes first. The room then switches automatically once 120
seconds beyond the selected start time are packaged; shorter videos start when
complete. FFmpeg continues preparing the rest while everyone watches.
Host play/pause/seek and viewer sync use the existing Watch Together player.

Install with the same Python environment that runs the app:

```powershell
.venv/Scripts/python.exe -m pip install -r requirements-youtube.txt
```

The worker uses the project's `.venv` Python even if the app runs under global
Python. `YOUTUBE_PYTHON` (app configuration or environment) overrides this choice.
FFmpeg uses the existing Live TV path resolver. Node is resolved from the server
PATH, the Windows Node installation, or the bundled Codex runtime; `YOUTUBE_NODE`
can specify an explicit executable for YouTube JavaScript challenges.
Restart the app after installing or changing worker configuration.
There is no iframe, YouTube API key, or per-viewer YouTube connection.

The worker prefers H.264 downloads up to 1080p and copies compatible video
directly into HLS, converting audio to AAC. Other video codecs fall back to
H.264 conversion using the stream service's VOD command. All viewers fetch the same files through authenticated
routes. Live TV's process and sliding playlist are independent. YouTube uses a
growing HLS EVENT playlist that retains every prepared segment and gains an
ENDLIST marker when complete. Segment and playlist writes are atomic. Playlist
responses are never cached. Seeking is limited to the prepared portion in both
the player and server. Host buffering uses the existing shared pause/recovery
system if playback reaches the prepared edge.

`YOUTUBE_START_BUFFER_SECONDS` in Flask configuration controls the startup buffer
(default 120 seconds, bounded to 10–180). Completion does not reset playback or
override a host pause. An encoder failure after publication pauses that stream's
room and reports the failure; changing media before publication cancels the job.

Progress bars in the picker and room show the current stage, percentage, elapsed
time, and estimated time remaining when available. Download progress describes
the current video/audio file; preparation progress covers the entire video.
Unknown totals use an indeterminate bar. Two minutes without progress shows a
warning; preparation fails after five minutes without advancing.

Files and diagnostic worker logs live in `instance/youtube/<job-id>/` and are
ignored by Git. Unreferenced directories older than 24 hours are removed when
another download starts. Files referenced by a room are retained, including
after a server restart. Downloads in progress do not resume after a restart;
submit the link again. Use one application process, consistent with the existing
room state and Live TV services.

Resource limits: two simultaneous jobs, one per room, six GB of initial free
space, four hours duration, two GB per downloaded file, four GB total working
files, and a one-hour timeout for each download/conversion step. Current live
broadcasts are excluded. Restricted/unavailable videos fail with a visible
message, leaving existing playback intact. Host or media changes during a job
prevent it from replacing the newer selection.

Verification:

```powershell
.venv/Scripts/python.exe tests/watch_together/youtube_test.py
node tests/watch_together/stress.cjs
```

The Python tests use in-memory databases, simulated downloads, and a real FFmpeg
fixture. They cover URL validation, host authorization, duplicate jobs, failures,
stale completion, reconnect persistence, file serving, and complete VOD output.

On September 10, 2026, a real public YouTube clip was downloaded and converted
locally. `youtube_browser.cjs` verified that fixture in Edge: actual HLS decoding,
play/pause, host timeline availability, hidden Plex settings, and the media
picker at phone and desktop widths. It expects a prepared HLS fixture under
`.tmp/youtube-smoke/` and the existing browser-suite dependencies.

The progress update passed 10 worker tests, 23 synchronization checks, and browser
checks for percentage/ETA, progress outside the picker, stall warnings, and error
recovery at phone/desktop widths. The reported 17-minute video completed the
original full conversion in roughly 3 minutes 38 seconds on this server. The
compatible-video path prepared the same video in 49.5 seconds. With progressive
publication it became playable after 6.6 seconds of preparation, with 130.1
seconds ready while FFmpeg continued. Browser checks cover growing playlists,
paused alignment during growth, and playback past the initial prepared edge.
The 13 worker tests cover the publication threshold, server seek limit, partial
failure, and preserving host state when preparation finishes.

A daily Codex release check compares the yt-dlp pin/installed version with stable
PyPI and GitHub releases and reports actionable changes. It does not upgrade the
running application. Validate updates using this suite and a real download smoke
test before updating `requirements-youtube.txt` and the project environment.
