# Retro Games browser netplay

Retro Games lives at `/games/retro`. Mario Kart uses this entry point and the
shared `/retro` Socket.IO namespace. Its former `/games/mario-kart-64` page and
standalone `/mk64` relay were removed on October 13, 2026. Mario Kart runs
decompiled game logic compiled to WebAssembly, without emulation.

## What is implemented

- Server-owned game catalog and isolated `/retro` rooms: game selection, invites,
  roles, readiness, host start, loading barrier, restart epochs, and departures.
  One ready player can start alone, with optional spectators joining before launch.
  Late spectating depends on the backend; Diablo and Perfect Dark support it. Lobby artwork follows the
  selected game; unconfigured games use a title card instead of MK64 artwork.
- Compatibility checks include game ID, protocol, input schema, backend, and a
  SHA-256 fingerprint of the game binaries, ROM, adapter/runtime scripts, and
  synchronization binaries/script. A changed build requires a new room.
- Browser input lockstep over the site's authenticated Socket.IO connection.
  The relay releases complete input rows in frame order; clients wait for all
  inputs before advancing the game. No predicted inputs are used.
- Bounded input/history windows, first-input-wins conflict detection, periodic
  game-state hashes, client stall timeout, and a server loading timeout.
- Stalled seats in running lockstep matches (F-Zero X, Mario Party 1 and 2): when
  the next frame has been waiting `STALL_SECONDS` (8) for one or more seats while
  others have sent input, the relay sends `transport_paused` with
  `reason: 'stalled'` to every other connected member and `transport_resumed`
  once a frame completes. The stalled seat is never paused, so its next input
  releases everyone. This keeps the 30-second client watchdog from ending a
  match when a device freezes or sleeps, which the Engine.IO heartbeat (25 s +
  20 s, left unchanged because game loads can block the page for ~22 s) takes
  43–51 s to notice. A real disconnect still follows the existing pause/expiry
  rules; F-Zero X, which cannot rejoin, still ends when the heartbeat drops a
  player.
- The MK64 adapter uses the game loader, controller/touch controls, audio and
  native menus. The current native build adds 60 FPS interpolated presentation,
  cooperative shutdown and expanded diagnostic hashes while retaining 30 Hz
  game/input timing. See [the MK64 runtime and verification notes](../ports/mk64/README.md)
  for the required matching JavaScript/WASM build and reconnect behavior.
- F-Zero X uses the generic isolated-frame adapter with a 60 Hz source-compiled
  runtime. Its lobby, relay, and session are shared with MK64. See
  [the F-Zero build and adapter contract](fzerox-port.md).

- Diablo uses its native multiplayer protocol through authenticated room seats,
  with a separate live spectator feed. See [the DevilutionX port](devilutionx-port.md)
  for full-game data, builds, saves, and browser checks.

## Latency fixes (October 21, 2026)

- `linux_server.py` serves with a `WebSocketHandler` subclass that sets
  `TCP_NODELAY`. With Nagle's algorithm on, every server message waited for the
  peer's next packet: a 60 Hz echo measured 16.1 ms median round trip on
  loopback, 0.5 ms with it off, and 60 Hz server pushes arrived in pairs.
- Mario Kart sends `kart_input` with a normal emit. Socket.IO 4.6 discards a
  volatile emit made before the previous one flushes, so every extra frame
  stepped in one render was lost: 342 of 602 inputs at 4x CPU throttling.
- Mario Party (`marioparty_runtime.js`) keeps its schedule when a frame row is
  late and re-polls every 4 ms instead of waiting for the next display frame,
  so the lost time is made up (bounded to three frames). F-Zero X
  (`retro/fzerox_runtime.html`) switches Emscripten's main loop to a 4 ms timer
  and paces frames in JavaScript the same way, without a native rebuild. With
  0–20 ms delivery jitter plus 1% 150 ms holds, Mario Party 2 rose from 44.9 to
  54.6 fps and F-Zero X from about 47 to 51 fps (small window; this host's
  software renderer caps F-Zero near 32 fps at normal size).
- F-Zero X desynced at frame 899 (title screen) in about half of jittered
  matches, on both pacings: its audio code reads how much of SDL's queue the
  browser has played, and real-time playback differed between players whenever
  frames stalled. Suspending audio removed it (0/5 vs 3/5). The runtime page now
  creates its AudioContext at 48 kHz for everyone, keeps SDL's pull callback, and
  calls it a fixed 800 samples per completed game frame; the browser plays those
  samples from a separate buffer capped at 0.25 s, and SDL's real-time silence
  timer is stopped. Result: 0/8 desyncs with audio playing, sound unchanged
  (48 kHz, no underruns in a 10 s tap). No native rebuild.

## Exact upstream scope

`ports/netplay/sources.json` pins recomp-net at
`e2491d2a78e37fb18fca087ebc34ad8261caae9c` and records SHA-256 hashes for
the six vendored source/header/license files. They are unchanged upstream files.
The build checks their integrity. Keep the included MIT notice.

This browser backend uses **recomp-net's portable input rings**, compiled into a
separate small WASM module, through `ports/netplay/src/browser_core.c`.
The browser session driver and relay are PeakDecline code. This is deliberately
not the full native `rnet_session` implementation or a wire-compatible port of
its UDP/ICE protocol. This backend does not implement rollback or FPS
replication. Backend ID: `recomp-ring-lockstep-v1`.

## Optional rollback backend

`static/js/netplay/rollback.js` registers `rollback-v1`. It is a separate
JavaScript scheduler, not recomp-net's native session implementation. Existing
MK64 and F-Zero registrations remain on lockstep. Smash uses this scheduler,
but its website runtime requests confirmed-input
native flow: no prediction or replay is allowed. The experimental battle-only
rollback path remains available to the isolated comparison fixture.

Register a compatible game with `backend='rollback-v1'`, `rollback_window=6`,
and `input_delay=2`. These server-owned settings are part of compatibility.
Prediction is bounded to 1–12 frames and delay to 0–4 frames; individual games
can support a smaller maximum. Never change delay independently during a match.

The relay emits each authenticated player's `frame_input` immediately and
continues emitting complete `frameset` rows. Only rollback rooms receive the
individual-input event. Slots are determined by membership, and spectators
cannot submit inputs. The transport is still reliable Socket.IO; this is not
WebRTC/UDP or a claim of loss-tolerant competitive internet performance.

The game binds this synchronous adapter to `session.bind(adapter)`:

| Method | Contract |
| --- | --- |
| `sampleInput()` | Return one `{buttons,x,y}` local sample; sampled once per delayed frame, including while stalled. |
| `saveState({frame,confirmed,replaying})` | Return an independent, opaque pre-frame snapshot; include RNG, input edge state, object lifetime, timers and all simulation globals. Existing adapters may ignore the context argument. |
| `restoreState(snapshot)` | Restore exactly, without changing or consuming the retained snapshot. Throw if restoration is unsafe. |
| `simulateFrame(pads, {frame,replaying})` | Advance exactly one synchronous simulation frame. Suppress duplicate audio, effects, and irreversible actions during replay. |
| `hashState()` | Return a deterministic unsigned 32-bit checksum of current simulation state. |
| `releaseState(snapshot)` | Optional: release native snapshot storage. Called when replaced, confirmed, or disposed. |
| `canPredict({frame,confirmed})` | Optional: return false across unsafe object/scene transitions; confirmed frames may still run. |
| `needsConfirmation()` | Optional: after a speculative/replayed update, report that an irreversible action was intercepted. The scheduler restores that frame and retries it confirmed in the normal loop. The adapter must intercept the action before it occurs. |

The game loop calls `session.advance()` once per simulation opportunity. It
returns false while loading or waiting at the prediction limit. Render once
after advancing, never once for every replayed frame. Do not simultaneously
run the old autonomous game loop. The existing frame-ready WASM adapter is
not automatically a rollback adapter; it cannot save/restore arbitrary games.

The scheduler predicts the latest known input, rewinds to the earliest
incorrect prediction, and recomputes subsequent inputs and hashes. Only
corrected, confirmed hashes are submitted. Spectators run confirmed input only.
Snapshots and input history are bounded, conflicting inputs fail closed, and
old epochs are ignored. Disposal releases snapshots and the stall watchdog.

Scene transitions, saving, achievements, match results and other irreversible
actions must wait until their triggering frame is confirmed. A locally
predicted KO is not a confirmed match result. This remains an adapter duty;
`canPredict` alone cannot undo an already performed external side effect.

Verification:

```
node tests/games/rollback_core.cjs
.venv/Scripts/python.exe tests/games/retro_test.py
.venv/Scripts/python.exe tests/games/retro_test.py --serve --rollback
node tests/games/rollback_browser.cjs
```

The browser fixture temporarily opts MK64's *test registration* into rollback
and replaces its adapter with a deterministic test simulation. It does not
test MK64 gameplay with rollback. The real Socket.IO test runs two players and
a spectator with delayed input delivery, and compares final states. Core tests
cover one/two/four players, reordered and duplicate inputs, bounded prediction,
conflicts, snapshot release, delay seeding and stale epochs.

## Smash latency changes and measurements (October 13, 2026)

The current source uses one frame of input delay for Smash and retains the
six-frame prediction limit. The room descriptor agrees the delay, checkpoint
hash interval (60 frames), and optional peer-input transport before startup.
Other games retain their existing defaults. Native menus, pause, match endings,
and scene transitions still require confirmed execution.

Player inputs have an optional unordered WebRTC copy (`maxRetransmits: 0`) with
the previous eight inputs repeated in each bounded binary packet. Socket.IO
still receives every original input for the authenticated journal, spectators,
and recovery. Rendezvous binds each connection to its authenticated room slot
and epoch. Failed channels, packet loss, or unsupported WebRTC retain the relay
path. `NETPLAY_ICE_SERVERS` can provide JSON STUN/TURN settings; the default uses
the existing Google STUN endpoints and does not provide TURN service.

Peer progress is capped at 120 input frames beyond relay confirmation; the
server accepts at most 128. Checksum publication also waits for relay
confirmation, keeping every pending checkpoint inside retained history. This
prevents fast peer delivery from causing the slower reliable journal to reject
inputs or checksums outside its window.

The native build moves `SDL_EMSCRIPTEN_ASYNCIFY=0` out of the unreachable
Android-only block, preserving the existing rAF pacing. After a battle input
stall it can execute at most two extra forward updates in the original
coroutine, within a 4 ms batch budget. Debt is capped at six frames and cleared
at barriers/scene changes. Intermediate updates are not rendered separately.
`Module.peakCatchup=false` disables catchup for comparison. The JS engine keeps
full hashing by default for deterministic tests; Smash sessions hash only
checkpoints. Fully confirmed frames can skip snapshots in a compatible native
build, with confirmation context and retirement clocks still updated.
Keyboard, touch, and polled gamepad button edges are retained in a bounded FIFO
while stalled; previously transmitted inputs remain immutable.

Before editing, the existing sources and published WASM were frozen under
`.tmp/smash-latency-20261013/baseline`, with SHA-256 hashes in
`baseline-manifest.json`. `tests/games/smash_latency_compare.cjs` ran three serial
repetitions per configuration in alternating before/after order: 900 simulation
frames each, measuring active battle status **Go (1)** only after frame 300.
Chromium 153 used one real WASM instance and a scripted remote controller, with
identical target-frame inputs in every run. All 60-frame confirmed checksums
matched across all 12 runs. Results below are medians of the per-run statistics.

| Profile | Version | Simulation FPS | Sample-to-simulation median | p95 |
| --- | --- | ---: | ---: | ---: |
| No added delay | Before | 60.0 | 33.5 ms | 34.4 ms |
| No added delay | After | 60.0 | 16.8 ms | 17.4 ms |
| 85–105 ms delivery delay, periodic 250 ms bursts | Before | 55.3 | 33.5 ms | 56.2 ms |
| Same delayed profile | After | 57.7 | 16.8 ms | 50.0 ms |

The one-frame delay reduction accounts for the approximately 16.7 ms median
gain. The clean run's measured hash calls fell from 510 to 9, and confirmed
snapshot captures from 509 to zero. The delayed candidate retained snapshots
and exercised 30 corrections and approximately 59 catchup frames per run.
Large bursts still produced roughly 267 ms maximum sample-to-simulation delay;
the bounded rollback window does not eliminate every stall. The fraction of
failed advance attempts is not directly comparable because catchup makes
additional attempts inside a rendered iteration.

The separate `rollback_transport_browser.cjs` test used real local RTC channels
with application-emulated 40 ms transit, a 120 ms ordered-relay stall every 45
inputs, and 5% RTC packet loss. All 180 inputs arrived in each configuration.
Relay arrival p95 was 128.6 ms, RTC plus relay fallback 40.5 ms, and a closed
RTC channel correctly fell back to relay at 128.9 ms. These are controlled
transport measurements, not measurements of Internet routing.

Raw gameplay runs and aggregate results are under
`.tmp/smash-latency-20261013/results/`; transport results are in `transport.json`
beside that directory. Input timings exclude controller hardware and display
photon latency; next-rAF measurements are scheduling proxies. Headless results
do not establish performance on separate friends' computers. The candidate
WASM is staged in `.tmp/battleship-web/build-wasm`; these measurements do not
publish it to `instance/smash64/build`.

Correctness verification also passed the four-player 3,600-frame every-frame
comparison with items, projectiles and Hyrule hazards. The real lobby/Socket.IO
test completed 3,600 frames and two native matches with pause/resume, results,
and a spectator. Both players had an open RTC connection carrying gameplay;
their 18 and 2 rollback corrections converged with the spectator to final hash
1754315598. The adapter keeps full captures with an older hybrid binary whose
retirement clock still depends on capture; new native timing/catchup exports
identify the compatible implementation.

Reproduce with the installed Playwright module/browser paths supplied through
`PLAYWRIGHT_MODULE` and `BROWSER_EXECUTABLE`:

```
node tests/games/smash_latency_compare.cjs
node tests/games/rollback_transport_browser.cjs
node tests/games/rollback_latency.cjs
node tests/games/smash_catchup.cjs
.venv/bin/python tests/games/rollback_signaling_test.py
.venv/bin/python tests/games/catalog_rollback_test.py
```

`SMASH_BASELINE_DIR`, `SMASH_RESULTS_DIR`, and `SMASH_REPEATS` select another
frozen baseline, output directory, or repetition count. Build preparation
persists the native pacing fix; changing generated C/C++ files alone is not
sufficient. Stage and validate the adapter and native build together.

## Smash keyboard-event latency measurement

`tests/games/smash_input_lag.cjs` measures an earlier starting point than the
sample-to-simulation benchmark: a trusted Chromium keyboard event travels
through the unmodified production keyboard handler, input buffer, iframe
bridge, rollback session and real candidate WASM. Each probe starts with an idle
Mario, presses A, and checks the native fighter's A tap and jab1 attack ID in the
intended simulation frame. Benchmark-only hooks in the served JavaScript count
Fast3D draws and timestamp the following EGL swap request. The native files on
disk are unchanged. Cached GUI-only submissions cannot satisfy the probe.

October 13, 2026 results pooled 120 presses across three serial runs at the
current one-frame input delay. Chromium 153.0.8010.12 ran headless with SwiftShader,
60 Hz simulation, six-frame prediction limit and a 60-frame hash interval. A
neutral remote controller's input arrived immediately. Measurements started
in active battle after frame 300, with varying keypress phase within the tick.

| Interval | Median | p95 | Maximum |
| --- | ---: | ---: | ---: |
| Browser key event to input sampling | 8.2 ms | 16.3 ms | 16.7 ms |
| Input sampling to native consumption | 16.7 ms | 17.1 ms | 17.8 ms |
| Browser key event to native jab response | 24.9 ms | 32.9 ms | 33.4 ms |
| Browser key event to attack-frame CPU submission | 26.4 ms | 34.0 ms | 35.1 ms |

All runs maintained 60.0 simulation FPS, with zero stalls and corrections;
all completed simulation frames were confirmed. All 120 inputs passed the
native response and fresh-draw checks. A separate 40-press zero-delay control
measured 9.0 ms median event-to-native response and 9.8 ms median / 18.1 ms p95
event-to-submission. This is a sanity control for the fixed delay's cost, not a
network robustness test or a change to the agreed one-frame setting.

These measurements exclude physical controller polling, OS input delivery,
GPU completion, browser composition, monitor scanout and pixel response. A swap
request or subsequent rAF does not establish displayed pixels. The fixture
stubs unrelated gamepad/touch/UI services and does not run RTC/Socket.IO traffic;
it measures the local keyboard path under clean conditions. Results apply to
the staged candidate build, not the published runtime or a friend's computer.
Actual button-to-photon latency requires a displayed client and external capture.

The complete raw events, native frame numbers, renderer, source hashes and
aggregate report are in `.tmp/smash-input-lag-20261013/`. Reproduce with the
installed Playwright/browser paths in `PLAYWRIGHT_MODULE` and
`BROWSER_EXECUTABLE`:

```
SMASH_REPORT=.tmp/smash-input-lag-repeat.json node tests/games/smash_input_lag.cjs
```

`SMASH_PRESSES` defaults to 40; `SMASH_INPUT_DELAY` defaults to 1 and permits a
test-only zero-delay control. `SMASH_BUILD` selects another native build.
Quantiles use the pooled observations, not averaged run percentiles. Earlier
sample-to-simulation numbers remain valid; the additional roughly 8 ms median
is the newly measured wait from the key event to the next input poll.

## Smash input repair and connection recovery

The optional player transport now uses `rollback-input-v2`. Its binary header
contains a cumulative receipt acknowledgment and a 32-frame selective receipt
mask; a packet holds at most eight input frames (84 bytes). Each seat retains
at most 128 immutable submitted inputs. Routine sends still repeat the latest
eight frames. Missing inputs are repaired independently of simulation progress,
with a 50 ms minimum repair interval and bounded flush on channel backpressure
recovery. ACK-only packets are spaced at least 16 ms apart and never solicit an
ACK response. Complete relay rows advance the receipt frontier so a connection
that opens late does not wait for evicted history from the start of the match.
One-shot timers wake at the earliest pending acknowledgment, repair, handshake,
disconnect or retry deadline; an idle transport has no polling timer. A blocked
channel waits for its queue-drain event instead of repeatedly polling it.

The lower seat owns connection offers. Failed or closed channels can be replaced
in generations 1–4, with 250/500/1000/2000 ms retry backoff; higher seats can send
authenticated restart requests. A disconnected connection has a 1500 ms grace
period, and a new connection has a 10-second handshake deadline. Receipt state
survives replacement. Stale signals, promises and channel callbacks cannot
modify a newer generation; future ICE candidates have a bounded queue. After
the retry budget is exhausted, the reliable relay continues normally.

These changes do not sample new controller inputs, alter submitted frames,
advance simulation, increase prediction depth, change input delay, or remove
the 120-frame relay lead limit. Every original input still goes through
Socket.IO and confirmed checksum publication still waits for the relay.
Refresh clients to load the new channel protocol. The updated Python signaling
handler also requires restarting a running production application; the tests
use an isolated fixture and do not restart production or publish native assets.

The pre-change transport and signaling sources are frozen under
`.tmp/smash-transport-recovery-20261013/baseline`, with a SHA-256 manifest.
`tests/games/rollback_transport_recovery_browser.cjs` compares either source
using real local Chromium RTC and the same application-emulated network loss.
`ROLLBACK_TRANSPORT_SOURCE` selects the source file,
`ROLLBACK_TRANSPORT_REPORT` selects its JSON report, and
`ROLLBACK_RECOVERY_EXPECT=baseline|candidate` enables behavioral assertions.
`ROLLBACK_RECOVERY_EPISODES` and `ROLLBACK_RECOVERY_RECONNECT_EPISODES` control
independent loss and reconnection trials. `SMASH_RTC_RECOVERY=1` additionally
closes a real channel during active battle in `smash_netplay.cjs`, requiring
reconnection and identical final states for players and spectator.

Three serial, alternating baseline/candidate repetitions used Chromium
153.0.8010.12. Each variant included 36 independent lost-tail trials, 36 burst
trials, 288 clean input samples and 12 connection failures. Both players submit
inputs; both receive complete relay rows. Artificial transit is 40 ms each way.
Loss cases hold the reliable relay for another 160 ms and submit no further
game frames after the lost input, so only independent repair can beat the relay.
The burst case drops copies during the first 80 ms. Values below are medians of
the three per-run statistics, not pooled percentiles.

| Input-arrival measurement | Before | After |
| --- | ---: | ---: |
| Clean median | 40.0 ms | 40.0 ms |
| Clean p95 | 40.2 ms | 40.2 ms |
| Lost final input, median | 199.2 ms | 90.9 ms |
| 80 ms loss burst while stalled, median | 200.0 ms | 141.3 ms |
| Peer connection reopened within 3 seconds | 0/12 | 12/12 |
| Reconnection median | No recovery observed | 309.6 ms |

All measured inputs arrived, and all received protocol packets were valid.
Every recovered connection delivered the subsequent probe over RTC. Clean
RTC-only p95 also remained 40.5 ms. The short clean episodes generated 43,484
bytes of RTC application payload versus 27,648 previously, across both
directions and all repetitions; acknowledgments and repairs account for the
increase. These include end-of-stream repairs and do not estimate steady-state
session bandwidth or wire overhead. The fixed 16 ms polling prototype and its
timer-control diagnostics are retained separately; the final source uses
deadline-driven timers and avoids that prototype's clean-path timing regression.

Final raw runs and `comparison.json` are in
`.tmp/smash-transport-recovery-20261013/results-final/`, recording source and
harness hashes. These are local browser transport measurements with emulated
impairments; they do not measure Internet routing, hardware input, simulation
latency or displayed pixels. No claim of another fixed-frame input-lag reduction
is made: configured input delay remains one frame.

The final source also passed 18 deterministic repair/recovery boundary cases,
the existing rollback/transport suites, eight authenticated signaling tests,
eleven relay tests and the catalog checks. In the real Smash fixture, two
players and a spectator completed 3,600 confirmed frames and two native matches
with pause/resume and results. Closing the RTC channel at battle frame 1309
triggered one successful recovery on each player, with zero invalid packets.
All three final-state hashes were 1754315598. This multi-instance headless run
validates correctness; its aggregate FPS and input timings are not a gameplay
performance comparison. Its report is `native-recovery-final.json` beside the
final transport results directory.

```
node tests/games/rollback_transport.cjs
node tests/games/rollback_transport_recovery.cjs
ROLLBACK_RECOVERY_EXPECT=candidate node tests/games/rollback_transport_recovery_browser.cjs
.venv/bin/python tests/games/rollback_signaling_test.py
SMASH_NATIVE_FLOW=1 SMASH_EPOCHS=1 SMASH_FRAMES=3600 \
SMASH_RTC_RECOVERY=1 SMASH_REQUIRE_RTC=1 \
SMASH_DELAY_MS=85 SMASH_JITTER_MS=20 SMASH_BURST_MS=250 \
node tests/games/smash_netplay.cjs
```

## Experimental Smash snapshot adaptation

`ports/smash64/sources.json` pins the browser BattleShip fork and Vita game-code
dependency. Four unmodified Vita snapshot/digest files are retained under
`ports/smash64/vendor/vita`; their NOTICE preserves source attribution and the
upstream licensing distinction. They are game-specific, not shared engine state.

`ports/smash64/prepare_rollback.py` generates browser copies in the isolated
`.tmp/battleship-web` checkout. It retains Vita's capture/restore, deferred
object destruction and replay suppression hooks; replaces its transport-driven
correction controller with WASM exports; and includes controller edge state in
the snapshots. `rollback_adapter.js` binds those exports to the shared interface.
The Vita snapshot ring supports at most six predicted frames.

The full `BattleShip.js` / `BattleShip.wasm` browser build now links. The native
Torch dependency and sidecar copy were removed from this experimental browser
build; upstream's separate Torch WASM target performs extraction instead.
`ports/smash64/build.py` reproduces both builds using the existing toolchain.
`node ports/smash64/extract_assets.mjs` runs Torch WASM against the existing US
ROM and writes the 12,114,884-byte archive into the isolated build directory.
`python ports/smash64/publish.py` stages the verified runtime, extracted archive,
adapter and credits in `instance/smash64/build`. Smash is registered in the normal
Retro Games catalog and becomes available when all allowlisted files exist.
Restart a running production Flask process after updating the Python catalog.

`tests/games/smash_browser.cjs` exercises the real game, not a fixture adapter.
Set `SMASH_PROBE=boot` for ordinary boot/render or `save` for snapshot capture.
The default test targets 600 frames and compares delayed-input rollback against
confirmed input. The two-player test now passes at 1,800 frames with 70
corrections; every confirmed frame hash matches. The four-player case also passed
1,800 frames with 70 corrections. Set `SMASH_FRAMES=1800` to reproduce it.
`SMASH_PLAYERS=4` adds two fighters and enables normal items;
`SMASH_ITEMS=1` enables items for the two-player case and `SMASH_SPECIALS=1`
exercises projectiles. `SMASH_KO=1` uses a one-stock match and a remote fighter
running off the stage. The projectile/item case passed 1,800 frames with 85
corrections; the remote KO case passed 1,200 frames with 17 corrections. These
are real gameplay tests, not exhaustive move/item/latency coverage.

Experimental hooks gate VS updates and controller polling only when the shell
provides `Module.peakAdvance`. Ordinary browser execution retains its original
loop. Input edge generation uses restored controller state during rewind.
The shared engine/session now expose `beginAdvance()` and `completeAdvance()`.
Smash queues the prepared input, executes its forward update directly inside
the native coroutine, then completes the frame through `Module.peakComplete`.
This avoids the unsafe reentrant JS/WASM forward call. Replays remain
synchronous with coroutine processes suppressed. Calling the Smash adapter's
`simulateFrame` for forward execution now fails explicitly.

Corrections arriving during a yielded forward frame retain their snapshot and
withhold checksums until replay. Core tests cover this case and mixed synchronous
and coroutine sessions. Snapshot extensions include fighter motion/stat ID
counters and animation command cursors. Countdown transitions wait for confirmed
inputs, match timers follow simulation ticks, and effect/particle randomness
uses a separate cosmetic stream while networked.
Networked fighter animation files use a bounded 64 MiB cache at stable addresses
for the WASM instance's lifetime. The original per-fighter heap is overwritten
on move changes, so restoring only old pointers/cursors could resume a different
animation. This cache avoids that overwrite while preserving ordinary loading
when rollback is inactive. Restarting the iframe releases the entire cache.

Deferred object destruction uses pre-frame snapshot boundaries, cancels discarded
future destruction records, and excludes logically dead objects from checksums,
collision, pickup, AI and camera searches. Retained allocations support rewind;
they must not behave as live projectiles/items during the retention window.
Stage object animation frames and DObj trees are also captured: Dream Land's
hazard state depends on animation completion. Restore validates stage allocation
identity before restoring retained pointers.

The shared iframe host now accepts a rollback adapter at the runtime's battle
boundary, with the same input, touch, fullscreen and restart controls as F-Zero.
`templates/retro/smash64_runtime.html` restores the original US startup: N64 logo, full opening movie and title screen,
with every character and normal stage unlocked. The upstream PC port normally
skips the N64 logo; scene 27 restores it. The normal Start-button skip still works.
The website lobby only
selects the game, assigns player/spectator roles and waits for everyone to ready
up. Smash has no website fighter, stage, stock or CPU selectors. Choose these
inside the game. Solo starts with a CPU opponent; multiplayer opens one human
controller for each occupied lobby seat.

Menus use the shared input relay in confirmed-input mode, without predictions or
UI snapshots. Native task updates publish shared controller input and advance
only when every player's input is available. Menu random choices use the shared
RNG instead of wall time. Enter/Start works in menus. The website runtime sets
`Module.peakNativeFlow`: in the installed October 3 build, the same confirmed-input
gate also wraps the original VS battle update, pause, results, and subsequent
matches. Frame numbers, player slots, and spectators continue without a new
epoch or iframe. Native flow bypasses snapshot capture, prediction, deferred
object destruction, and the rollback animation cache; the game keeps its normal
scene lifetimes. Experimental battle-only rollback still uses those mechanisms
when `peakNativeFlow` is absent.

The isolated fixture runs with `python tests/games/retro_test.py --serve` against
the published build. For development, add `--smash` to select the isolated build
after `python ports/smash64/stage_fixture.py` stages its loader metadata.
`node tests/games/smash_netplay.cjs` exercises ordinary controller input through
the main menu, VS menu, character selection, stage selection, battle and shared
restart with a spectator.
`SMASH_SOLO=1` selects solo/CPU coverage and `SMASH_PLAYERS=4` selects four humans.
The browser test verifies original startup, normal intro skipping, title,
main menu, VS menu, character selection, stage selection and battle, then repeats
after a shared restart. Set `SMASH_FULL_INTRO=1` to let the entire opening play
uninterrupted. Tests check native scene transitions and synchronized battle
hashes, and check that no Smash configuration selectors appear in the lobby.
No production databases are opened by this fixture.

The website no longer intercepts Game Set. Native announcements, results,
character/stage selection, pause/resume, and rematches run inside the game.
The host's website restart remains an optional full reset. That installed build uses
confirmed input throughout Smash because the experimental battle snapshots do
not cover the entire native scene lifecycle. Network delay can therefore stall
play rather than being hidden by prediction. Do not re-enable prediction for
native flow without snapshotting or safely committing all scene side effects.

### Battle rollback with native scenes (October 4–5 development build)

The updated adapter enables `Module.peakHybridRollback` when the matching native
export exists. Explicit `false` keeps the confirmed-input baseline. This preserves
compatibility with older builds; the new native build and adapter must be staged
together. These development artifacts have not been published to the live service.

Menus, countdowns, pause, results and scene transitions use confirmed input.
Active battles reuse the existing Vita-derived snapshots and the shared six-frame
prediction window. Start and match-ending events are confirmation barriers:
speculative execution stops before irreversible effects, restores the pre-frame
snapshot, discards the speculative tail, and retries that exact frame with confirmed
input in the original native coroutine. A correction that discovers an earlier
transition follows the same path. Already-transmitted controller inputs remain
valid. No results screen ends the room or replaces its iframe.

The snapshot now includes the match timer bookkeeping and stock placement counter.
Timer expiration is intercepted before its interface object is deleted. Snapshot
history is reset before scene arenas are recycled. Cosmetic damage-number breakup
uses the separate visual RNG, like particles, so replayed UI animation cannot
change later gameplay randomness.

Animation-track nodes now remain allocated throughout the rollback window;
restoration rebuilds their saved linked lists rather than writing into recycled
pool entries. New snapshots exclude logically dead projectiles/items. Rewinding
past their death can still reactivate retained objects, but later snapshots no
longer hold pointers that outlive the cleanup window. This fixes the four-player
projectile stress test's native cleanup hang at frame 1,668.

`node tests/games/rollback_barrier.cjs` tests speculative boundaries, replay-tail
discard and input arriving during a pending native frame. `smash_native_core.cjs`
tests both adapter modes. The real-game test supports `SMASH_PAUSE_SLOT=1` to make
the delayed remote player pause, and `SMASH_TRACE=1` to save bounded state traces
on failure. Reports include native prediction and barrier counts. Use the isolated
fixture with `--smash --smash-hybrid` when testing explicit opt-in; normal staging
also enables the feature through the native export handshake.

After changing snapshot/object lifetimes, run the combat regression as well:
`SMASH_PLAYERS=4 SMASH_ITEMS=1 SMASH_SPECIALS=1 SMASH_FRAMES=1800 node tests/games/smash_browser.cjs`.
It compares every confirmed frame against a no-delay reference, including the
previous cleanup failure. `SMASH_DEBUG_HANG=1` enables a native debugger stack
capture; `SMASH_SCREENSHOT=1` requests bounded screenshots in either browser test.
Add `SMASH_HYBRID=1 SMASH_FRAMES=3600` to exercise Hyrule's tornado lifecycle.
Its creation, collision-obstacle registration, and removal commit behind
confirmation barriers; ordinary battle and tornado movement remain replayable.

Verified locally with Chromium and the real WASM/Socket.IO runtime: stock matches,
native pause/resume and pause-to-quit, four-player teams, one-minute timed matches,
sudden death, and changing rules/stage between matches. Each included a spectator
and delayed input; state hashes matched. A 9,000-frame run completed six matches
in one room epoch, with 78 corrections on the delayed host. These are correctness
tests on one machine, not a measured internet-latency or hardware-FPS guarantee.
The final four-player team run also passed with 85 ms added input delay, 20 ms
jitter, and 250 ms bursts, with matching player/spectator hashes across two matches.
The final hybrid combat comparison passed all 3,600 frame hashes with four
fighters, repeated normal/special attacks, projectiles and Hyrule hazard events.

The `itMainDestroyItem` LP64 pointer guards were audited on October 15. Their
casted 4 GiB threshold becomes zero on wasm32, so they did not reject valid
WebAssembly items. The generator now explicitly limits those diagnostics to
64-bit pointers, including their eight-byte pointer dump. Targeted item
destruction/consumption tests cover the actual gameplay behavior.

Run `node tests/games/smash_native_core.cjs` for the adapter contract and
`SMASH_NATIVE_FLOW=1 node tests/games/smash_netplay.cjs` for real-game results,
pause/resume, and consecutive matches through the relay with a spectator.
Browser tests accept `PLAYWRIGHT_MODULE` and `BROWSER_EXECUTABLE` overrides.
The Linux build uses CMake/Ninja on PATH and the `EMSDK` directory; use
`python ports/smash64/build.py --runtime-only` to reuse the existing extracted
assets when only game code changes.

Native-flow verification on Linux (2026-10-03): two and four human players,
each with a spectator, completed 3,600 synchronized frames with 85 ms delayed
input delivery to the host. Both runs changed stock rules in the native menu,
paused/resumed, completed two matches, traversed both results screens, and
returned to stage selection without changing the room epoch. Final hashes
matched on every client, with zero predictions/replays. A separate two-player
and spectator run verified 1,000 frames before and after a website restart.
The shared rollback core, native adapter contract, and 11 relay tests also passed.

### Native-flow regression suite

Rebuild/stage the isolated runtime before using the extended suite; its
`peak_native_diagnostics` export reads rules, native status, CPU count, sudden
death, and live allocator usage without changing game state.

```
.venv/bin/python ports/smash64/prepare_rollback.py
.venv/bin/cmake --build .tmp/battleship-web/build-wasm --target BattleShip.js -j 6
.venv/bin/python ports/smash64/stage_fixture.py
.venv/bin/python tests/games/retro_test.py --serve --smash
node tests/games/smash_suite.cjs
```

Set `PLAYWRIGHT_MODULE` if Playwright is outside Node's normal module path.
Individual suite names are `quit`, `teams`, `rules`, `solo`, `timed`, `sudden`,
`soak`, `baseline`, and `latency`. Rule changes, pause-menu quitting, and stage
selection use ordinary controller input; the tests never write game memory.
The soak runs 18,000 frames and requires at least ten completed battles, comparing live
allocations at the same point in each battle after initial cache warm-up.
This is bounded repeated-match coverage, not an overnight stability claim.

Logs, per-client state checks, memory checkpoints, effective simulation rate,
and sample-to-simulation input latency are saved under `.tmp/smash-suite/`.
The latency case delays host-bound input by 85 ms with up to 20 ms jitter and
250 ms bursts, preserving delivery order to model reliable transport stalls.
It does not emulate actual packet loss, real internet routing, or rendering
latency. Headless browsers share one machine and use software rendering, so
their frame rates are not representative of separate gaming computers.

For the optional four-frame buffer comparison, start a second isolated fixture:

```
.venv/bin/python tests/games/retro_test.py --serve --smash --smash-input-delay 4 --port 8067
node tests/games/smash_suite.cjs buffered
```

Both fixtures bind only to localhost. These options never change the production
catalog. Real playtesting between friends on separate connections remains needed.

The October 2026 isolated run passed native pause/resume and quit, four-player
teams, changes to stock rules and stages between matches, a CPU opponent,
one-minute timed matches, and tied matches entering and resolving sudden death.
Players and spectators had matching final state hashes. The 18,000-frame soak
completed twelve matches and started a thirteenth without restarting the room.
After the first two battle checkpoints, live allocations stayed between 49.52
and 49.89 MiB; the reserved WASM buffer remained 256 MiB. This does not establish
that every scene or a longer session is leak-free.

Sequential two-player-plus-spectator timing runs produced these host measurements:

| Artificial network delay | Input buffer | Simulation frames/sec | Input median / p95 |
| --- | ---: | ---: | ---: |
| None | 2 frames | 44.9 | 39 / 93 ms |
| 85 ms + up to 20 ms jitter + periodic 250 ms burst | 2 frames | 25.8 | 91 / 183 ms |
| Same delayed profile | 4 frames | 37.9 | 100 / 262 ms |

All three runs finished with the same final state hash, including the spectator.
The delayed cases passed correctness checks but showed substantial slowdown;
they are not performance passes. The larger buffer improved simulation speed
while increasing measured input latency. These are single runs in shared
headless software rendering, not expected frame rates on friends' computers.
Production remains at two frames pending real separate-connection playtesting.
This testing change adds diagnostics and fixtures only; its WASM build was not
published to the live service.

All 12 playable fighters and nine normal stages were exercised in delayed-input
battle comparisons. In `smash_browser.cjs`, use `SMASH_FIGHTERS=1,5,9,11`,
`SMASH_STAGE=6` and `SMASH_PLAYERS=4` to choose a direct battle test combination.
Those test presets do not configure the website lobby. Shared fullscreen tests
cover MK64, F-Zero and Smash (`RETRO_TEST_GAMES=mk64,fzerox,smash64`).
This remains an experimental browser port: these bounded comparisons do not prove
every move/item combination or long-session behavior. The upstream renderer's
ordinary-run relocation warnings were traced on October 15 to a desktop-only
low-address diagnostic receiving valid wasm32 display-list pointers. That
heuristic now runs only on 64-bit hosts; actual relocation-token validation
remains active.

## Extension boundaries

1. Register a game in `app/netplay/catalog.py`: ID, title, files, ROM, player
   limit, simulation tick rate, input schema, backend ID, UI template and scripts.
2. Add its UI template and register a browser adapter in `PeakNet.adapters`.
   The adapter implements `present`, `launch`, `stop`, and `hostChanged`.
   Games using the frame bridge can call `PeakNet.registerFrameGame` instead;
   register `runtime_template` in the catalog to use the shared runtime routes.
3. In `launch`, bind `sampleInput()` and `hashForFrame(frame)` to the session.
   Connect the game's controller-read hook to `frameReady(frame)` and
   `getFrame(frame)`. Simulation frame numbers start at 1, advance by one,
   and reset on a new session. The SDK sends `loaded` when the adapter binds;
   admission waits for the server's all-participants start barrier.
4. Initialize identical simulation state on all clients. Keep local camera and
   renderer settings from affecting shared gameplay. The framework cannot
   make a nondeterministic game deterministic.
5. Add game tests using different controller inputs and compare completed-frame
   hashes through loading, gameplay, and restart. Validate two and four players
   where supported, plus spectators and realistic latency/loss.

The initial codec is `n64-pad-v1`: held button mask plus signed X/Y in -80..80.
Do not duplicate the lobby, room server, or session driver for a second racer.
New input schemas require a codec/validator; new synchronization approaches
register a backend in `PeakNet.backends` and may require a new server transport
handler. Perfect Dark replication is a future backend, not a config toggle.

Game runtime markup/scripts remain owned by the adapter. The initial MK64
template preserves its DOM contract, and Retro Games reuses its visual CSS.
Changes to the shared existing MK64 runtime require regression tests on both
entry points. The legacy online script is never loaded on Retro Games.

## Build and verification

Use the already prepared Emscripten toolchain from `ports/mk64/prepare.py`:

```
python ports/netplay/build.py
.venv/Scripts/python.exe tests/games/retro_test.py
node tests/games/retro_core.cjs
.venv/Scripts/python.exe tests/games/retro_test.py --serve
node tests/games/retro_browser.cjs
node tests/games/retro_lobby_browser.cjs
```

Set `MK64_TEST_PLAYERS=4` for the four-player race check. The fixture uses
separate test sessions and serves existing build files without opening the
production databases. It listens only on 127.0.0.1:8066. Never deploy the fixture.
Screenshots go to `.tmp/retro/`.

Build outputs are `instance/netplay/build/netplay.js` and `netplay.wasm`.
They contain no game assets. Install both before restarting the production
application. Routes enforce login and allow only these filenames.
On Windows the build republishes both outputs with the destination folder's
inherited permissions. Emscripten's private temporary-file permissions otherwise
can prevent the website account from reading them, causing a page error.

## Current limits

Rooms are process-local: use one Socket.IO worker; restarting it ends sessions.
There is no reconnect-to-match, late join, automatic state repair, or host
migration during play. A playing participant's disconnect ends the match.
Rollback is opt-in and remains unvalidated for production game adapters.
Spectators join before start and run the same simulation. Socket.IO's reliable
transport can stall under loss; internet latency and mobile performance still
need testing. Input hashes and simulation hashes detect problems but do not
prevent cheating. Browser frame throttling may stall all participants.

F-Zero validates these adapter boundaries with a second racing game. Evaluate
a separate browser-compatible replication backend for Perfect Dark.

The shared iframe host provides a local Game volume slider for F-Zero X and
Smash. `static/js/netplay/game_audio.js` routes Web Audio output through a master
gain in each runtime, without changing game simulation or network inputs. Each
game saves its own volume in browser storage and restores it on launch/restart.
`node tests/games/retro_volume.cjs` checks actual output gain, mute and persistence.

Room cards and lobby previews use direct browser canvas captures of each game's
title screen: `static/img/mk64-title-screen.png`, `fzerox-title-screen.png`, and
`smash64-title-screen.png` (captured 2026-10-02 from the installed game builds).
The artwork uses contain sizing in 4:3 previews. Smash sets
`SSB64_TITLE_BRAND=0` to retain the original title artwork instead of the upstream
port's Smash.fun replacement.

## Optional FPS authority backend

`authoritative-host-v1` is an opt-in alternative to input lockstep and full-world
rollback. No production game currently selects it. Perfect Dark is not yet
integrated. Existing MK64, F-Zero and Smash backends remain unchanged.

The first occupied player seat (slot zero) runs the authoritative simulation.
This can differ from the website lobby owner, who may be a spectator. Flask
validates and relays traffic; it does not run the game simulation or validate
physics. The authority is trusted. A dedicated game server, host migration,
and WebRTC transport are not implemented. Running sessions accept late
spectators from a full current checkpoint. Authenticated resume credentials
preserve seats across transport disconnects. A guest can reload and restore
from the checkpoint; the authority must retain its original simulation tab.
Authority disconnection pauses clients for up to 120 seconds. Deliberate
authority departure ends the session; shared restart creates a fresh epoch.
Guest departure leaves a neutral, fixed controller seat without stopping the
other players. An explicit whole-session restart removes disconnected seats.

Shared implementation:

- `static/js/netplay/authoritative.js`: fixed-step sessions, local input
  prediction, authoritative acknowledgements, restoration/replay of pending
  inputs, buffered remote-state interpolation, and bounded historical snapshots.
- `app/netplay/authoritative.py`: input/state shape limits, ordering,
  acknowledgement checks, pending-input limits and snapshot clock bounds.
- `/retro` relay events `fps_command` and `world_snapshot`: only players send
  commands, only slot zero sends snapshots, and spectators receive snapshots.
  Membership supplies the input slot; clients cannot impersonate another seat.
- The existing shared iframe bridge exposes `advance()` and `render()` for FPS
  runtimes. These supplement the existing lockstep and rollback hooks.

### Registering a game

Set `Game.backend='authoritative-host-v1'`, `input_schema='fps-command-v1'`, and
choose a fixed `tick_rate` from 10 to 120, with at most 8 players. The catalog
fingerprints the backend and publishes its timing settings. At 60 Hz the
baseline is 20 snapshots/second, a 6-tick interpolation delay, 120 ticks of
history, a 12-tick maximum rewind, and at most 64 pending commands per player.
The transport is currently the existing reliable Socket.IO relay. Packet loss
may therefore delay newer updates; this is a baseline, not a claim of optimal
FPS performance over poor connections.

Each input is `{buttons, moveX, moveY, lookX, lookY}`: buttons are a 16-bit mask,
movement is signed integer -127..127, and look deltas are signed integer
-32767..32767. The game adapter defines button meanings and look sensitivity.
Packets additionally carry sequence, rendered world tick and epoch. Missing
commands use neutral input rather than repeating fire/reload/look deltas.

### Runtime adapter contract

Call `bridge.loaded(options => adapter)` after runtime initialization. The
options include `slot`, `players`, `spectator` and `isAuthority`. Do not return a
Smash rollback adapter. Supply these synchronous methods:

- `sampleInput()` returns a command, including accumulated mouse or second-stick
  aim. Use the shared `FpsInput` collector described below.
- `captureLocal()` / `restoreLocal(state)` serialize and restore every piece of
  local state needed to replay movement: velocity, stance, collision state, etc.
- `simulateLocal(command, dt, {replaying, seq, emitEffect})` predicts one local step. Replays
  must suppress duplicate sound, particles and other irreversible effects.
- `selectLocalState(world, slot)` extracts authoritative local simulation state.
- `interpolateState(older, newer, alpha)` interpolates render state only. Use
  stable entity IDs, shortest-path angle interpolation, and explicit handling
  of spawn/despawn/teleport events; never lerp health or inventory blindly.
- `renderState(remoteWorld, localPredictedState)` combines smoothed remote
  entities with the immediately responsive predicted local player. Spectators
  receive null local state. Interpolated state must not overwrite simulation.
- Optional `onReconcile(before, after)` allows game-specific visual correction
  smoothing without changing the corrected simulation. `destroy()` cleans up.
- `createAuthority()` (slot zero only) returns a SEPARATE simulation instance
  with `step(commands, dt, context)`, `captureState()` and optional `destroy()`.
  A WASM game must provide separate state/instances, not alias the visible client.

World snapshots must be bounded JSON objects, at most 64 KiB, with finite
numbers and no pointers, typed arrays, cycles or executable data. Per-game
schemas, entity IDs, authoritative movement, collision, damage, inventory,
projectiles, AI and objectives belong to the adapter. The framework does not
invent those rules or prove an adapter deterministic.

Poll `bridge.advance()` at fixed-step boundaries (it enforces pacing); call
`bridge.render()` at display cadence. Catch-up is bounded. A stalled client
stops adding predictions when its pending-input budget fills and fails after
30 seconds without authoritative snapshots. No guessed world extrapolation is
performed after the latest snapshot.

### Lag-compensated hit validation

The authority's `step` receives `{tick, packets, rewindFor(slot)}`. For a new
shot command, query `rewindFor(slot)` to get a cloned historical state bounded
to the configured rewind window. It never mutates the live world. The game must
validate weapon cooldown, ammo, shot origin/direction and hitboxes, perform its
own hit test, and apply the accepted damage to CURRENT state. Missing history
returns null. Clients do not choose damage or confirm their own hits. Historic
hitboxes and dynamic obstacles must be included in the adapter's state where
its hit rules require them. This is shared rewind infrastructure, not completed
Perfect Dark weapon synchronization.

### Validation

`node tests/games/authoritative_core.cjs` covers prediction corrections, delayed
messages, bounds, interpolation, hit-history isolation, spectators and epochs.
`python tests/games/authoritative_test.py` covers the authenticated relay,
authority spoofing, malformed/oversized snapshots, sequence limits and restart.
For real browser/Socket.IO integration, run the isolated fixture with
`python tests/games/retro_test.py --serve --authoritative`, then
`node tests/games/authoritative_browser.cjs`. This flag replaces MK64 only inside
the test catalog; the browser test supplies a small movement/collision fixture,
not actual MK64 or Perfect Dark simulation. It exercises two predicted clients,
a spectator, authoritative collision corrections and a complete shared restart.
It also covers a late spectator, guest and authority transport reconnects,
a guest page reload preserving its seat, and a deliberately dropped application
snapshot whose state and effects recover through the real relay. All browser
contexts run locally; this is not a separate-internet-connection performance test.


### Shared FPS input

`PeakNet.FpsInput({element: canvas, tickRate, ...options})` provides click-to-capture
pointer lock, accumulated mouse look, WASD, dual-stick gamepad movement/aim,
radial movement normalization, deadzone, sensitivity and inverted vertical aim.
Bind adapter `sampleInput` to the collector's `sampleInput()` and destroy it when
the adapter stops. Instantiate it in the canvas's document, including for iframes.
Look units are 32767 per 180 degrees per tick; convert these to engine angles.
Mouse sensitivity is degrees per pixel; stick speed is degrees per second.
Keyboard/mouse state clears on blur, visibility change and pointer-lock changes.
The configurable `actions` map assigns unique power-of-two bits, `key` codes,
`mouse` button indices and gamepad `button` indices. `movement`, `axes` and
`gamepadIndex` are also configurable. These are adapter settings; a game's
settings UI and persistence must pass the chosen values to the collector.

### Ordered gameplay effects

Authority `step` receives `emitEvent(type, data, origin?)`, supporting `shot`,
`explosion`, `pickup`, `death`, and `respawn`. Events receive monotonic IDs and
simulation ticks and travel with the next snapshot over reliable Socket.IO.
The relay validates sequence and bounds atomically with the snapshot: at most
256 events per snapshot, within the same 64 KiB packet budget. Invalid packets
cannot partially advance event or snapshot state. Epoch disposal resets IDs.

For immediate predicted effects call `context.emitEffect(key, type, data)` from
`simulateLocal`. This suppresses replay emissions. The authority can associate
a confirmed effect using `origin: {slot, key}`; the framework derives the input
sequence from the processed command. Use a unique key for each effect within
one input. The client adapter receives `onGameplayEvent(event, context)` once;
matching predictions instead call optional `confirmEffect(event)` without
replaying presentation. The pending prediction cache is bounded to 2048 keys.
Adapters must apply damage/inventory in simulation and snapshots, not again in
these presentation callbacks. Rejected predicted effects need game-specific
cancellation/correction; confirmed hit markers should wait for authority.
Missing delta baselines or event gaps request `world_resync`; the relay sends
`world_recovery` with a full checkpoint and retained presentation events. The
event cache is bounded to 512 entries and 128 KiB. When history has expired or
would exceed the packet budget, recovery restores state and skips expired
effects explicitly. Transport reconnects likewise resume at the current event
cursor, without replaying old effects. Gameplay consequences must be in the
full snapshot: presentation events are not a damage or inventory journal.

### Replication priorities and limits

Snapshots now choose the smaller of full state and top-level changed-record
patches (`baseTick`, `changed`, `removed`). Full keyframes are sent at least every
60 simulation ticks at the next snapshot opportunity. Both the reconstructed
world and complete wire packet must fit 64 KiB. The relay reconstructs and
validates deltas before forwarding the compact packet. Clients require the exact
baseline; a missing baseline requests a full recovery checkpoint. Socket.IO is
an ordered reliable transport, so dropping an application packet in the fixture
tests recovery behavior rather than modeling physical network packet loss.

Use stable entity IDs as top-level records for useful delta savings. Arrays are
replaced whole. The authority adapter may implement `replicationInterval(key)`
returning 1..60 simulation ticks. Defaults are immediate; new records and removals
are always immediate. Use larger intervals only for cosmetic/low-priority state.
Player reconciliation state, hitboxes and gameplay-critical records must remain
at interval 1. The host's rewind history always retains full simulation state.
This schedules updates by importance; it does not automatically trim oversized
worlds, perform per-recipient visibility filtering, or use binary compression.

### Network measurements

`session.diagnostics()` reports measured round-trip latency (from lobby probes),
snapshot wire JSON bytes sent/received, session-average bytes/second, snapshot
count/age, pending inputs, prediction correction count, replayed inputs,
bounded-catch-up stalls, and prediction steps blocked by the pending-input limit.
Bytes exclude Socket.IO/TLS framing. Corrections compare serialized local state;
a game may use `onReconcile` to measure engine-specific position/angle error.
Diagnostics are available to adapter overlays and the developer console; no
production FPS game or diagnostics panel has been registered yet.

`node tests/games/fps_features.cjs` checks focus/reset input behavior, mouse delta
consumption, stick controls, event confirmation/deduplication, update priorities,
record deletion, baseline errors, oversize rejection, and a 300-entity synthetic
world. With only one changing entity, deltas used approximately 2% of full JSON
bytes; this is a sparse synthetic workload, not a Perfect Dark capacity claim.
The real browser fixture also checks six ordered events on both players and the
spectator, metrics, and event ID reset across two match epochs.

## Perfect Dark synchronized inputs

Perfect Dark selects `sync-input-v1` at 60 Hz with `fps-command-v1` commands.
The website assigns seats and spectators; original native menus own settings,
match starts, results and rematches. Match end never stops the room.

Authenticated controller slots submit bounded future inputs (`sync_input`). The
server journals canonical rows and publishes `sync_frames`; `sync_replay` serves
up to 600 rows per request. Clients keep bounded replay buffers, replay from the
shared seed after reload, and activate their existing seat through `sync_ready`.
Resume tokens are bound to the authenticated user. Spectators cannot submit
controller input or stop players by reporting a mismatched hash. Disconnected
seats become neutral; watchers can continue when every player disconnects.

This backend waits for confirmed inputs and does not predict or rewind world
state. Slow active clients or abrupt browser freezes can stall progress. Ordinary
hidden tabs release their own controller with `sync_pause`, then replay into the
retained engine and reactivate through `sync_ready` on return. Stale responses
received while hidden or disconnected cannot reactivate input. Journals live on
temporary disk for the current server process (eight bytes per seat per tick),
with a 24-hour guard. Late joins replay increasing history. Experimental
`authoritative-host-v1` codecs are a separate approach, not a prerequisite.
Local browser tests include injected message delay and a dropped live packet;
real separate-internet validation remains outstanding.

### Yoshi egg desync investigation (October 14, 2026)

The live journal confirms a two-player Smash desync at frame 2880 at 21:29
America/Toronto. The last samples were about 58 FPS with rollback active on
both clients. The journal does not retain the match's inputs or game-state
digests, so it cannot identify the exact gameplay event that diverged.

A reproducible case uses Kirby and Yoshi as human players, Fox as a CPU, and
Hyrule Castle. Identical scripted inputs with and without delayed delivery
first differ at frame 632 on both the installed October 5 runtime and the
pre-fix development runtime. Fox remains in `nFTCommonStatusYoshiEgg` on the
reference but has entered `nFTCommonStatusFall` on the delayed client. This
reproduces a bug with the reported lineup, not the original match itself.

`ftCommonYoshiEggProcUpdate` uses the egg effect's animation to decide when a
fighter escapes. The fighter snapshot retains a pointer to that effect but
does not restore its `EFStruct` or animation. An initial mitigation confirmed
egg frames instead of predicting them; this has been replaced by egg snapshots
in `ports/smash64/rollback_eggs.h` and `rollback_eggs.c`.

Egg snapshots preserve the effect struct, object animation time/flags, lazy
update-process initialization, and DObj/AObj animation trees and tracks. Egg
creation runs during replay; discarded future eggs are removed, and destroyed
eggs retain their allocation until no supported rewind can reference them.
Restoring an older snapshot reactivates the effect and its update process.
Scene/session cleanup releases both live and retired eggs. A dedicated bounded
effect pool keeps cosmetic allocation pressure from changing egg creation.
The fighter checksum now covers egg phase, escape countdown and animation time.

Prediction remains enabled throughout egg capture and escape, with the native
escape logic intact. This does not add recovery from an already-confirmed
desync or change the current session shutdown path.

The combat fixture accepts `SMASH_BUILD` to exercise installed artifacts,
`SMASH_SLOTS=hhco` for two humans and one CPU, and `SMASH_REQUIRE_EGG=1` to
require egg-state coverage. Its adapter comes from the selected build. Missing
hashes fail the comparison; a mismatch saves its first differing digest to
`SMASH_REPORT` (default `.tmp/smash-divergence.json`). Reproduce with the usual
Playwright/browser environment overrides:

```sh
SMASH_BUILD=instance/smash64/build SMASH_FIGHTERS=8,6,1,0 SMASH_SLOTS=hhco SMASH_HYBRID=1 SMASH_SPECIALS=1 SMASH_REQUIRE_EGG=1 SMASH_FRAMES=750 node tests/games/smash_browser.cjs
```

Omit `SMASH_BUILD` after rebuilding/staging to test the local fix. Investigation
evidence is under `.tmp/smash-desync-investigation/`. No runtime was published
to the live service as part of this investigation.

Add `SMASH_REQUIRE_EGG_ROLLBACK=1` to require prediction inside eggs, native egg
restores, recreation during replay, revival after speculative destruction, and
discarding future eggs. `SMASH_REQUIRE_EGG_CLEANUP=1` instead requires stopping
while an egg is live and verifies repeated shutdown frees its allocations.

The 750-frame snapshot regression passes every confirmed checksum with 232
predicted egg frames, 18 egg restores, one replay creation, one revival and one
discarded future egg. A 600-frame case passes with two eggs still live at
shutdown and verifies repeated cleanup releases all egg allocations. A
four-human-player case with two Yoshis passes all 1,000 confirmed frames and
37 rollbacks. Shared rollback core, coroutine barrier, and Smash adapter
checks also pass.

The initial egg-only snapshot build's 3,600-frame test failed at frame 3210 with differing
RNG, Fox input and item digests, matching the separate unresolved divergence
seen with the initial confirmation-only mitigation. Before that mismatch it
exercises 365 predicted egg frames and 25 egg restores. Results are saved in
`egg-snapshot-long.json` and `fixed-long.json`; `development.json` records the
original frame-632 failure. The subsequent animation audit below addresses that
separate mismatch. The exact input history of the reported live incident was
not available, so these are deterministic reproductions, not a replay of it.

### Animation rollback audit (October 15, 2026)

The native VS audit covers fighter figatrees and motion/color scripts, joint and
material tracks, item and weapon animations, stage actors and collision,
effect ownership, camera animation, particles, accessories and interface
visuals. The fixes below are local; the installed runtime has not been replaced.
This is a source and allocation-lifetime audit with deterministic runtime
regressions, not exhaustive play of every move, costume or item combination.

| Animation state | Disposition |
| --- | --- |
| Fighter motion/status and color scripts | Inline `FTStruct` state, joint transforms, script cursors, animation roots, interpolation tracks and stable animation-file storage are captured. |
| Fighter joint metadata | Capture includes `FTParts` animation-enable flags and transform caches plus DObj display-list selection. Hidden joints and replaced tracks retain allocation identity through the rewind window. |
| Material animations | Full `MObj` state, scripts, texture/palette/color values and all 15 supported tracks are captured. Replaced materials are retained, revived or discarded with the restored tree. |
| Stage animation and collision | Ground and GroundDisplay animation clocks and trees are captured, including collision DObjs. Yoshi's Island cloud material timing controls collision and is now captured and hashed. Ground obstacle/hazard registrations and Saffron's previous monster attack selection are captured too. Native-flow confirmation barriers protect Hyrule's dynamic ground-object creation/removal; destruction now clears the tornado owner pointer. |
| Item and weapon animations | Inline controller state, joint/material animations and display callback/layer selection are captured. Poké Ball monster selection history is captured. Pooled structs are initialized on allocation so replay cannot inherit stale collision fields from a previous occupant. |
| Item pickup/release trees | Pickup inserts a temporary root DObj; release removes it. Snapshots now restore the GObj's root pointer, discard speculative pickup wrappers, and retain released wrappers and their transform allocations for revival. Held-item destruction preserves rollback lifetime while clearing the holder's logical item state. Pickup arrows stay alive with their item and are freed on actual collection. |
| Yoshi capture egg | Captured effect/controller, phase and escape timing, joint animation, lazy update process and allocation lifetime. Prediction remains enabled during egg capture. |
| Gameplay-linked model effects | `rollback_effects.h/.c` retain and restore effect controllers, lazy processes, animation clocks and joint/material trees. Constructors run during replay and use a pool independent of cosmetic particles. The selected descriptors cover shields, Fox reflector, Samus grapple glow, Pikachu smash effect, Falcon Punch/Kick, Sing, all four Cutter effects, Ness magnet/thunder wave and both final trail forms, Yoshi escape, Link spin, Kirby capture star, rebirth halo, fire spark and Poké Ball rays. |
| Camera and quake | Full CObj controller, projection, script cursor and ten tracks are captured alongside GMCamera state. Quake producers now have the same effect/animation/lifetime support, so restoring the camera also restores its shake source. |
| Cosmetic particles | Not rewound. Kirby inhale and capture-release commands no longer depend on particle allocation success. Stage particle handles preserve current live allocations across restore and are invalidated on transform free. Hyrule tornado gameplay no longer depends on particle allocation succeeding. Particle/effect RNG and crate/barrel debris RNG are isolated from gameplay randomness. |
| HUD, wallpaper and costume accessories | Presentation-only animation remains outside complete rewind. Item-arrow ownership is tied to the retained item. Costume accessory allocator links are preserved rather than resurrecting freed presentation objects. Menus, pause/results and 1P cinematics are outside speculative VS rollback. |

Five independently reproduced failures guided the audit:

- Yoshi's capture egg escaped at a different time because its animation and
  allocation lifetime were outside the snapshot (first mismatch at frame 632).
- Kirby's Final Cutter consumed an animation command only when its effect
  constructor succeeded. Replay suppressed that constructor (frame 497).
- A PK Thunder trail inherited stale collision fields from a reused weapon slot
  (frame 506 after correcting Cutter). The full pool initialization fixes this.
- Fox picked up an item before a rewind. Restoring the pre-pickup fields left
  the pickup wrapper as the item's root, moving its apparent position from
  `(-750, 1258)` to `(0, 0)`. The CPU then chose a different action and consumed
  three additional random numbers (frame 3210). Root restoration addresses the
  underlying item state, rather than adjusting the CPU or masking the checksum.
- Hyrule kept a pointer to its freed tornado. At frame 3215, the stage checksum
  followed that pointer into a recycled effect object whose animation differed
  between runs. The stage now clears its owner pointer when destroying the
  tornado; the checksum still includes every live tornado's state.

`SMASH_REQUIRE_MATERIALS=1` now verifies joint transforms, animation cursors and
tracks, materials, fighter metadata, effects/processes, item roots/display
state, stage registrations, selection history and camera state immediately
after every restore, before replay. It also checks retained material, effect
and detached-item-root allocations are empty after repeated shutdown.
`SMASH_ANIMATION_MOVES=1` supplies shield, directional-special, jump and attack
inputs. Confirmed gameplay checksums are compared every frame. These hashes
cover a subset of state; the additional restore checks are necessary.

The reproducible browser matrix is:

```sh
node tests/games/smash_animation_audit.cjs
```

Build and stage the WASM fixture first. Set `PLAYWRIGHT_MODULE` and
`BROWSER_EXECUTABLE` if they are not available at their default locations.
`SMASH_AUDIT_OUTPUT` selects the evidence directory and `SMASH_AUDIT_WORKERS`
selects one to three browser workers. The matrix covers all nine stages and
all twelve fighters for 900 frames per case, the 3600-frame Kirby/Yoshi/CPU Fox
regression, shutdown with live eggs, and the native-flow hybrid effect path.
An additional 3600-frame native-flow Hyrule case must exercise a confirmation
barrier around a tornado transition.
The long case must exercise both egg rollback and item-root restoration.

All 13 scenarios pass on the final local WASM build: nine stage cases, both
3600-frame Hyrule cases, live-egg cleanup, and hybrid effects. Each long case
performs 194 rollback corrections. The egg regression also records 365 predicted
egg frames, 25 egg restores, recreation/revival/discard of speculative eggs,
27 effect restores and an item pickup root restoration. The live-egg test ends
with two eggs and verifies zero remaining egg allocations after repeated shutdown.
Shared rollback, coroutine-barrier and Smash adapter tests pass; generation is
idempotent and temporary tracing has been removed. The installed WASM checksum
is unchanged.

Evidence is kept under `.tmp/smash-desync-investigation/animation-audit/`.
The `verified/` run records the final changes; earlier failing reports are
retained as reproduction evidence. Runtime exceptions, confirmed checksums,
restore checks and allocation cleanup are checked separately. The fixture does
not promise pixel-identical particles. Native suspicious-display-list/token
warnings also reproduce in the installed build independently of these changes.

### Targeted gameplay state-change regressions

`node tests/games/smash_gameplay_audit.cjs` runs 32 input-driven cases against
the local native-flow hybrid WASM. Optional case-name arguments select a subset;
`SMASH_GAMEPLAY_OUTPUT` selects the evidence directory. Build/stage the fixture
with the commands above first. The new `peak_rb_gameplay_details` export is
read-only and pointer-free: it reports fighter kind/status/position, facing,
held-item kind/ammo, Kirby's copied ability, capture relationships, stocks and
hurtbox/invincibility state. No gameplay mutation exports were added.

Each case first records a confirmed-input controller history, then replays that
identical history with the second player's inputs delivered three scheduler
attempts late after frame 400. Alternating dead-zone axis values force real
corrections even while the opponent stands still. Ordinary controller inputs
perform the moves. Existing item-preview environment options only establish the
item fixture before delayed delivery begins. No test edits fighter memory.

All confirmed per-frame checksums and the diagnostic gameplay fields must agree
between runs. Each restore must immediately reproduce its captured gameplay
fields and pass the existing material, tree, effect and item-root verifier.
Coverage assertions require the named event to occur and a rewind to cross it;
missing coverage fails the test. Repeated shutdown must clear retained
materials, effects, eggs and detached item roots.

| Case | Frames per run | Confirmed coverage in the delayed run |
| --- | ---: | --- |
| Held bat throw | 1000 | Rewind crosses release at frame 505. |
| Death with held bat | 1400 | Held-item destruction at 570, death, respawn and invincibility all replay correctly. |
| Ground-item pickup and throw | 1200 | Rewind crosses pickup at 451 and release at 517. |
| Hammer pickup and expiry | 1600 | Rewind crosses pickup at 451 and timed destruction while held at 1177. |
| Mario grab and throw | 1000 | Both fighters' capture relationships, throw and victim's thrown state are exercised and rewound. |
| Kirby copies Fox | 1600 | Inhale/capture, copy gain at 575, copied blaster use and taunt-induced copy loss at 780 are exercised and rewound. |
| Kirby Stone | 1000 | Stone hold and exit are exercised and rewound. |
| Ray gun ammunition and disposal | 1400 | All 16 ammo decrements, projectile lifetimes, empty ammunition and release at 935 are exercised and rewound. |

The original eight cases passed 20,400 total simulation frames across reference/delayed
pairs and 6,993 corrections. No new desync or runtime exception was found in
these runs; no gameplay fix was needed. Evidence, exact build/source hashes and
per-event rewind coverage are consolidated in
`.tmp/smash-gameplay-audit/verified-summary.json`. Earlier missing-coverage runs
are retained separately; they are not counted as passes. These targeted cases
use Dream Land and selected fighters/items, not every gameplay combination,
browser or networking failure. The diagnostic build remains local; the installed
WASM has not been replaced.

### Extended gameplay audit

The additional 24 cases live in `tests/games/smash_gameplay_extended.cjs` and
cover the six remaining groups:

| Group | Cases and required transitions |
| --- | --- |
| Stored charge | Samus, DK, and both Kirby copies: partial charge, cancellation, retention, release, full charge/release, then death and charge reset on respawn. |
| Projectile ownership | Fox reflection changes the owner; Ness enters the absorb-hit state; Link's boomerang reverses and returns to its owner. |
| Shield and damage | Shield drains and breaks, stun ends; knockdown enters a recovery roll; hits interrupt a charging special and grab attempts. |
| Ledges and platforms | Ledge catch/invulnerability followed by climb, attack or roll; platform drop-through/landing; a neutral fighter rides a moving Kongo Jungle platform. |
| Spawned items | Damaged crates/barrels break into randomly selected utility items; Poké Balls create Pokémon; Bob-ombs enter their explosion callback; green/red shells move after release. |
| Overlapping lifetimes | A held bat is destroyed on death while the owner's fireball survives; Kirby loses a copied Link ability while its boomerang remains active. |

`peak_rb_gameplay_extra` is another read-only, pointer-free diagnostic export.
Its first 128 words contain four 32-word fighter records: charge levels, shield
health, damage/hitlag, grounded state and floor ID, ledge state, stun/reflect/
absorb/shield flags, invincibility, healing, boomerang presence, velocities and
jump/ledge timers. Word 128 is the live-item count. Each item then contributes
12 words: kind, player, timer, damage, grounded state, attack state (bit 8 marks
a Bob-omb explosion), position and velocity. Tests compare these fields at
capture/restore and after every replayed frame. They also compare normalized
weapon fields, including ownership, collision attack state and velocity.

The evidence files retain both runs' exact controller inputs, confirmed hashes,
per-frame diagnostic state and rewind intervals. Passing reports include the
WASM and test/generator source hashes. Reference runs fail early if the script
did not produce every required event; delayed runs additionally require a
rewind crossing each event. No missing-event run is counted as a pass.

Container fixtures use `SSB64_PREVIEW_ITEM_KIND` to choose only the initial
item. Unlike `SSB64_FORCE_ITEM_KIND`, this leaves normal weighted drops and RNG
active. Heavy items must start on the ground: the existing direct-hold preview
bypasses the heavy-pickup animation's attachment setup and can hang before the
match starts. The test configuration rejects that unsupported combination.

An intermediate generator edit for the new preview option accidentally
replaced the existing item-pool zero-initialization patch. The crate regression
caught a checksum mismatch at frame 485. The generator now composes the patches
and checks that initialization is retained. This was an audit-introduced
regression, not a newly discovered defect in the previously tested build.

Final validation passes all 32 cases (24 new plus the original eight):
89,200 reference/delayed timeline frames and 31,761 rollback corrections. Every
required event has nonzero rewind coverage. The final verifier rechecks the
recorded inputs, every confirmed hash, both diagnostic exports and all required
coverage against the saved evidence. No additional gameplay-state omission,
desync or runtime crash reproduced on the corrected build. The original
600-frame Kirby/Yoshi/Fox-CPU live-egg shutdown regression also passes, including
repeated cleanup, as do the rollback core, confirmation-barrier, native adapter
and phase-buffer checks. Generator output is byte-idempotent across 39 files.

The complete manifest is `.tmp/smash-extended/verified-summary.json`; individual
reports and both-run recordings are under `verified-*`. The successful barrel
retry replaces its initial missing-coverage result. Earlier failed setups and
the intermediate generator regression remain separate and are not counted as
passes. Each execution report records its source hashes; the consolidated
manifest also records the final coverage-verifier hashes.

The validated WASM is
`93290c1c9c0ee8ad0239a0d70c0ab9cdf9073992e2e76f91b48b53c45ed34835`.
The installed WASM remains
`a1245c890a57f40c5174e4634a8baed67bda594664718b6a2836414696766c03`;
nothing was published. These runs use Chromium, mostly Dream Land, with Kongo
Jungle for the moving platform and Hyrule for the egg regression. They cover
the listed transitions, not every fighter/stage combination, random seed,
browser or network failure.

## Rollback desync handling

A confirmed checksum mismatch in a `rollback-v1` room now ends the match and
returns connected players and spectators to the same lobby. The server records
the build, mismatching frame and checksums by seat before clearing the old
session. It increments the epoch, preserves room membership, seats, roles,
settings and invite, and resets readiness. Late inputs, failures and checksums
from the discarded epoch cannot stop the next match. Other backends retain
their existing failure policies.

The browser exits fullscreen, closes the old runtime and presents a clear
interruption notice with a diagnostic download. The report captures the game
build, epoch/frame, seat checksums and local timing/rollback counters before
history is disposed; it excludes room/member identifiers, controller inputs,
credentials and game snapshots. A native destructor failure does not prevent
the remaining input handlers and iframe from being released. Stale server stop
events cannot overwrite the returned lobby or a newer match.

This is graceful match termination, not automatic in-match resynchronization.
The relay does not run an authoritative Smash simulation, and native snapshots
contain instance-local pointers. A trustworthy cross-instance state-transfer
protocol is separate work. Players can ready up and start again without
reloading the website. These changes are local and have not been deployed.

Checks:

```sh
.venv/bin/python tests/games/rollback_desync_test.py
# In a separate terminal, using the locally built/staged Smash fixture:
.venv/bin/python tests/games/retro_test.py --serve --smash --port 8068
node tests/games/smash_desync_browser.cjs
```

The server regression covers four players plus a spectator, readiness and host
authorization, old-epoch packets and a healthy next match. The real Chromium
test uses two independent Smash instances plus a media spectator, deliberately
flips one transmitted checksum at frame 360, injects a destructor failure, checks
fullscreen exit and report downloads, and starts a healthy second match in the
same room. Desktop and mobile lobby screenshots and reports are saved under
`.tmp/smash-desync-handling/`. The test fixture alone skips menus to enter battle;
the shipping runtime's startup is unchanged.

The final local checks also passed a mixed Chromium 153 / Firefox 155 session:
both returned to the lobby after the injected frame-360 mismatch and agreed on
the new match's confirmed frame-480 checksum. Set `SMASH_MIXED_BROWSERS=1` and,
if needed, `FIREFOX_EXECUTABLE` to repeat it; `SMASH_DESYNC_OUTPUT` selects its
report/screenshot directory. This short check does not establish determinism
for every browser/device/move combination.

The updated online suite validates player simulation checksums and actual
spectator video pixels separately. It also reports an automatic desync return
as an immediate failure, rather than waiting on a disposed simulation. Run
`node tests/games/smash_suite.cjs baseline latency soak` against the fixture;
`SMASH_URL` selects its URL and `SMASH_SUITE_OUTPUT` isolates the reports.
The results in `.tmp/smash-desync-handling/online/` are:

| Scenario | Result |
| --- | --- |
| Normal online session | 3600 frames; two completed matches with pause/resume, results and rematch; player hashes match and spectator video is present. |
| Added 85 ms delay, 20 ms jitter and 250 ms bursts | 3600 frames; matching hashes with actual corrections and confirmation barriers. Overall scenario progression is about 24 frames/sec, including menus and transitions, so synchronization passing is not a smoothness guarantee. |
| Repeated rematches | 18000 frames; twelve completed matches and thirteen battle entries; matching final hashes. Warm native allocation variation is at most 370872 bytes across the sampled battles, within the existing 8 MiB test bound. This bounded check does not prove the absence of small leaks. |

Phase timing was subsequently added to `tests/games/smash_netplay.cjs`, charging
elapsed time between attempted updates (including waits) to native scene/status
and recording stall reasons. The repeat reports are in
`.tmp/smash-phase-timing/{baseline,latency}.json`. Both runs passed synchronization
and spectator checks with the same local build:

| Phase | No added latency | 85 ms delay + 20 ms jitter + 250 ms bursts |
| --- | --- | --- |
| Active fighting (`scene=22`, `status=Go`) | 57.2–57.6 updates/sec | 54.3–54.7 updates/sec |
| All other phases combined | 56.1–56.2 updates/sec | 22.3 updates/sec |
| Entire scenario | 56.3 frames/sec | 24.0 frames/sec |

These are simulation-throughput measurements, not displayed-frame measurements.
The scripted scenario spends only about 12% of its frames in active fighting.
Menus, countdowns, pause and ending sequences require confirmed inputs because
their coroutines are outside the battle snapshot. With one frame of input delay,
their input pipeline cannot sustain 60 Hz under the injected delay; adapter
confirmation waits dominate the slowdown. Fighting uses six frames of prediction
(about 100 ms at 60 Hz) and bounded catch-up. Its smaller slowdown includes
prediction-window and transition-confirmation stalls during the stress profile.
An average of 54–55 does not establish smooth frame pacing. This initial timing
investigation did not alter runtime behavior; the following change addresses the
confirmed-phase bottleneck.

### Input buffering during confirmed phases

Smash now advertises `confirmedInputDelay: 8` alongside its existing
`inputDelay: 1`. The adapter selects the longer pipeline for native menus,
countdowns, pause and ending sequences. Active fighting (`scene=22`, `status=Go`)
keeps the one-frame setting even when a temporary topology barrier prevents
prediction. Single-player sessions and adapters without phase detection keep
their base delay. No native snapshot or WASM changes are required by this change.

The session fills every unsent frame in order when the pipeline expands. On
returning to fighting it drains those committed samples before sampling at the
shorter lead; it never replaces or drops input already sent to another player.
The edge queue preserves brief presses/releases during expansion. Transport
backpressure limits new sends but allows previously buffered input to be
consumed. Relay-only rooms allow the agreed larger window too. Diagnostics expose
the phase's requested input delay and the remaining buffered input count.

This is an explicit responsiveness tradeoff: menus buffer roughly 133 ms at
60 Hz, and the larger buffer briefly remains while entering combat. It avoids
slowing the whole menu simulation to network-delivery speed. It does not predict
unsupported native coroutines or increase the six-frame rollback window.

The repeat reports in `.tmp/smash-phase-buffer/{baseline,latency}.json` use the
same local WASM and the same two-player scenario with a media spectator:

| Phase | No added latency | 85 ms delay + 20 ms jitter + 250 ms bursts |
| --- | --- | --- |
| Active fighting | 58.0–58.4 updates/sec | 54.1–54.2 updates/sec |
| All other phases combined | 56.5–56.6 updates/sec | 53.6–54.0 updates/sec |
| Entire scenario | 56.7 frames/sec | 53.7–53.8 frames/sec |

Both sessions completed two matches, including native pause/resume and rematch,
with matching player checksums and working spectator video. Overall progression
under the stress profile rose from about 24 to 54 frames/sec. Combat's remaining
prediction-window stalls still need longer frame-pacing measurements; this change
does not claim to eliminate them. The changes are local, not deployed.

`node tests/games/rollback_phase_buffer.cjs` checks immutable, contiguous input
history, queued press/release edges, draining on a phase change, transport
backpressure and compatibility with solo/default/spectator sessions. Catalog and
relay tests cover negotiated bounds and the larger relay-only input window.
The real-game regression runs also passed native pause/quit, four-player teams,
and an intentionally closed RTC channel during the delayed match (both seats
reconnected and finished with matching checksums). The Chromium/Firefox desync
test passed lobby return and a fresh healthy match with the new buffering;
evidence is under `.tmp/smash-phase-buffer/regressions/`, `rtc-recovery.json` and
`mixed/result.json`.

The targeted gameplay suite above now covers item release, held-item destruction
and the listed ability transitions. Further combinations, background-tab
behavior, and longer runs across browser/device pairs remain broader coverage
work; one forced peer-channel recovery has passed.

## Automatic session diagnostics

All games in the shared Retro Games lobby use `telemetry.js`. Every ten seconds,
players and spectators send a small `diagnostics` Socket.IO report. The monitor
only reads counters: it never changes input, simulation speed, prediction or
rendering. Disconnected clients discard reports rather than buffering uploads.
No controller inputs, game snapshots, credentials, account names or IP addresses
are included. The server adds room name/code, game, epoch, role and seat; a hashed
connection identifier distinguishes spectators. Journal retention follows the
existing system journal policy.

`gameFps` measures progression of the session frame counter over elapsed wall
time. `displayCallbackFps` measures top-page animation callbacks, not actual GPU
renders. `noProgressMs` samples visible, running intervals with no frame progress
at 250 ms resolution; this is not proof that a pause was network-induced.
Hidden, loading/disconnected and replay/catch-up time are classified separately.
RTT average/max and timeouts come from the existing latency probe. Reports include
transport, input-buffer size, confirmed frame and cumulative rollback count.
These are client-reported diagnostics, not authoritative performance guarantees.

Server events log loading, loaded, start, disconnection, reconnection, client
failure and hash-detected desync. A game only detects the state covered by its
existing hash; the reporter does not make hash coverage complete. A spectator
mismatch in synchronized games is logged separately from a room-wide desync.

Watch live after activation:

```sh
journalctl -u peakdecline.service -f -o cat | rg '^NETPLAY '
```

Summarize a particular room's recent session:

```sh
journalctl -u peakdecline.service --since '30 minutes ago' -o cat --no-pager | .venv/bin/python tools/netplay_report.py --room test2
```

The summary separates room epochs and peers, and excludes windows with more than
250 ms of loading, hidden or catch-up time from normal-play FPS. RTT is round trip
to the server, not end-to-end controller response time. A missing report is not
zero FPS. The server validates fixed fields and ranges, requires authenticated
room membership/current epoch, and accepts at most one report per peer per five
seconds. Reports are never broadcast to other clients.

Validation: `telemetry_core.cjs`, `telemetry_test.py`, and an isolated native
`telemetry_browser.cjs` run. This baseline was staged without restarting the live
service. Activation requires a service restart followed by refreshed game pages;
existing pages and rooms do not acquire telemetry automatically.

## Smash release qualification, October 15

The follow-up candidate is
`aaf68a425a85016b65f7338dfd3e258ce3b5084001bf303a6be4ec9d6d16ab2d`
(WASM SHA-256). It includes the preceding gameplay-state fixes, the explicit
64-bit item pointer guards, and the correction to the display-list diagnostic.
The source generator is byte-idempotent across all 40 generated files.
WebAssembly's item-destruction behavior was already correct: casting 4 GiB to
`uintptr_t` made the old threshold zero. The new conditional removes that
implicit truncation and excludes the diagnostic's eight-byte pointer read.
The display-list warning was a diagnostic false positive, not evidence that
those live display lists were stale; genuine token-generation checks remain.

Rollback rooms now also return connected participants to the same lobby when
a runtime fails or a player leaves/disconnects. Remaining seats are reseated,
a departing host is replaced, readiness is cleared, and the epoch advances.
Late failure packets cannot stop the next match. A disconnected player must
reconnect and rejoin; there is no claim of retaining their live simulation.
Interruption reports distinguish desync, runtime failure and departure.

Qualification artifacts are under `.tmp/smash-release/`. The first 9,000-frame
rules test matched all clients but failed its requested five-match coverage:
the scripted walk-off stopped finishing matches on a moving-platform stage.
Its replacement requires three completed matches and includes the fourth
battle; it passes. The original lifecycle-freeze command was insufficient
evidence of a paused renderer. The dedicated suspension check instead uses
`Debugger.pause`, observes its paused event, and verifies that the other peer
cannot advance beyond a bounded input/prediction window before resuming.

The 18,000-frame mixed Chromium 153 / Firefox 155 run completed 12 matches and
entered a thirteenth. It averaged about 56.5 simulation updates/sec with the
85 ms delay, 20 ms jitter and 250 ms burst profile. After warm-up, native
allocation variation was 370,840 bytes on Chromium and 370,080 on Firefox;
both retained a 256 MiB WASM heap. This bounds the tested run, not every
possible leak over an arbitrarily long session. Spectator presentation was
about 45.6 video callbacks/sec, with a 33.3 ms 95th-percentile callback gap;
the video receiver reported no dropped decoded frames. Callback presentation,
decoded video, simulation updates and physical display FPS are distinct.

Four-player mixed-browser teams also passed with every third incoming RTC
packet discarded, 85 ms delay, 20 ms jitter, periodic 1,000 ms bursts, and one
forced channel closure. Both affected peers reconnected; all four players
finished frame 3,600 with the same hash. This harsh profile averaged only
37 simulation updates/sec (about 34 in combat). It is a correctness/recovery
pass, not a performance pass. The input/prediction limits intentionally stop
unconfirmed simulation during long outages rather than predicting seconds
of gameplay. These tests run browsers on one machine with software rendering;
they do not substitute for separate physical devices and internet links.

Automatic in-match state resynchronization remains a separate architecture
change. The relay currently authenticates controller input but does not run
the game, so it cannot decide which divergent peer state is correct. Two
players provide no majority. Native rollback handles refer to local object,
animation, resource and function addresses; transferring their bytes to a
different WASM instance would be unsafe and incorrect. A future design must
either serialize a versioned, pointer-free state with stable object/resource
IDs and an explicit authority policy, or reconstruct every client from the
same initial save/seed and a bounded server-owned input journal. Either path
needs a shared freeze/resume barrier, independent post-recovery checksum
agreement, strict size/time limits and a one-attempt fallback to the lobby.
No arbitrary peer snapshot is accepted by this release.

The final performance controls use 3,600-frame native flows with matching
player hashes and an active spectator. With no injected network delay, the
two Chromium clients averaged 57.15 simulation updates/sec; with a fourfold
CPU-throttling factor on the host, they averaged 35.33 and 34.64. The host's
baseline native snapshot work totaled about 20 ms and native replay work
about 2.7 ms over the whole minute; these counters do not include rendering
or all browser work. This is evidence against rollback computation itself
being the dominant cost in that control, not a complete renderer profile.
Spectator presentation varied substantially with browser/CPU load (about
28.4 callbacks/sec in the Chromium baseline and 18.7 under CPU throttling).
No 60 FPS guarantee is claimed for these software-rendered multi-browser
runs or for untested physical devices.

The real offline-browser test returned the connected player and spectator
to the same lobby after 30.7 seconds, rejoined the disconnected account, and
verified matching player hashes at frame 600 of the next epoch. Desync and
injected runtime-failure tests independently verified same-room restart and
matching frame-480 hashes. The test fixture now explicitly uses a temporary
save database even when it serves assets from the installed instance folder.

All 18 qualification groups passed: the long rules run, 13 main qualification
jobs, and four final controls. These include the five affected item scenarios,
three 3,600-frame mixed-browser/AI stage comparisons, and a mixed-browser Ness
absorption regression; together the mixed-browser fighter sets include all
12 playable characters. Every required confirmed-frame comparison passes.
The dedicated 10-second debugger suspension produced an observed 10,132.93 ms
animation-callback gap, bounded the other peer's progress, and resumed to
matching states through native pause/results/rematches. Eleven core/server
suites and the 18-test shared lobby suite also passed. The new candidate does
not rerun all 32 earlier isolated transition cases: it reruns affected item
paths and adds the integration, browser, failure and performance coverage
described above. `.tmp/smash-release/release.json` records the verified source
and artifact hashes and activation status.

Activation completed on 2026-10-15 through the administrator helper. The
production service is active, its login endpoint returns HTTP 200, and every
installed native artifact and runtime source matches the qualified manifest.
The installed WASM SHA256 is
`aaf68a425a85016b65f7338dfd3e258ce3b5084001bf303a6be4ec9d6d16ab2d`.
The previous native bundle is retained in `.tmp/smash-release/installed-before`.

The installed-build Chromium/Firefox smoke test passed using the isolated
server fixture and installed native assets. It injected a frame-360 desync,
contained a destructor failure, preserved two players and one spectator in
the lobby, downloaded diagnostics, ignored a stale stop, and verified equal
frame-480 hashes in the next match. Evidence is recorded in
`.tmp/smash-release/installed-smoke/result.json` and the release manifest.
This does not substitute for a separate-device match over real internet
connections. Automatic in-match resynchronization remains a separate feature;
confirmed desyncs and runtime failures currently recover to the lobby.

Reverified on 2026-10-16 alongside the Mario Kart visual release: all 11 installed
native artifacts and 49 runtime files still match the qualified manifest. The
active production service started after the Python changes and returned HTTP
200. A fresh installed-build Chromium/Firefox desync recovery smoke test passed
with the same lobby preservation and next-match checksum checks; evidence is in
`.tmp/smash-release/installed-reverify/result.json`. No Smash redeployment was
needed.
