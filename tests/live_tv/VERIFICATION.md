# Shared live-clock verification — September 8, 2026

The final full run passed **17/17 integration checks**, using the current
production player, clock endpoint, page and encoder lifecycle. Seven server-clock
checks, eight player checks, and six lifecycle regressions also passed. A separate
real-browser injection test passed for chat, usernames, channel names, and logos.
Watch Together's 23 regression checks passed after the backend changes.

| Checked playback period | Maximum viewer spread | Maximum server-target error | Stalled samples |
| --- | ---: | ---: | ---: |
| 15 mixed-speed viewers | 0.805 s | 0.673 s | 0 / 225 |
| After local pause/resume | 0.396 s | 0.265 s | 0 / 120 |
| After refresh and leave/rejoin | 0.991 s | 0.878 s | 1 / 120 |
| 12 healthy peers while three connections are below bitrate | 0.483 s | 0.369 s | 0 / 240 |
| All 15 after restoring bandwidth | 0.349 s | 0.234 s | 0 / 150 |
| All 15 after forced drift and network reconnection | 0.349 s | 0.234 s | 0 / 150 |
| After changing channels | 0.293 s | 0.166 s | 0 / 120 |
| After retrying a failed channel start | 0.307 s | 0.190 s | 0 / 120 |
| After a fatal loader error while paused, followed by Play | 0.307 s | 0.191 s | 0 / 120 |

These are maximum values across the sampled periods, not single final
snapshots. Every expected viewer had a program timestamp and advanced decoded
frames. Paused/stalled/missing viewers are counted explicitly. Media event
traces and startup/recovery observations remain in `synchronized-results.json`.

Ten viewers were present before stream start; five joined midstream. Nominal
profiles ranged from 1–8 Mbps and 20–250 ms latency. The generated stream was
about 756 kbps in development measurements. Late-join first-play times in the
final run ranged from **3.6 to 20.5 seconds**. The startup allowance is 30
seconds, distinct from the ongoing two-second viewer-spread bound.

Three profiles were deliberately reduced to 100 kbps, below the stream bitrate.
Their buffering is expected and does not count as acceptable synchronized
playback. All three had to recover, alongside the other 12 viewers, after
bandwidth was restored. The reported healthy-peer bound during the constrained
period applies only to those 12 peers; the raw report includes all 15.

The test verified actual WebSocket connections and two-second segments from
the production FFmpeg options with a generated 25 fps input. No player script
exceptions were recorded. The test's dedicated encoder was stopped during
cleanup; temporary test databases and media were removed.

The real channel-switch route initialized the requesting player exactly once.
Heartbeat responses during FFmpeg startup took at most 18 ms. Failed FFmpeg
startup reported no active channel, and retry restored all 15 viewers. A fatal
loader error while locally paused did not restart playback until Play.

The clock regression reproduces an encoder publication stall and verifies that
the first resumed snapshot restores six seconds of safety buffer. Fifteen clock
requests reuse one parsed playlist. Lifecycle checks reject delayed initial
status and stale response revisions; searches do not fetch per keystroke.

Earlier development runs failed the startup criterion, including a paused
loader that filled its buffer around an obsolete position. Startup now waits
for media at the shared target and moves the loader toward that target with
bounded retries. The slower startup observed near capacity is reported
explicitly rather than being represented as instant synchronization.

## Scope

Source hashes in the JSON report identify the tested production files. These
are local Windows Edge tests with generated media and an isolated Flask app.
They do not establish original-broadcast delay, public internet capacity,
high-resolution encoder capacity, or native Safari/mobile behavior. The live
URL/channel has not been supplied, so the deployed service remains unmeasured.

Changes are local and have not been pushed or deployed. See `README.md` for
the implementation, reproduction commands, acceptance windows, and deployment
requirements. Restarting the application and active encoder is required when
deploying these changes.
