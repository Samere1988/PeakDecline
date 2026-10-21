# Watch Together review and stress tests

These tests exercise the repaired production player and server handlers. The
server bridge creates 15 authenticated users in **in-memory SQLite databases**.
The deterministic/browser suites do not connect to Plex. The separate end-to-end
suite uses real Plex with temporary databases and dedicated test transcodes.
See [VERIFICATION.md](VERIFICATION.md) for current results; [REVIEW.md](REVIEW.md)
is the historical pre-repair review.
Platform coverage and the host-pause alignment update are documented in
[PLATFORM_TESTS.md](PLATFORM_TESTS.md). `platforms.cjs` runs explicitly labeled
Windows engine/device-profile tests; it cannot certify physical Safari or Android.

## Run

From the repository root:

```powershell
node tests/watch_together/stress.cjs
```

The deterministic suite uses Node's built-in VM and the project's Python virtual
environment. Set `WATCH_TEST_PYTHON` to another Python executable if needed. Python
requires the same Flask, Flask-SocketIO, SQLAlchemy, Flask-Login, Flask-Mail,
requests and PlexAPI packages as the application.

An exit code of **0 means all required assertions passed**; 1 indicates failures.
Assertions express desired behavior, rather than declaring known defects a pass.
`results.json` contains each assertion and its observed result. A `harnessError`
field means a test infrastructure error, not a reproduced product defect.

For real browser playback, prepare local synthetic HLS and a pinned HLS.js build:

```powershell
New-Item -ItemType Directory -Force tests/watch_together/fixtures
Invoke-WebRequest https://cdn.jsdelivr.net/npm/hls.js@1.6.13/dist/hls.min.js -OutFile tests/watch_together/fixtures/hls.min.js
ffmpeg -hide_banner -loglevel error -f lavfi -i "testsrc2=size=320x180:rate=15" -f lavfi -i "sine=frequency=440:sample_rate=44100" -t 90 -c:v libx264 -preset ultrafast -b:v 200k -g 30 -c:a aac -b:a 32k -f hls -hls_time 2 -hls_list_size 0 -hls_segment_filename tests/watch_together/fixtures/seg%03d.ts tests/watch_together/fixtures/test.m3u8
node tests/watch_together/browser.cjs
```

Use the full path to ffmpeg if it is not on PATH (this machine uses
`C:\ffmpeg\bin\ffmpeg.exe`). `WATCH_PLAYWRIGHT` and `WATCH_BROWSER` override the
locally available Playwright module and Edge executable paths in the runner.
The server binds to an ephemeral port on `127.0.0.1`. Generated media/library
fixtures are ignored by Git. Browser outcomes and event traces are saved to
`browser-results.json`.

## Coverage and interpretation

**Deterministic integration suite:** 15 separate JS contexts execute the full,
current `static/js/room_player.js`, with simulated DOM, media events, clocks,
network delivery delays, and buffering. Outgoing commands invoke the real
`app/routes.py` handlers through authenticated Flask-SocketIO test clients.

- 602 simulated seconds with 15 total concurrent users after five late joins.
- Delivery latency from 20 to 1,800 ms; startup delays from 100 to 10,000 ms.
- Seven refreshes, five leave/rejoin cycles, four host pause/resume cycles.
- Host refresh and departure; grace tasks explicitly advanced by the harness.
- Slow initial loads with intervening play/pause, both HLS.js and native-HLS paths.
- Buffer starvation, reconnect after a missed play, browser play rejection,
  clock skew, 70 viewer attempts to control room playback, and invalid position.
- Obsolete loading callbacks, stale revisions/media commands, preservation of
  intentional local pause, and readiness arriving before buffering acknowledgement.

**Browser suite:** 15 independent Edge browser contexts execute the same production
JavaScript with actual HLS.js and decode a generated 90-second video with audio.
CDP limits media bandwidth to 150, 500, 1,000–1,500, 3,000–4,000, or 8,000 kbps
and applies 20–900 ms latency. Ten users start together and five join late; one
refreshes and one leaves/rejoins; the host uses the actual play/pause button.
Final checks measure paused state, drift, readyState, and decoded-frame progress.
The 150 kbps profiles intentionally have insufficient bandwidth for the fixture.
They test degraded behavior, not an expectation that bandwidth can be overcome.
The same CDP sessions then restore adequate bandwidth; all 15 clients must resume
decoding and converge within three seconds. The below-bitrate phase separately
requires that nominal viewers remain healthy.

Two additional browser tests delay the HLS manifest by six seconds across host
play/pause changes. Browser autoplay denial is checked separately; a `pass: null`
result means the installed browser permitted autoplay and denial was not reproduced.

## Real WebSocket and Plex test

Prepare the same fixtures, plus the actual Socket.IO client used by the site:

```powershell
Invoke-WebRequest https://cdn.socket.io/4.6.0/socket.io.min.js -OutFile tests/watch_together/fixtures/socket.io.min.js
node tests/watch_together/realtime.cjs
```

This runner starts a loopback-only gevent app on port 18765 (override with
`WATCH_TEST_PORT`), with temporary SQLite databases and 15 authenticated test
users. It renders the actual room template and forces real Socket.IO WebSocket
transport. The current Plex URL/token are read from the app configuration without
instantiating the production app; `WATCH_PLEX_URL` / `WATCH_PLEX_TOKEN` override
them. Tokens are not written to results or passed to browser fixtures.

It chooses one movie and one episode, performs Plex's transcode decision request,
and runs dedicated H.264/AAC HLS sessions at a requested 1 Mbps. It tests 15
consumers of the room's shared stream, not 15 independent simultaneous transcodes.
Network profiles span 2–12 Mbps and 20–500 ms media latency. Cases include late
joins, viewer/host refresh, socket disconnect across host pause/play, leaving and
rejoining, and switching to a different media generation.

The loopback `/plex-transcode` proxy emulates the site's external proxy prefix.
Its upstream I/O runs in a worker pool so it cannot block the gevent Socket.IO
loop. This does not validate the deployed proxy configuration. Progress/history
reporting is disabled in the current test app; existing production users and rooms
are not changed. See `VERIFICATION.md` for an earlier test-iteration resume-position
side effect. Cleanup stops only dedicated test session IDs and disposes the
temporary databases. `realtime-results.json` records outcomes, transport, decoded
frames, drift, transcode decisions and aggregate media bytes. Run browser suites
sequentially when comparing measurements on this single machine.

## Limits

- These are local integration tests, not 15 people on separate physical networks.
- The deterministic/browser suites use a Socket.IO test bridge and a small DOM
  fixture. The end-to-end suite uses real WebSockets, real Plex media and the full
  room template, with isolated authentication.
- The actual internet uplink, deployed reverse proxy, geographically distributed
  clients, mobile/Safari decoding and OS background-tab behavior remain untested.
- The native-HLS branch is tested with simulated events, not Safari.
- The 10-minute soak is virtual time; the real-browser exercise is much shorter.
- Passing the nominal soak does not mean race cases or stalls are healthy.

See `results.json`, `browser-results.json`, and `realtime-results.json` for evidence.
Each records the tested player source SHA-256.
