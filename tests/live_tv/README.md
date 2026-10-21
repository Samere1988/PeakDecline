# Live TV shared-clock synchronization

Status behavior and coverage: [STATUS_VERIFICATION.md](STATUS_VERIFICATION.md).
Run `status_integration.cjs` for actual network/media status transitions and
`quality_status_test.cjs` for quality-menu feedback and callback races.

Good-connection native 1080p test (15 viewers, 10 at startup and five late joins,
three pauses/resumes, two refreshes, two leave/rejoins and Go Live):

```powershell
$env:LIVE_TEST_PORT='18779'
$env:LIVE_TEST_VIDEO='1920x1080'
$env:LIVE_TEST_NATIVE_ONLY='1'
$env:LIVE_TEST_GOOD_CONNECTIONS='1'
$env:LIVE_TEST_STARTUP_ONLY='0'
node tests/live_tv/synchronized.cjs
```

This profile uses 40–100 Mbps per browser with 10–80 ms latency, checks decoded
1080p with adaptive quality disabled, and saves `native-good-connections-results.json`.
It uses local HTTP/HLS and real WebSockets with a generated source; all clients
share one host. The browser autoplay override isolates playback synchronization
from browser permission policy. This is not an external-network capacity test.

Channel status regression: `node tests/live_tv/status_test.cjs` covers switching,
loading, slow startup, actual playback success, buffering, pause, autoplay prompts,
fatal recovery, stale timers and failed channel requests. These presentation checks
do not replace the 15-viewer integration suite or native device coverage.

`node tests/live_tv/status_browser.cjs` checks 20 status messages at eight
desktop, tablet and phone viewport sizes using the actual template and styles.
It also plays a generated canvas video in Chromium to verify that losing the
sync clock does not label continuing playback as reconnecting. Viewport checks
are not native Safari, iPhone or Android device testing.

`node tests/live_tv/quality_integration.cjs` starts the production test server,
loads the real HLS master playlist in Edge, and switches through Native, 720p,
480p, and Auto. It uses a 1080p synthetic source and verifies decoded video
dimensions of 1080p, 720p, and 480p, so the check covers actual rendition changes
over HTTP/WebSocket playback rather than only checking the select element.

`node tests/live_tv/autoplay_integration.cjs` verifies automatic playback,
browser sound-policy fallback, speaker activation, and an unmuted user-initiated
channel switch over the actual test server.

The browser check also exercises the live-only controls (play/pause, Go Live,
mute, volume and fullscreen), verifies there is no seek slider, checks controls
fit phone widths, and compares button appearance with Watch Together. Both pages
load `static/css/player_controls.css`; their playback synchronization remains
specific to live shared time or the Watch Together host.

Live TV now publishes one HLS master playlist with three renditions from one
FFmpeg process: native resolution by default, 720p, and 480p. The Watch Together
style cog exposes Native, 720p, 480p, and Auto (adaptive); all variants use the
same two-second boundaries and program-date timeline. The native HLS fallback
keeps Auto when manual level selection is unavailable in the browser.

The current implementation uses one server target, expressed in HLS program
time. Raw browser `currentTime` and each browser's playlist edge are not a
shared reference: late joins can use different media origins and lagged playlists.

`/api/live-clock/<channel_id>` reads the encoder's dated segments. A monotonic
server anchor advances smoothly between publications, approximately six seconds
behind publication. It never targets unpublished media. Clients compensate for
half the clock request round-trip and map the target through HLS program dates.
Clock samples expire after three seconds; stalled encoder snapshots are marked
stale after eight seconds. Missing/stale clocks disable correction and display
the clock status rather than driving a player using an invented target.
When publication resumes after a stall, the clock re-anchors to restore its
six-second safety buffer. Parsed playlists are cached by file metadata so
viewers share parsing work without sharing stale target timestamps.

Playback policy:

- Check alignment every 250 ms; poll the server clock about once per second.
- Use 0.98x/1.02x for small drift and return to 1x within 350 ms.
- Gecko Firefox stays at 1x to avoid repeated audio time-stretching while
  investigating Firefox-only A/V drift. Buffered catch-up and explicit Sync
  still work; small offsets may persist until alignment. Other browsers,
  including WebKit-based Firefox on iOS, retain rate correction. The unit suite
  simulates one hour of Firefox clock jitter; it does not validate real audio
  output or establish that rate correction caused the reported drift.
- Normal playback never automatically rewinds. Skip forward only when more than
  four seconds behind for three continuous seconds with a buffered, seekable
  destination and ready media; automatic seeks have a fifteen-second cooldown.
- Local pause remains paused. Resume and explicit Sync request alignment;
  returning from the background only refreshes the clock. Reconnect rejoins
  presence and checks the current channel.
- Startup retries are scoped to the current player generation. An autoplay
  rejection displays an explicit Play instruction.
- HLS startup waits for media at the shared target to be buffered before Play.

FFmpeg forces keyframes every two seconds and emits program date timestamps.
HLS.js is pinned to 1.6.13 for this page. This reduces uncertainty from segment
lengths and from changing library defaults. There is still one stream rendition:
connections slower than that rendition must buffer until bandwidth improves.

## Reproduce

```powershell
.venv/Scripts/python.exe tests/live_tv/clock_test.py
node tests/live_tv/player_test.cjs
node tests/live_tv/lifecycle_test.cjs
node tests/live_tv/text_safety.cjs
node tests/live_tv/synchronized.cjs
```

The browser runner uses the actual Flask Live TV page, authenticated temporary
users/databases, real WebSockets, the production clock endpoint, and the
production FFmpeg command with generated 25 fps video/audio as input. It routes
only the generated media and test identities to isolated resources. No Plex,
production channels, or production databases are used. The server binds only
to loopback and cleanup stops its dedicated encoder and removes its temporary
files. Test helpers must never be registered in the production app.

The integration suite now calls the actual production channel-start route and
StreamService lifecycle, substituting only the FFmpeg input. It covers channel
switches, failed starts, retry, and fatal loader errors during local pause.
Heartbeat latency is measured during real startup, and the requesting player
must initialize exactly once for the broadcast/HTTP response pair. Separate
lifecycle regressions cover delayed status responses and stale revisions.
The text-safety test uses a real browser but invokes local handlers only; it
does not send chat messages to any other users.

Channel state includes a process epoch, revision, and stream session. Startup
and shutdown use cooperative waits under a lock; active database flags are
committed only after startup succeeds. Status also checks the encoder process.
Channel search filters cached data locally, and Live TV loads one pinned HLS
library. Chat, usernames, and channel metadata are rendered without HTML
interpolation.

Prerequisites: the project's Python virtual environment, FFmpeg, Playwright,
Edge/Chromium, and the pinned HLS.js and Socket.IO fixtures described in
`../watch_together/README.md`. `WATCH_PLAYWRIGHT`, `WATCH_BROWSER`, and
`LIVE_TEST_PORT` can override the local runner defaults.

Ten users arrive before the stream starts; five join during playback. Network
profiles range from 1–8 Mbps and 20–250 ms latency, installed before navigation.
Three users then drop to 100 kbps (below even the 192 kbps audio track), then
recover to 4 Mbps. The suite also pauses for 12 seconds, resumes, refreshes,
leaves/rejoins, injects drift, and disconnects/reconnects a viewer's network.

Every observation interval samples once per second, including startup, churn,
and recovery intervals. Measurements use HLS.js `playingDate`, independently
of the player's mapping function, and one server target. The report retains
media events, ready state, paused state, frames, playback rate, missing values,
and measurement duration. No paused/stalled viewer is silently discarded.

Acceptance after explicit recovery windows: all expected viewers must advance
decoded frames, have program timestamps, remain within two seconds of each
other and 1.5 seconds of the server target, and have no more than 10% stalled
samples. During below-bitrate delivery only the 12 unaffected peers must meet
that bound; the three constrained clients remain recorded and all 15 must meet
it after bandwidth returns. See `synchronized-results.json` for source hashes,
all samples, failures, and final results. A sampled stall fraction is not a
precise continuous buffering-duration measurement.

Initial startup has a 30-second allowance after the last late join; all its
samples remain in the report. Near-capacity profiles needed around 20 seconds
to begin aligned playback in development runs. The two-second bound is an
ongoing playback acceptance criterion, not a promise of instant startup.

`live.cjs` now runs the same suite as `synchronized.cjs`. `live-results.json` is
the historical preliminary report. That run used minimal markup, mocked sockets,
and per-client edge latency; it cannot verify the new endpoint.

## Deployment and limits

These changes are local until explicitly deployed. Deploy the backend, player,
and template together. Restart the app and active encoder so timestamps and
forced keyframes are emitted; reload room pages to use the new player.

The test measures program-time agreement, not original broadcaster-to-screen
latency, geographic uplink capacity, high-resolution encoder capacity, or
physical Safari/mobile behavior. Native HLS can map through `getStartDate`
when supported; physical-device coverage is still required. A stale/missing
mapping is reported rather than treating local seekable ranges as synchronized.
