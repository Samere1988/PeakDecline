# Platform testing and pause-time alignment

## What changed

When the host pauses, the room now treats the host position as a fixed target.
Every loaded player corrects even small offsets and continues checking during
the pause. An ignored/deferred seek is retried when media becomes ready or on the
two-second synchronization tick. No play command is used to align a paused player.
Stale playback revisions still cannot override that pause.

The internal paused seek tolerance is 10 ms, leaving margin for native clock
rounding against the 50 ms cross-client test threshold. Normal playing drift
correction remains unchanged. `preload='auto'` requests that the browser keep
fetching media during downtime; native browser/data-saver policies may limit that
request. This does not automatically resume the room or wait for every client
before honoring the host's next Play command.

## Tests executed here

This workstation is Windows. Results identify the actual engine/OS and do **not**
substitute a Safari/iPhone user-agent string for a genuine device result.

| Requested platform | Available coverage | Genuine device status |
| --- | --- | --- |
| macOS Safari | Playwright WebKit 26.5 on Windows, desktop Safari profile: actual room JavaScript and WebSocket connection load | Pending Mac access |
| iPhone Safari | Playwright WebKit 26.5 on Windows, iPhone profile: actual room JavaScript and WebSocket connection load | Pending iPhone access |
| Android Chrome | Installed desktop Chrome with Pixel 7 viewport, touch and user-agent emulation: actual HLS decoding and WebSockets | Pending Android device access |

The Windows WebKit build reports neither compatible HLS.js/MSE decoding nor native
HLS support. Its playback checks are therefore **unverified**, not failed product
tests and not Safari playback passes. No mocked decoder is substituted.

The Android-profile Chrome checks cover initial playback/decoded frames, host-pause
alignment and holding, refresh while paused, socket reconnect after missing host
Play, and a four-second delayed late join across host Pause. Its autoplay-permitted
path does not establish actual Android autoplay, lock-screen, or background rules.

The supplemental run passed seven checks (two WebKit room/connection checks and
five Android-profile Chrome playback checks), with zero failures. Three entries
remain unverified: playback in each Windows WebKit profile and genuine device
coverage. The real 15-user Plex run reached a maximum paused timestamp difference
of 0.8 ms and all users remained paused during the hold interval.

The deterministic suite adds a 15-user pause case with 400–650 ms injected drift
and a case where the media element initially ignores a paused seek. Both failed
before this change and pass afterward. The real WebSocket/Plex suite now also
injects small offsets, pauses, and checks that all 15 timestamps converge within
50 ms and remain fixed during a further hold interval.

Machine-readable results:

- [Platform engine/profile results](platform-results.json)
- [23 deterministic regression checks](results.json)
- [15-user real WebSocket/Plex checks, including paused alignment](realtime-results.json)
- [Edge/HLS regression checks](browser-results.json)

## Reproduce the supplemental platform run

Use the fixture setup in [README.md](README.md), including HLS.js and Socket.IO.
Install the WebKit engine into the ignored fixture directory with Playwright's
CLI, setting `PLAYWRIGHT_BROWSERS_PATH` to `tests/watch_together/fixtures/browsers`.
Then run:

```powershell
node tests/watch_together/platforms.cjs
```

`WATCH_PLAYWRIGHT`, `WATCH_CHROME`, `WATCH_TEST_PYTHON`, and `WATCH_PLATFORM_PORT`
override this workstation's paths/default port. The test starts its own
loopback-only synthetic server, uses temporary test identities/databases, and
explicitly disables Plex requests. It does not change watch history.

## Genuine devices: access still required

No Mac, iPhone, Android debugging session, or remote device-testing service was
provided to this task. Physical playback checks remain pending. Once device access
is available, use the checklist in [VERIFICATION.md](VERIFICATION.md) against a
staging deployment of the matching backend and player. Add this pause-specific
case on every device:

1. Join mid-playback and let the client get behind or ahead of the host.
2. Pause from the host. Keep the room paused for at least five seconds (longer if
   metadata or network recovery is still pending).
3. Verify the viewer reaches the host's frozen timestamp, remains paused, and
   loads available media without repeated play/pause changes.
4. Refresh or reconnect during the pause; verify the same frozen target.
5. Resume from the host, handling an explicit browser-required local gesture if
   necessary, and verify frames/audio advance from the aligned position.

Record device, OS/browser version, network, target timestamp, final timestamp,
autoplay behavior and lock/background recovery. Native HLS buffering and OS
background behavior cannot be signed off from the Windows runs above.
