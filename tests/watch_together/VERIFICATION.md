# Watch Together repair verification

## Changes

Findings 1–5 are repaired together in `static/js/room_player.js` and `app/routes.py`.

The follow-up host-pause behavior now aligns all clients to the frozen host time
during downtime, retries ignored/deferred seeks, and requests preloading while
paused. See [PLATFORM_TESTS.md](PLATFORM_TESTS.md) for the platform coverage and
explicit native-device limitations.

- Server snapshots and control broadcasts include a process epoch, increasing
  room revision, media generation and separate playing/buffering intent.
- The player rejects stale revisions and obsolete media commands. Loading
  callbacks and play promises are scoped to their media generation and reconcile
  against current intent, including both HLS.js and native-HLS metadata paths.
- Host commands come from explicit controls, not asynchronous native play/pause
  events. Intentional viewer pause is tracked separately from host-induced pause.
- Buffer recovery requires the matching episode and revision, and waits for the
  server's buffering acknowledgement. An intentional pause invalidates recovery.
- The host is the playback source; it no longer chases an extrapolated timestamp.
  Viewers do not seek while stalled/seeking and limit unbuffered catch-up attempts.
- Reconnect applies current authoritative state, resumes host-induced pauses,
  preserves deliberate local pause and requests fresh state on host transfer.

Related resilience improvements include a monotonic local playback clock anchored
to server-reported positions, explicit autoplay interaction guidance, and finite
nonnegative socket-position validation. No database schema migration is needed.

## Evidence

Final run, September 8, 2026:

| Suite/check | Outcome |
| --- | --- |
| Deterministic regressions | **23/23 passed** |
| Edge/HLS browser regressions | **4/4 passed**, one autoplay-policy probe unverified |
| Real WebSocket/Plex end-to-end checks | **8/8 passed** |
| 15-client paused maximum sampled drift | **0.0008 s**, all remained paused |
| 15-client movie maximum sampled drift | **2.46 s** |
| After refresh/disconnect/rejoin | **1.24 s** |
| After switching to an episode | **0.79 s** |
| Plex delivery during the run | **898 segments, 760,651,160 bytes**, zero proxy errors |
| History reporting isolation | **14 reports blocked** |
| Dedicated test transcode cleanup | **2 stopped, 0 remaining** |

Both Plex sessions reported video transcoding, not just direct play. All 15 clients
reported the actual WebSocket transport and decoded-frame advancement at the
checked playback points. JavaScript/Python syntax checks and `git diff --check`
also passed.

The final machine-readable outcomes are in:

- [Deterministic regression results](results.json)
- [Real Edge/HLS regression results](browser-results.json)
- [Real WebSocket/Plex results](realtime-results.json)
- [Supplemental engine/device-profile results](platform-results.json)

Each contains the tested player SHA-256. The deterministic suite exercises 23
assertions, including a 602-second virtual soak. The browser suite tests actual
decoding, insufficient bandwidth followed by recovery, and delayed startup across
host play/pause. The end-to-end suite uses 15 authenticated Edge contexts, actual
WebSocket-only connections, the full room template, and actual Plex movie/episode
transcodes. It checks decoded-frame progress as well as timestamps.

The deliberately below-bitrate clients are expected to buffer; success requires
healthy peers to continue and all clients to recover once bandwidth returns.
Headless Edge allowed autoplay in the policy probe, so that result is explicitly
unverified rather than counted as an autoplay-block pass. Simulated
`NotAllowedError` handling passes.

The Plex test runs locally with 15 consumers of a shared room stream. Movie and
episode transcodes overlap briefly until cleanup, which stops only those test
sessions. Passing it supports this tested setup; it is **not a claim about the
internet uplink, deployed proxy, 15 independent transcodes, or mobile devices**.

## Deployment

These results were collected in the workspace before deployment; they do not
establish the running production version.
Deploy the backend and player together, restart the application, and reload open
room pages so both sides use the revisioned protocol. Existing CSS/database
changes present before this task were left alone.

The test app's unauthenticated `/test/*` helpers exist only in the separate,
loopback-bound test server. They must not be added to the production application.

## Physical-device checks still required

Windows Edge and simulated native-HLS events cannot establish Safari/iOS or
Android behavior. Use a staging deployment of both changed files and record the
device model, OS, browser version, connection and observed outcome below.

| Device/browser | Status |
| --- | --- |
| macOS Safari, native HLS | Pending physical device |
| iPhone/iPad Safari, native HLS and autoplay | Pending physical device |
| Android Chrome, autoplay and background recovery | Pending physical device |

1. Join while the host is playing using a fresh browser session. Playback should
   start or show **Click Play to join**; one gesture should join the current room
   position. It must not remain silently paused.
2. Throttle or use a slow connection, join, and have the host pause before the
   movie loads. The device must stay paused when loading finishes. Repeat with a
   paused room that the host starts during loading.
3. Refresh, leave/rejoin, and disconnect the network while the host pauses and
   resumes. After reconnect, follow current host state. A deliberate local pause
   should remain local until Play or Sync to Host is pressed.
4. Lock the screen or background the browser for 30 seconds; return while the
   host is playing and while paused. Check state, decoded playback, audio and sync.
5. Restore adequate bandwidth after buffering. Playback should recover without
   repeated pause/play changes or continuously seeking through unavailable video.
6. Change episodes and check that an old load never starts the previous item.

No native Safari or mobile-device pass is claimed until these results are supplied.

## Earlier integration-test side effect

The first iterations of the Plex test used `/progress` instead of the actual
`/plex-progress` endpoint in the history-isolation filter. Those runs may have
updated the resume positions of the two selected movie/episode test titles.
They did not intentionally mark either completed. Original resume positions were
not captured, so no speculative restoration was performed. The corrected test
blocks `/plex-progress` and asserts that the blocked-report count is positive.
The final run uses that corrected isolation; this does not erase the earlier side
effect.
