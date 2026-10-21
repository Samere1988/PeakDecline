# Live TV status verification

The status review found and repaired these problems:

- Quality selections could replace Paused with Buffering, or stay stuck on a
  loading warning when no new `playing` event occurred. Quality progress now
  appears in the quality menu, and completed selection uses the playing HLS level.
- Muted autoplay feedback was overwritten by clock updates. It now remains
  until sound is enabled; the notice does not hide actual buffering or failures.
- Old muted-play promises could change the new channel's status. Both outcomes
  now check the channel generation. Canceled play requests do not show a false
  autoplay warning.
- Status timers now validate a message version as well as the channel, preventing
  an older timer from overwriting a replacement message in the same phase.
- Failed initial status requests and an ended stream now have actionable messages.
- Buffering says it is waiting for video instead of promising to resume shortly.
- Browsers without manual HLS level control show Auto as selected, matching the
  explanatory note and disabled manual quality options.

## Tests

`node tests/live_tv/status_integration.cjs`: **12/12 passed** against a temporary
local Flask server, real FFmpeg 1080p HLS, and browser playback. The test operates
visible controls, delays the playlist, denies clock requests, holds segment
downloads, and tries an unavailable channel. Fatal loader recovery is an
explicitly injected HLS error. The full observed message trace is saved in
`status-integration-results.json`.

`node tests/live_tv/status_browser.cjs`: **160 layout checks passed** (20 player
messages at eight viewport sizes), including fixed box dimensions and wrapping.

`node tests/live_tv/status_test.cjs` covers timeouts, successful playback, sync
and catch-up labels, paused/buffering priority, autoplay rejection and muted
fallback, stale callbacks, native media failure, ended streams, and status-fetch
failure using controlled events. `quality_status_test.cjs` covers quality menu
success, pending/paused changes, Auto, timeout, stale player callbacks, and native
browser fallback feedback.

The real 1080p quality-switch integration also passed, as did the existing eight
player and six lifecycle regressions. Physical Safari/mobile autoplay and native
decoder errors remain device coverage gaps; simulated events are not device tests.
No public deployment was tested or changed.

## Playback messages covered

| State | Message |
| --- | --- |
| Initial page | Select a channel to start |
| No broadcast | No active stream. Select a channel to start. |
| Channel requested | Switching to [channel]… |
| Channel loading | Loading [channel]… |
| Slow startup/buffering | Taking longer than expected. Still trying — check your connection or try another channel. |
| Resuming | Joining live… |
| Frames started | Now playing [channel] |
| Aligned | LIVE |
| Correcting drift | Catching up to live… |
| Clock unavailable, video playing | Playing — live sync temporarily unavailable |
| Buffer empty | Buffering… Waiting for more video. |
| Intentional pause | Paused. Press Play to return to live. |
| Autoplay blocked | Press Play to join live |
| Sound blocked, muted playback works | Playing muted — use the speaker button for sound |
| Active loader failed | Playback interrupted. Reconnecting… |
| Paused loader failed | Playback interrupted. Press Play to reconnect. |
| Channel start failed | Unable to switch to [channel]. Try again or choose another channel. |
| Native media error | Unable to load this channel. Try another channel or refresh to retry. |
| Initial status unavailable | Unable to check live TV. Refresh to try again. |
| End of stream | Stream ended. Select a channel or refresh to retry. |

Quality menu messages separately indicate switching, selected while paused,
using a quality, automatic mode, slow quality changes, and browser limitations.
