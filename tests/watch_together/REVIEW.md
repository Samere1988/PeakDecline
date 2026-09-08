# Watch Together review — September 8, 2026

**Historical pre-repair findings.** The repairs and current test outcomes are in
[VERIFICATION.md](VERIFICATION.md). Line numbers and failure counts below describe
the original code before repair; the JSON result files now contain the latest run.

## Result

The reported symptoms are consistent with reproducible playback-state races.
Nominal 15-user synchronization works, but slow startup, buffering, and reconnects
are not reliable. Production code was reviewed, not modified.

| Test layer | Result |
| --- | --- |
| Deterministic integration suite, production JS + real backend handlers | **4 passed, 11 failed** across 15 checks; failures include related branches of the same defect |
| Nominal 15-user lifecycle soak | Passed: 602 virtual seconds, 15 users at the end, no paused users, maximum sampled drift **1.78 s** |
| 15 real Edge contexts, real HLS, throttled media, join/refresh/rejoin | **Failed degraded-playback check**: users 4, 9, 14 stalled; other 12 passed final sampled conditions |
| Real HLS slow join across host pause | **Failed**: host paused at 1.21 s, viewer continued to 9.63 s |
| Real HLS slow join across host play | Final playback state passed, but event trace includes a pause/play interruption during manifest completion |
| Browser-enforced autoplay denial | Not reproduced: this Edge configuration allowed autoplay; rejection behavior tested in the deterministic suite |

Machine-readable observations are in [results.json](results.json) and
[browser-results.json](browser-results.json). Test setup and limitations are in
[README.md](README.md). These are local isolated tests, not a production Plex
capacity certification.

## Findings, in repair priority order

### 1. High: slow loading callbacks override the latest host state

`static/js/room_player.js:5024` and `:5137` use the `shouldPlay` argument captured
when `loadVideo()` began. The HLS manifest or native metadata can arrive several
seconds after a subsequent `force_pause` or `force_play`. The callback then plays
or pauses according to the old state and also seeks to the old `targetStart`.

**Browser reproduction:** start playback, have a viewer join with a six-second
manifest delay, then have the host pause after one second. The host stayed paused
at 1.21 s; the viewer eventually started and reached 9.63 s. The real trace shows
a later seek forward despite the room remaining paused. `startSyncLoop()` at
`:4140` advances its expected clock without checking `roomIsPlaying`, compounding
the initial race.

**Deterministic reproduction:** both directions fail for both HLS.js and the
native-HLS branch. In real Edge, the inverse case recovered to playing but
recorded pause followed immediately by play around manifest completion. Thus a
permanent missed-play failure is demonstrated by simulation, while unexpected
resume is also confirmed with real decoding.

**Repair:** apply the latest authoritative room state on readiness, with a load
generation identifier to discard obsolete callbacks; honor room pause in the sync
loop. Do not capture playback intent in an asynchronous loading callback.

### 2. High: host buffering erases the condition needed to resume

`room_player.js:1836` sets `isBuffering` and emits `user_buffering`. The server
responds with `force_pause` to everyone, including the host
(`app/routes.py:2033`). That handler clears `isBuffering` at `room_player.js:3260`.
When `canplay` arrives, its `isBuffering` condition is false, so no
`buffer_resolved` is emitted.

**Reproduction:** play, inject host `waiting`, deliver the real backend's pause,
then deliver `canplay`. Host and viewer remain paused; resume-event count is zero.

**Repair:** track host buffering separately from room pause and preserve whether
the host intended playback before the stall. Complete recovery without relying
on a flag cleared by the server acknowledgement.

### 3. High: delayed recovery can undo an intentional host pause

`app/routes.py:2088` unconditionally saves a playing state for `buffer_resolved`.
It does not distinguish an active buffering episode from an intentional pause
that happened later. The client also schedules recovery after 500 ms at
`room_player.js:4254`, without checking whether the host has since paused.

**Reproduction through real handlers:** play → buffering → intentional pause →
delayed buffer recovery. The room becomes playing again.

**Repair:** identify buffering episodes and invalidate pending recovery when the
host pauses, changes media, or seeks. Reject stale recovery server-side.

### 4. High: reconnect can permanently preserve a server-induced pause

In the same-media `room_state` branch, `room_player.js:2895` only corrects playing
viewers when `!video.paused`. A viewer paused by the host who loses connection
before the next host play is left paused after reconnect. The sync loop also
skips paused players, so it never repairs the state.

**Reproduction:** receive host pause, miss host play, then deliver the latest
same-media reconnect state. The room reports playing, but the viewer stays paused.

**Repair:** explicitly record intentional local pause separately from a pause
caused by the host, loading, or autoplay rejection. Reconcile these on reconnect.

### 5. High: stalled viewers are repeatedly sought into unavailable video

The `waiting` handler at `room_player.js:1827` only tracks host buffering. The
viewer branch at `:4160` seeks whenever drift exceeds three seconds, even when
the viewer lacks playable data. It does not check the target against buffered
ranges or introduce a recovery backoff.

**Real browser evidence:** users 4, 9, 14 were throttled to 150 kbps, below the
fixture bitrate. They recorded **4, 5, and 3 seeks**, respectively. At the final
sample all had `readyState=1` and decoded **zero additional frames over 2.5 s**,
while their timestamps appeared near the host's position. The host decoded 38
frames in that interval. The deterministic stalled viewer was sought forward by
20 s during a 20 s stall.

Insufficient bandwidth necessarily causes stalls; the defect is repeatedly
seeking through the stall and measuring apparent timestamp alignment as progress.
These tests do not establish how much of the stall duration the seeking causes.

**Repair:** track viewer buffering, avoid repeated unbuffered seeks, resynchronize
after playable data returns, and expose an appropriate buffering/quality state.

### 6. Medium: device clock skew becomes playback drift

`room_player.js:1591` uses server epoch directly with client `Date.now()`, only
falling back when the difference exceeds 300 s. Ordinary skew below five minutes
therefore becomes expected playback time error.

**Reproduction:** a client clock 120 s ahead ends up 120 s ahead of the host after
a force-play event.

**Repair:** estimate server/client offset with round-trip measurements and use a
monotonic clock for elapsed playback time. Apply a consistent model to room-state,
play, and seek messages.

### 7. Medium: autoplay rejection is mislabeled as an intentional pause

Play promise rejections are logged, while `room_player.js:582` labels any paused
viewer in a playing room “Paused locally.” The user is not told that an interaction
is needed. A host click elsewhere cannot be assumed to authorize this viewer's
playback; the application already anticipates rejection but does not explain it.

**Deterministic reproduction:** reject play with `NotAllowedError`; the label is
“Paused locally.” Clicking Sync to Host after allowing user-initiated playback
recovers. The installed Edge run did not enforce denial, so there is no claim of
a browser-confirmed autoplay block from this run.

**Repair:** handle `NotAllowedError` as a distinct state with a visible “Click to
join playback” action; resume at the current room position after that gesture.

### 8. Medium: non-finite seek values poison persisted room state

`app/routes.py:2052` rejects negatives but not non-finite floats. `float('NaN')`
passes that check. Other socket position handlers also lack finite-value checks.

**Reproduction:** the authenticated host emits `user_seek` with `current_time:
"NaN"`. The next state payload contains NaN, which is not valid JSON. This is an
additional resilience defect, not evidence that it caused the friends' symptoms.

**Repair:** consistently validate finite, nonnegative positions before changing
memory or database state, as the existing HTTP progress endpoint already does.

## What worked

- Fifteen unique authenticated test users remained correctly tracked after the
  nominal churn scenario.
- Host refresh inside the grace period retained ownership.
- Host departure transferred ownership to the next remaining user when the
  scheduled grace task was advanced.
- All 70 non-host play/pause/seek/buffering commands were ignored.
- Nominal playback converged within the three-second threshold in the virtual
  soak. Real-browser sessions above the deliberately insufficient-bandwidth
  group passed the final sampled readiness, decoded-frame, pause and drift checks.

## Recommended follow-up

Repair findings 1–5 together using explicit playback intent, buffering state, and
versioned state application, then rerun both suites. Add a production-like test
with actual WebSocket connections and Plex transcodes before claiming 15-user
server/network capacity. Native Safari and mobile autoplay still need device
coverage. No production behavior was changed during this review.
