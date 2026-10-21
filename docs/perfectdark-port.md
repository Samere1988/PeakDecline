# Perfect Dark browser integration

## Current status

The intended lobby contract is the same as Smash: the website assigns player
seats and spectators and launches one continuing game session. Original game
menus own Combat Simulator settings, arena selection, match start, results and
subsequent matches. A normal match ending must not destroy the runtime or require
a website restart. Native stage epochs may change inside the same room session.
The developer `startCombat` helper is not the production user flow.

Perfect Dark now uses `sync-input-v1`: each device runs the same native WASM
build, ROM, seed and fresh in-memory save. The server orders controller inputs;
engines advance only confirmed frames. This preserves original game handling
without whole-world snapshots or prediction. Native typed restore experiments
below remain research utilities, not dependencies of this selected backend.

Implemented: up to four fixed controller seats, late spectators, retained-engine
reconnect, and page-reload reconstruction from the session's controller journal.
Disconnected and hidden-tab seats receive neutral input. Returning to the tab
replays missing controller history into the retained engine before reactivating
the same seat. A normal match end keeps the same room
and runtime. Replay suppresses GPU submission and browser audio output while
preserving native simulation, display-list generation and audio mixing.

Local native browser tests cover two matches and arena changes, four-player
setup/results, pickups/firing/reloading, spectator catch-up, player and host
reloads, hidden-tab return using the retained native engine, and missing-history recovery under artificial 80 ms each-way message
delays. Separate native tests cover grenades/explosions/deaths. These checks do
not establish real internet performance or complete coverage of every game mode.
Testing with friends on separate connections remains outstanding.

Tradeoffs: confirmed inputs add latency; a slow active device can pause progress. Ordinary
background-tab visibility changes now release that controller, but abrupt browser
freezes may stall peers until the connection is detected as disconnected. Late join/reload cost grows with session length. The packed
journal uses eight bytes per seat per frame on server temporary disk, with a
24-hour session guard, and does not survive service restart. State hashes cover
exposed components and RNG, not all native memory.

### Activation status (2026-10-04)

The tested native build is installed and the multiplayer catalog is registered.
Installed artifacts match the tested build; isolated lobby/runtime route checks
pass. The production service still runs its previous process: systemd denied
restart because interactive administrator authentication is required. The user
subsequently requested deferring restart while viewers are active; do not restart
until the user authorizes a suitable time. Later, activate
with `sudo systemctl restart peakdecline.service` from an authenticated terminal.
This restart also interrupts other processes managed by that service.
The previous native build is preserved in
`instance/perfectdark/before-sync-input-20261004`.

### Multiplayer regression

```sh
.venv/bin/python tests/games/retro_test.py --serve --perfectdark --perfectdark-sync
node tests/games/perfectdark_sync_browser.cjs
node tests/games/perfectdark_sync_browser.cjs --four
node tests/games/perfectdark_sync_browser.cjs --combat
.venv/bin/python tests/games/synchronized_test.py
node tests/games/synchronized_core.cjs
```

The browser tests use checked-in controller commands, never game memory edits,
to navigate the original menus. Set `PLAYWRIGHT_MODULE` when needed.

## Sources and build

Browser source: https://github.com/retro-foundry/perfect_dark/tree/web-emscripten
Pinned commit: `3ea4f20cbb4658fd0e4aabe4e00d683367fb7d6a`.
Upstream proposal: https://github.com/perfect-dark-pc-port/perfect_dark/pull/757.
`sources.json` records the source and required US Rev 1 ROM MD5. The existing
`static/roms/N64/Perfect Dark (U) [!].z64` matches that revision.

```sh
.venv/bin/python ports/perfectdark/build.py
.venv/bin/python tests/games/retro_test.py --serve --perfectdark
node tests/games/perfectdark_browser.cjs
```

The build discovers CMake/Ninja through `CMAKE`/`NINJA`, PATH or the Python
environment, with the previous Windows tool locations as a fallback. `EMSDK`
overrides SDK discovery; otherwise `.tmp/emsdk` is preferred before the old MK64
SDK directory. On Windows use `.venv/Scripts/python.exe`.
Generated source and build outputs stay in `.tmp/perfectdark`; the pinned
checkout stays in `.tmp/perfect-dark-web`. Windows asset generation explicitly
uses Python. The build also exports the browser filesystem helpers, adds the
read-only engine observations, and routes Web Audio through a master volume.
Source ROMs are read locally and never downloaded by the build script.

`--publish` (or `python ports/perfectdark/publish.py` after testing) installs only runtime artifacts/notices in `instance/perfectdark/build`.
After publishing and restarting Flask for the new route, the authenticated preview
is `/games/retro/preview/perfectdark`. The multiplayer catalog uses the synchronized-input runtime.
Preview starts through the original title/intro flow with a fresh in-memory save,
4:3 viewport, fullscreen and volume. No texture packs, alternate models, modded
weapons or interpolation enhancements are enabled. Preview saves are not persistent.

### Native session-flow regression

`node tests/games/perfectdark_flow_browser.cjs` runs against the isolated fixture
above. Set `PLAYWRIGHT_MODULE` and, optionally, `PLAYWRIGHT_EXECUTABLE_PATH` when
using a nonstandard Playwright installation. `PD_TEST_URL` overrides localhost
port 8066. The test uses two independent two-seat engines, controller commands,
and read-only `observeFlow()` diagnostics. It never calls `startCombat`, writes
game memory, or substitutes website controls for native menus. Reports and
screenshots are written under `.tmp/perfectdark/flow/`.

Two WASM compatibility fixes are necessary for this path. The build uses
Emscripten's `TABLE_BASE=23040` setting so native menu callbacks remain above
the language-ID boundary; recent Emscripten versions override a raw
`--table-base` linker flag with their default. Without this, valid native menu
choices can disappear, including the Game Pak save location. Native label and
selection colour callbacks now use their actual return-valued handler signature
instead of a void alias, preventing a WASM indirect-call trap when the Game Over
screen appears. These changes preserve native menu decisions and behavior.

Verified on Linux with Emscripten 4.0.18 and headless Chromium, October 2026:
two independent two-seat WASM engines followed 10,052 controlled ticks through
fresh-agent creation, Game Pak saving/loading, Combat Simulator Advanced Setup,
second-controller joining, and selecting the original one-minute limit. Both
completed two timed matches, navigated the second player's native pause menus,
dismissed the original Save Player prompt, displayed Game Over, and returned to
Game Setup after each match. The second match used a different arena (stage
50 then 41). Observed state and menu flow matched at each input batch; the same
Module and engine objects survived throughout. Native stage epochs advanced
from 2 through 6. Screenshots confirmed rendered results and the second arena.
The existing controlled-engine and normal preview/audio/volume/fullscreen tests
also passed. The fullscreen smoke test now waits for the asynchronous browser
transition before asserting it.

This validates native session continuity, not online multiplayer. No relay,
spectator, complete world replication, campaign co-op, counter-operative mode,
or persistent save storage is covered by this test. Production room registration
remains disabled until the game-specific multiplayer acceptance checks pass.

## Game-specific networking work

### Shared networking recovery, October 2026

The shared authority backend now supports late spectator checkpoints,
authenticated seat recovery, retained host-tab reconnect, fresh guest-tab
recovery, missing-delta recovery, and a guest leaving without terminating the
remaining session. Framework tests use a small independent test simulation;
they do not demonstrate these features in Perfect Dark. The actual game still
has no production adapter registered with this backend.

The existing typed native restore operations require the same native tick and
stage. They cannot rewind to an older authority checkpoint, bootstrap a new
spectator into an arbitrary arena, or reconstruct a host after page reload.
Full clocks, menus, death/respawn, AI, generic objects, moving geometry and
broader entity allocation remain necessary for a real whole-game restore and
replay implementation. Existing grenade and smoke tests must not be reported
as completion of that work. Per-device simulation remains the chosen approach.

Real separate-internet-connection multiplayer testing remains unperformed and
requires the native adapter first. Local browser relay tests are not evidence
of real-network Perfect Dark performance.

Reference inspected locally: https://github.com/murkantor/perfect_dark_netplay,
branch `port-net-predict`, commit `be4671764bbd97fb698c41852edeec2b4710ead8`.
No code from this fork has been copied into the browser runtime. Its native ENet
transport and expanded game modes are not drop-in replacements for our relay.
Its own `port/src/net/NOTES_PREDICTION.md` records prediction drift and incomplete
state synchronization. In particular, `netCspReconcile` uses position correction;
it does not supply the complete restore/replay contract our backend requires.

Implementation boundaries, based on source inspection:

| Browser game boundary | Required adapter work | Reference to inspect |
| --- | --- | --- |
| `port/src/pdmain.c:mainLoop/mainTick` | Controlled mode now exposes one synchronous tick and completes pending stage transitions before returning. Implement authoritative versus predicted simulation policies on top of this boundary. | Native `netServerStageStart`, `netPlayersAllocate` |
| `port/src/input.c:inputReadController/inputUpdateMouse` | Translate shared FPS action bits, movement and angular deltas into original game control behavior; retain original menu controls. | `struct netplayermove` and command flags in `port/include/net/net.h` |
| Player movement state | Define pointer-free capture/restore including velocity, stance, collision rooms, moving-floor state and timers. Position alone is insufficient. | `netCspReconcile` and its documented drift limits |
| Props, bots and projectiles | Stable IDs, spawn/despawn codecs, animation state, authoritative AI, doors and lifts. Never serialize raw C pointers. | `netPropAssignSyncId`, `netPropFreeSynced`, `netSyncPropSpawn`; `netmsg.c` prop messages |
| Weapon simulation | Host validates ammo/cooldown, performs hit tests with historical geometry, applies damage and emits identified presentation events. | `netLagCompSave/Begin/End`, player stats, damage, pickup and explosion messages |
| Match lifecycle | Synchronize original in-game arena/settings selection, spawn barriers, scores, respawns, match end and restart. | Stage start/end messages and player allocation |
| Browser isolation | Independent authority and predicted-client WASM heaps; rendering must not mutate authority state. | Current port has global C state and an automatic main loop |

Do not register a gameplay-ready lobby with placeholder physics, snapshots that
only contain positions, input lockstep mislabeled as authority, or client-reported
damage accepted as authoritative. The native fork's client hit-report path is
not the authority model selected for Peak Decline.

## Acceptance before multiplayer registration

1. Original intro/title/menu and real Combat Simulator gameplay run in browser.
2. Fixed-step authority and local prediction use separate real engine state.
3. Two players see matching collisions, shots, ammo, pickups, deaths and respawns.
4. A spectator sees the same match and sends no gameplay input.
5. Delayed inputs correct without duplicate effects; stage/restart epochs clear
   transient state and event IDs.
6. Busy matches stay within state/event budgets; measure actual bandwidth,
   corrections and stalls. Synthetic shared-framework measurements are not a
   capacity guarantee for this game.


## Browser verification, 2026-10-02

Edge ran the actual compiled engine through over 1100 title-stage frames with
interpolation disabled, then into the original Carrington Institute introduction
(stage 0x26). Captured frames show original logo and in-game geometry/textures.
Web Audio was running and queueing samples; the shared-style volume control
changed master gain to 0.25. No JavaScript exceptions or WASM traps occurred.
The port's GL loader reports unavailable desktop-only functions under WebGL;
the exercised title and introduction rendered despite these upstream warnings.
This is a boot/render/audio check, not a complete Combat Simulator or netplay test.


## Controlled engine boundary

`prepare_engine.py` adapts the pinned source at checked markers. Changes are
opt-in through the runtime argument `--peak-controlled`. The default solo preview
retains the original continuously running loop. In controlled mode:

- Boot runs original initialization and title-stage setup, then returns to JS.
- `peakPdConfigure(players, seed)` runs before main; supports 1..4 controller seats.
  This announces controllers, not a forced multiplayer stage or selected arena.
- `peakPdCommand(slot, buttons, moveX, moveY, lookX, lookY)` stages one validated
  command per connected seat. Every seat must supply a fresh command for a step.
- `peakPdStep()` advances exactly one 60 Hz tick. Stage teardown/setup finishes
  before the next tick, with no leaked automatic main loop.
- OS game time advances only with controlled ticks; the initial game RNG seed is
  explicit. This does not claim all game systems are deterministic or snapshot-safe.
- Controlled frame timing bypasses wall-clock waits and SDL's implicit Asyncify
  swap yield. Rendering remains enabled; a headless authority is not implemented.
- Input is sampled before the controlled step. Native keyboard events cannot
  bypass command submission. The PC control scheme provides consistent action
  semantics and secondary-stick movement; look is delivered separately for each
  local player. The original solo input settings remain unchanged.

`static/js/netplay/perfectdark_engine.js` exposes `PeakNet.PerfectDarkEngine`.
Its `step(commands)` validates the entire row before native mutation and verifies
that one tick completed. `observe()` returns diagnostic stage/tick, timing and
player position/angles/health. **It is not a network snapshot or a rollback save.**
Callers must not use these observations as a complete `captureState` or
`captureLocal` implementation. Destroy the owning iframe to release its WASM heap.

`PeakNet.perfectDarkActions` provides the action map for the shared `FpsInput`:
fire, aim, reload, use, crouch, next/previous weapon, start, accept, cancel and
secondary fire. Perfect Dark has no generic jump action. Commands retain the
shared FPS schema and angular units. The engine's original FOV/aim rules still
apply to look deltas.

The browser fixture can opt in before launch with
`window.peakPdLaunchOptions = {controlled: true, players: 1, seed: 12345}`.
After startup, `window.peakPdEngine` is available for testing. This is a developer
entry point, not a selectable multiplayer backend. `peakPdStartCombat(stage)`
accepts only known multiplayer arenas and invokes the original `mpStartMatch`
path using the configured controller seats. It is explicit and never replaces
the normal startup flow. Complete replicated match settings are still pending. Production lobbies remain gated.

```powershell
node tests/games/perfectdark_engine_core.cjs
node tests/games/perfectdark_engine_browser.cjs
```

The browser test requires the isolated `--perfectdark` fixture and built runtime.
It exercises separate WASM heaps, no autonomous ticks while idle, fixed frame
increments, identical command traces and malformed/missing input rejection.


### Controlled-engine verification

Two separate browser instances, each configured with two controller seats,
followed identical commands through 601 ticks of original startup into the
Carrington Institute file menu. Neither instance advanced while idle. Calling
one engine did not advance the other engine's clock.

The native Combat Simulator start routine then loaded Temple with two live
players. Both instances produced exactly matching observed positions, view angles,
health and tick counters after movement and aiming commands. The second player
also accepted commands generated by the shared `FpsInput` dual-stick collector;
aiming did not affect the other seat. Holding a native keyboard movement key
while supplying neutral commands did not bypass the command stream.

A shared `AuthoritativeHost` test driver executed one real engine step and
acknowledged both seats. Its capture callback deliberately used observations
only for this integration test; it is not a production world-state codec.
Original solo startup/render/audio/fullscreen/volume smoke tests also passed
with controlled mode disabled. No online Perfect Dark match has been validated.

### Entity component boundary

`captureEntities()` returns `pd-props-v1` base components, keyed by
`prop:<stage epoch>:<allocation ID>`, plus stage and player-entity references.
Hooks in the original prop allocator/free routine assign a new identity on every
allocation and remove it on release. Pool reset increments the epoch, including
same-arena restarts. Neither C addresses nor reusable pool indexes go on the wire.
The registry is active only in controlled mode and fails explicitly on capacity
or identity exhaustion. Room lists stop at the native terminator, so stale tail
entries do not become network data. Per-camera visibility flags are excluded.

Each component currently contains type, enabled/active state, position,
regeneration timer and collision-room membership. The existing shared
`SnapshotCodec` can delta these independently without retransmitting an entire
array. The method deliberately does not implement the production `captureState`
contract: object transforms, door/lift internals, character animation/AI,
projectile physics and complete player movement state remain separate work.
Additional player/weapon fields are described below. There is no world
application or prediction restore method yet.

The engine browser test compares these components across independent WASM heaps,
round-trips real arena records through the shared codec while moving/aiming,
measures full versus delta bytes, and verifies old identities disappear on an
arena restart. These measurements cover base components only, not full-match
bandwidth or restore correctness.

Measured on the two-player Temple test: 141 captures, up to 34 props, four full
packets and 137 delta packets; 55,978 encoded bytes versus 503,709 bytes for full
packets (about 89% less). Restart advanced epoch 3 to 4. This short test includes
the restart but is not a busy-match capacity estimate.

### Player and weapon components

`captureComponents()` uses schema `pd-components-v2` and retains the same prop
identities. It adds a `player:<epoch>:<id>` record and two
`hand:<epoch>:<id>:<hand index>` records for each allocated player. Missing seats
produce no player or hand records. Native `peakPdComponentVersion()` guards the
explicit scalar field layout; values are checked for finite numbers and integral
fields before capture returns.

Player fields include view angles, health, raw character shield units, movement
speeds/timers, ground heights, crouch/fall/ladder/lift flags, current/previous/
pending weapon, dual wield state, two ammo type indexes and all 33 reserve-ammo
slots. Each hand includes its weapon/function, trigger transitions, firing flag,
attack/reload state and counters, both loaded-ammo and clip-size slots, refire
timing and last/allowed shooting frames. These are native values, without
quantization or inferred weapon rules. Reading them does not switch the current
player or invoke simulation code.

These records are independently delta-compressed by the existing shared codec.
They do not yet cover inventory ownership, gun animation, all weapon-specific
timers, complete movement internals or pointer relationships such as lifts.
They must not be used for `restoreLocal` or counted as a validated shot-event
stream. Damage, deaths and respawns still need dedicated real-engine acceptance
tests in addition to the firearm test described below.

Verified 2026-10-03: player/hand/prop components matched between two independent
WASM instances after the same input trace. Fire input changed the first player's
native trigger from 0 to 1 and hand state from 0 to 4, while the other player's
trigger stayed released. The expanded 141-capture Temple test used 310,728 bytes
versus 865,364 full-snapshot bytes (about 64% less), with up to 40 component
records. This is more data than the earlier prop-only test because per-hand
state counters change frequently. It is not a busy-match or final-rate benchmark.

### Firearm acceptance and controlled match setup

`PerfectDarkEngine.startCombat(stage, weapons)` optionally takes six original
multiplayer weapon-slot IDs. The JS and native boundaries validate every slot
before mutation, and the native bridge selects the original custom weapon-set
mode. Omitting the array preserves existing match settings. This is an explicit
controlled-engine option; original startup and the normal preview do not force
a loadout. It is not yet a replicated lobby/match-settings protocol.

`node tests/games/perfectdark_combat_browser.cjs` uses the isolated fixture to
start Temple with six Falcon 2 slots. It walks a player to a nearby same-floor
weapon using ordinary movement/aim commands, equips the collected gun, fires,
and reloads. No positions, inventory or ammo are injected. It checks real loaded
ammo depletion, native reload state, reserve-plus-clip conservation, unchanged
ammo for the other seat, and matching complete captured components between two
independent WASM instances. It also exercises rejection of invalid native weapon
slots. This tests component capture and game controls, not network restoration.

This test identified two integration fixes: lift height is canonicalized to zero
when the player is not in a lift (the native field can hold unused values), and
controlled mode suppresses native SDL mouse-lock requests. The shared `FpsInput`
collector owns pointer lock there, avoiding competing requests during native
menu/game transitions. Normal solo input retains its original mouse-lock path.

Verified 2026-10-03 after both fixes: player 2 picked up/equipped the Falcon 2,
firing reduced its clip from 8 to 6, and reload restored it to 8 while reserve
ammo dropped from 2 to 0. Native hand state entered reload (1) and returned to
idle (0). Captured components matched across both independent engines, the other
seat's ammo stayed unchanged, and no browser page errors occurred.

### Committed gameplay event bridge

Controlled mode now hooks committed firearm shots (after ammo clamping),
successful player pickups, successful non-bullet-hole explosions, player deaths,
and completed respawns. A bounded native outbox retains 256 events until a
validated batch is acknowledged. IDs increase within the stage epoch; a stage
reset clears that epoch's outbox. An event includes engine tick, player slot,
stable subject ID, position and event-specific detail. `detail` is weapon number
for shots, object type for pickups, shooter for deaths, and explosion type for
explosions. Shot `count` records actual shots committed, not trigger duration.
No native pointers are exposed. Overflow fails explicitly rather than dropping
events silently. Adapters must drain on every tick and handle stage transitions.

`drainEvents()` copies and validates the entire batch before acknowledging it.
A stale epoch cannot clear pending events. Passing the shared host's event
context as `step(commands, context)` forwards these events through `emitEvent`,
which supplies the session's ordered event IDs. Original engine IDs/ticks and
stage epoch remain in event data. This is not yet a predicted-effect matching
implementation or a complete client presentation adapter. Melee and thrown
weapons are covered by the extension below; bots and special weapon functions
need additional event coverage.

Verified 2026-10-03:

```powershell
node tests/games/perfectdark_combat_browser.cjs
node tests/games/perfectdark_combat_browser.cjs --driver --explosive
```

The firearm test receives one pickup and two shot events for two consumed rounds.
The explosive test uses a picked-up rocket launcher and ordinary aim/fire input
to cause an actual explosion and death, waits for the original death animation,
then respawns through normal controls. It receives pickup, shot, explosion,
death and respawn in order. Results match across separate WASM instances, both
directly and when driven by the shared `AuthoritativeHost`. Sending the event
batch twice through `GameplayEvents` delivers each event once. Initial stage
player allocation is distinct from a respawn and does not emit a respawn event.
The test driver's captured components remain diagnostic, not a full world codec.

### Remaining simulation/presentation boundary

`lvRender` calls `propsTickPlayer`, `scenarioTickChr`, `handsTickAttack`, and
`playerStartNewLife`; rendering is not a read-only presentation pass in this
engine. A replica cannot simply receive the currently captured components and
run the normal renderer: it would also execute game mutations. Full world
restore, replica simulation policy and prediction replay must address this
boundary before the production adapter/lobbies can be enabled. Do not substitute
position-only corrections or independent client simulation for that work.

### Controlled presentation and additional combat components

`present()` replays the last completed graphics command list without calling
`mainTick` or `lvRender`. It returns false before any completed frame or after
the cached list is discarded. Controlled redraws disable interpolation and
retain original matrices. Normal solo startup is unchanged. This lets a display
refresh without a gameplay tick; it does not yet render a newly restored world.

The native component ABI is now version 2. In addition to players and hands,
captures include `object:<epoch>:<id>`, `weapon:<epoch>:<id>` and
`projectile:<epoch>:<id>` records. Objects expose model, scale, rotation, flags
and damage. Weapon objects expose weapon/function, activation timer and dual
weapon identity. Live and embedded projectiles expose velocity, launch target,
flight/bounce/pickup timers and owner/target/pickup references as stable entity
IDs. An absent reference is zero. The native collision-owner reference can be
cleared during flight; it is not permanent damage attribution. Inactive launch
coordinates are canonicalized to zero because the native pool leaves them
uninitialized. These components still exclude complete physics, animation,
inventory, AI and replica restoration.

Committed melee strikes and successful thrown-object allocations now feed the
same reliable event channel. They use event type `shot` with `data.attack` equal
to `melee` or `throw`; firearm events use `firearm`. A throw's subject is the
new projectile entity, while its slot identifies the throwing player. The
early melee avoidance query does not emit a strike. Bot attacks and remaining
special functions still need their own coverage.

The combat acceptance test supports `--melee` and `--throw --driver`, alongside
the firearm and explosive tests. It uses original commands and pickups, not
inventory or position injection. The grenade fixture collects the original MP
ammo crate, verifies a projectile's owner identity at launch and advancing
flight time, then observes the explosion. Additional redraws on one engine must
not change components or emit events; results are compared with a second engine
that has no extra redraws.

A scratch same-instance heap checkpoint experiment reproduced a short command
trace, including with asynchronous browser callbacks between restore/replay.
This is not a supported snapshot API: a 256 MiB raw memory copy does not capture
JavaScript graphics/audio resource lifetimes and is not a network world codec.
No heap-copy restore has been added to the production framework.

The follow-up cross-instance experiment confirmed this limitation. After equal
initialization and different input traces in Temple, copying memory reproduced
60 subsequent ticks and matching pixels. After only the host changed to G5
Building, copied components and the next 60 ticks still matched, but 907,722
of 1,228,800 pixel bytes differed: the client rendered incorrect textures,
including HUD text. Neither instance reported a WebGL error. Thus scalar-state
equality and absence of browser exceptions are insufficient restore acceptance;
stage/resource lifecycle and rendered output must also be checked. This was
isolated scratch code, not a change to the installed preview.

Verified 2026-10-03 on the expanded runtime: original title/intro, running audio,
volume and fullscreen; native firearm consumption/reload; four timed unarmed
strikes during the held-input fixture; grenade pickup/flight/explosion; rocket
death/respawn; independent-engine component equality and duplicate event
delivery. The component delta test used 341,188 bytes versus 2,156,815 full
snapshot bytes over 141 captures (4 full packets, 137 deltas, up to 80 component
records). These figures are not a full-world or busy-match capacity claim.

### Atomic player-pose restoration

`capturePlayerPoses()` returns `pd-player-poses-v1`: stage, stage epoch and
allocated players' slot/entity identity, position, yaw/pitch and room list.
`restorePlayerPoses(snapshot)` validates the entire JavaScript batch before
starting a native transaction. The C boundary independently checks current
stage/epoch, connected slots, live player identities, finite coordinates,
angle bounds, room bounds and room-list termination/uniqueness. Invalid native
rows poison the transaction, so a valid prefix cannot accidentally commit.
Input submission and arena transitions are blocked until commit or cancellation.
The JS wrapper cancels its transaction on every exit, including rejection.

Commit changes only player poses and room registrations, and refreshes derived
view directions through the original engine function. It preserves local
models, textures, shaders, inventory, velocities and engine time. The cached
display list is discarded, so `present()` returns false until a new frame is
generated. This avoids displaying the old pose as apparent restore success.

This is deliberately **not** `restoreLocal` or `renderState` for the FPS backend.
It does not restore movement integrator state, inventory, animations, world
entities or pending actions, and a normal subsequent `step()` still simulates
gameplay. Stage changes must initialize the new stage through the original
engine path; old-stage poses are rejected, not transplanted across resources.
Local and host entity mappings also remain necessary for a complete adapter.

```powershell
node tests/games/perfectdark_pose_browser.cjs
```

Verified 2026-10-03 with two independent WASM engines: an idempotent pose restore
preserves the next tick's captured components and rendered-pixel hash; a changed
pose restores both players without changing native time or graphics handles;
malformed second rows, duplicate native rows, stale identities and wrong stages
leave captured components unchanged. Repeated cross-room pose swaps and restore
back pass. An arena transition rejects the previous epoch's state. The test
does not claim a complete predicted-client or online match.

### Typed walking and inventory corrections

`captureWalkingState()` / `restoreWalkingState()` use `pd-walking-v2` and a
versioned 181-scalar layout in `PEAK_WALK_FIELDS`. In addition to the pose, it
carries walking acceleration, crouch/landing history, ground and ladder data,
previous position/rooms, head smoothing, head-animation progress and the head
model's typed root-motion data. Head animation contributes to physical walking
displacement in the original engine; restoring velocity alone is insufficient.
The animation's native model, callbacks and frame-cache slots stay local.
Unused ladder normals and inactive animation transitions are normalized rather
than serializing uninitialized native data. Frame indices are checked against
the original animation's frame count before commit.

This path currently requires a live, normally walking player, the original head
model, no lift/turret/vehicle entry, and an equal level frame. It does not rewind
the global simulation clock, restore third-person/hand animation, or implement
`restoreLocal`. Every required field must be staged in order; partial native
batches and invalid second players cannot commit a valid prefix.

`captureInventoryState()` / `restoreInventoryState()` use `pd-inventory-v1`.
They restore ordered single-weapon, dual-weapon and prop-reference inventory
records, the all-guns flag and all 33 reserve-ammo counters. Circular list links
are rebuilt inside the client's equipment pool; prop references resolve through
the current stage's entity registry. Unknown references, duplicate items and
capacity violations reject the transaction. The selected inventory index is
recalculated with the original engine function. Equipped, previous and pending
weapons and dual-wield mode must already match: this operation does not load
weapon assets or restore hand scripts, loaded magazines or world pickup state.
The inventory helper is built from `runtime/peak_pd_inventory.inc`.

Both extensions share the pose transaction's lifecycle, graphics preservation
and stale-display-list invalidation. They remain development boundaries for the
preview, not a registered multiplayer adapter. Full authoritative world restore,
entity mapping across different allocation histories, weapon/body lifecycle,
local prediction and end-to-end multiplayer acceptance remain necessary.

Verified 2026-10-03: two independent engines diverge for 30 movement ticks,
receive the walking correction, and then match the complete walking/pose
capture for 120 neutral, moving, strafing, turning and crouching ticks. The
earlier velocity-only checkpoint produced 291 field differences in a 60-tick
neutral replay; including head animation eliminated those differences in that
fixture. Inventory item/ammo round-trips, unknown references, duplicate items,
incompatible equipped weapons, invalid animation frames and malformed second
players are covered by `perfectdark_pose_browser.cjs`. Time, gameplay events
and local GPU resources remain unchanged during correction. The original intro,
audio/volume/fullscreen and real pickup/fire/reload tests also pass. These are
component-level acceptance checks, not proof of a complete world replica or
online match.

### Weapon scripts and combined player correction

`captureWeaponState()` / `restoreWeaponState()` use `pd-weapons-v1`. The
transaction includes poses, inventory/reserve ammo and both hands. Each active
hand carries a versioned 123-scalar layout covering loaded magazines, trigger
history, fire/reload state, timers, recoil parameters and weapon-animation
progress. Inactive hands have an explicit empty state. Script references use
stable IDs from a deterministic traversal of the pinned weapon definitions;
each browser resolves them to its own native script pointers. Current scripts
and animation IDs must belong to the equipped weapon. Model definitions,
animation cache slots, sound handles and graphics resources remain local.

`capturePlayerState()` / `restorePlayerState()` use `pd-player-state-v1` to
combine walking/head animation with that weapon/inventory transaction. A
failure in any component rejects the entire batch, including already-staged
players. Neither method advances the simulation clock or emits gameplay events.
These names intentionally differ from the authoritative backend's full-world
`captureState` and prediction `restoreLocal` methods.

Current restrictions: same stage/epoch and level frame, live supported walking
players, matching equipped/previous weapons and dual-wield state, fully loaded
local weapon assets, and no pending weapon switch or held rocket. Weapon asset
transitions, third-person body state, world entities and global random state
remain outside this checkpoint. Cosmetic beams, smoke, sound playback and
weapon sway are not rewound by these original hand-state fields. Full prediction/world
restoration and online-match acceptance are still required before PD enters
the multiplayer catalog.

```powershell
node tests/games/perfectdark_weapon_restore_browser.cjs
node tests/games/perfectdark_weapon_restore_browser.cjs --weapon=9
node tests/games/perfectdark_weapon_restore_browser.cjs --weapon=18
```

Verified 2026-10-03 with the Falcon 2, CMP150 and shotgun: two independent
engines collect an original weapon and ammo crate; only the host moves/fires,
then the client receives an atomic player correction. A second correction lands
inside an asserted native reload while the client remains idle. Native hand
components, reserve ammo and subsequent gameplay-event payloads match over
180 ticks of reload completion and further firing. Invalid script IDs,
overfilled magazines, invalid animation frames and mismatched weapon assets
leave the entire captured player state unchanged. An idempotent correction
preserves the next rendered frame's pixel hash. Repeat with `--client-ahead`
to verify the reverse correction direction; all three weapon fixtures pass
both directions. The ammo-crate and native reload-state assertions ensure
these are real reloads rather than idle or unfinished firing cycles.

Before divergence, a 150-tick unarmed attack trace verifies that correcting an
idle hand preserves its next animation. This caught and fixed normalization
that zeroed playback speed/scale before the first animation. That melee check
runs with matching random streams: after different shooting histories, later
randomized melee selection can diverge because global RNG is not restored by
the original player-only checkpoint. The optional random-state extension below
addresses that stream mismatch; the firearm tests must not be generalized into
a full determinism claim.

### Atomic player and random-state correction

`capturePlayerState({random: true})` returns `pd-player-random-v1`, including the
existing combined player data, controlled tick, weapon sway and both original 64-bit RNG
streams as four unsigned 32-bit words. This preserves every bit through JSON;
it does not reseed the generators, consume a random value, or serialize pointers.
`restorePlayerState()` recognizes this schema and stages the streams in the
same native transaction as the players. No stream changes until all player,
inventory, movement, weapon and sway validation succeeds. Cancellation clears staged
random state. Existing calls without the option retain `pd-player-state-v1`
and leave random state unchanged.

The correction requires the same stage, allocation epoch, level frame and
controlled tick, plus every configured controller seat. It rejects partial-seat
global corrections, zero streams, non-integral/overflowing words, stale ticks,
and malformed player rows. JS and native code both validate their boundaries.
All earlier player support restrictions still apply. This is not a world
checkpoint: bots, props, projectiles, body animation, global timers and graphics
resource lifecycle remain outside it. RNG correction alone cannot synchronize
worlds whose other systems consume randomness differently.

Each player's `sway` contains 145 typed scalar fields: sway timing, hand
synchronization, blend ring indices/vectors and damping history. Sway is not
merely cosmetic here: `bgunCalculateBlend` consumes seven gameplay RNG draws
when a hand crosses its next blend boundary. A diagnostic trace found one
engine making those seven draws while the other made none immediately after a
player-only correction. Restoring RNG without its sway timing therefore leaves
a real route back to divergent attack choices. The optional schema restores
both together, including sway for the inactive hand, and validates blend array
indices before committing. No GPU handles or animation-cache pointers are copied.

```sh
node tests/games/perfectdark_weapon_restore_browser.cjs --random
node tests/games/perfectdark_weapon_restore_browser.cjs --random --client-ahead
node tests/games/perfectdark_weapon_restore_browser.cjs --random --random-control
node tests/games/perfectdark_weapon_restore_browser.cjs --random --active-effects
```

The standard random-state cases let original smoke effects finish naturally,
assert that neither world has a smoke prop, then exercise different air-punch
histories before correction. They compare RNG words, native hand/animation state
and gameplay events for 150 ticks. No world objects are deleted to prepare the test.
`--random-control` deliberately leaves RNG uncorrected in that same fixture and
requires actual animation/gameplay divergence, not just unequal seed words.

`--active-effects` retains the earlier combat history and asserts different live
smoke counts. It records the current limitation: even after player/RNG correction,
the following replay diverges. A native call trace located two extra draws in
`smokeTick` (particle offsets in `src/game/smoke.c`, upstream lines 479–480), before
player order is shuffled. Thus smoke state/allocation lifetime is a concrete
remaining world-restoration dependency, not a reason to change the original RNG
or remove game effects. A passing negative regression is not online readiness.
These tests still use the isolated `--perfectdark` fixture and independent real
WASM engines, not online rooms or client-reported combat outcomes.

Verified 2026-10-04 on the normal (uninstrumented) build with the Falcon 2:
both correction directions pass the 150-tick settled-effects melee comparison;
the omitted-RNG and active-smoke negative cases reproduce their expected gameplay
divergence. The legacy player-only weapon test, controlled-engine browser test,
JS transaction tests and authenticated-preview boundary test also pass. This
does not extend the earlier weapon coverage to every weapon's random-state replay.
The tested runtime is installed in the authenticated preview; the previous build
is retained at `instance/perfectdark/before-random-state-20261004`. Perfect Dark
remains outside the production multiplayer catalog.

### Independent smoke-effect correction

The original `pd-player-smoke-v1` format includes player, RNG and sway data
automatically. `capturePlayerState({smoke: true})` now emits version 2 below. The smoke extension contains up to 32
native pool slots, each either empty or 126 typed scalars: age/type/hand options,
prop position and scheduling state, terminated room list, and ten particles'
position, size, rotation, offsets, alpha and age. It also records the current
player context used by native muzzle smoke and the active prop update order.
Pointers, GPU objects and foreign allocation identities are never copied.

The transaction stages and validates the entire payload before changing players
or smoke. It checks room bounds/termination, scalar bounds, pool capacity,
particle rows, update-order uniqueness/completeness, and free-prop/identity
headroom for new effects. Non-smoke active entities must already have matching
identities and relative order. Missing effects are allocated locally, extra
independent effects are freed through the original prop lifecycle, and surviving
effects retain their local identity. Reapplying a checkpoint does not allocate
new identities. Room-list entries after the native `-1` terminator are canonical
`-1` values, since the original allocator leaves unused entries uninitialized.

This is an incremental effect codec, not a complete world checkpoint. Version 1
rejects source-prop or pad-effect pointers; version 2 adds prop references below.
Paused smoke, parent/child links and wall-hit attachments remain unsupported. Local allocation counters/identities remain
local; reconnect/world restoration must still reconcile the broader world,
including projectiles, props, bots, body animation and other effects. The existing
`pd-player-random-v1` option continues to omit smoke and therefore retains the
active-smoke limitation demonstrated by its negative regression.

```sh
node tests/games/perfectdark_weapon_restore_browser.cjs --smoke
node tests/games/perfectdark_weapon_restore_browser.cjs --smoke --smoke-create
node tests/games/perfectdark_weapon_restore_browser.cjs --random --active-effects
```

The smoke fixtures retain the original live impact-smoke history; no settling
wait or forced particle expiration is used. They exercise removal and creation
in opposite correction directions, compare 150 ticks of particle state, RNG,
hand animations and attack events, and check invalid transactions and idempotent
reapplication. The final command intentionally omits smoke correction and must
still reproduce actual gameplay/animation divergence.

Verified 2026-10-04 with the Falcon 2 impact-smoke fixture: creation and removal
corrections pass the 150-tick comparison, including the recreated particle's
natural expiration. Invalid batches leave players/effects unchanged, and
idempotent reapplication preserves local identities, time, events and GPU
resources. Omitting smoke correction still reproduces the earlier divergence.
Legacy player-only correction, JS transaction tests and authenticated-preview
boundaries pass. The native-flow browser test also passes 10,052 ticks through
two complete matches, Game Over screens and returns to setup in the same engine.
The tested preview is installed; its previous build is retained at
`instance/perfectdark/before-smoke-state-20261004`. Online rooms remain gated.


### Smoke sources tied to native props

`capturePlayerState({smoke: true})` now emits `pd-player-smoke-v2`. Its `smoke.sources`
array parallels the existing pool slots: zero means independent, and a positive
value names the source prop by its allocation-lifetime entity ID. Empty slots
must carry zero. Native preflight resolves every nonzero ID to a currently
allocated, non-smoke local prop in the same stage epoch; stale references,
self/other-smoke references, mismatched source modes and malformed arrays reject
the entire transaction. No pointers cross the engine boundary. Native source
release/clearing continues to use the original game code.

Version 1 restoration remains available for independent effects and rejects a
local world containing linked smoke, so an older checkpoint cannot silently
strip an attachment. Pad-effect sources still need a separate typed reference
format and are rejected. This restores smoke's attachment; it does not restore
the source object's motion, physics, allocation, damage or AI. Those world-state
dependencies remain necessary for production online rooms and spectators.

Unused particle slots now serialize as zero when their size is zero. The native
pool initializes size before emission but leaves the rest of that inactive
particle's bytes unspecified. Canonicalizing them avoids invalid float values
without changing active particles or consuming RNG.

`captureSmokeState()` exposes the read-only effect payload separately, so tests
can follow effects through native death and weapon transitions. It is diagnostic
data, not a standalone world snapshot or a bypass of player restoration guards.

```sh
node tests/games/perfectdark_attached_smoke_browser.cjs
node tests/games/perfectdark_attached_smoke_browser.cjs --control
```

This fixture uses original controller commands to collect grenades, switch to
secondary mode, throw one and create native pinball smoke on a bounce. It uses
the public correction API to give one replica an incorrect but valid source,
then corrects it from the other independent engine. The 150-tick replay compares
particle data, random streams and events. The control omits correction and must
show different particle state, not merely different source-ID metadata.

Verified 2026-10-04: the attached-grenade fixture passes 150 ticks through native
explosion/death events and source cleanup, while the omitted-correction control
produces different particles. Invalid source IDs/modes/epochs and legacy
checkpoints targeting attached effects leave state unchanged. Independent-smoke
creation/removal and real-WASM restoration of the older v1 format pass, as do JS
transaction and authenticated-preview tests. The tested build is installed in
the authenticated preview; the prior build is retained at
`instance/perfectdark/before-attached-smoke-20261004`. This adds no production
multiplayer registration and does not claim full world or projectile restoration.

### Existing airborne grenade correction

`capturePlayerState({grenades: true})` emits `pd-player-grenades-v1`, including
all player, RNG, sway and v2 smoke state plus the complete set of supported
existing airborne grenades. Each grenade carries its allocation-lifetime entity
ID and 102 typed scalar fields. `captureGrenadeState()` exposes the same grenade
rows for read-only diagnostics. These rows are not a standalone restore API.

Restoration requires the same tick, stage epoch, grenade identities, assets,
physics mode and owner references in both engines. It restores position, room
membership, rotation, velocity, initialized physics parameters, scheduling,
shading, bounce history and fuse timing. Missing/extra/reallocated grenades,
changed assets/references, partial rows, invalid rooms, inactive/embedded
projectiles and launch/fall/slide/powered states reject the entire transaction
before player or world mutation. Uninitialized interpolation/launch/homing
storage is neither serialized nor copied. Native pool allocations, models,
geometry buffers and pointers stay local.

Only the geometry reconstruction helper runs during application; the normal
movement helper also triggers proximity mines and is deliberately avoided.
Room membership is registered from the validated checkpoint. The game continues
to handle subsequent movement, collisions, smoke, fuse expiry and explosions.

```sh
node tests/games/perfectdark_grenade_browser.cjs
node tests/games/perfectdark_grenade_browser.cjs --control
```

The fixture throws a real secondary grenade with controller input in two
independent engines. It deliberately changes one replica's velocity and fuse
through the typed API, advances three native ticks, and applies the other
engine's combined correction. It checks rejection atomicity, idempotence,
unchanged entity identities, no correction-generated events, then compares
trajectory/object state, smoke, random streams and events for 150 ticks through
the native explosion. The control omits correction and must produce a different
native explosion outcome.

This is a same-allocation airborne correction primitive, not general projectile
or world restoration. Spawn/removal reconciliation, other projectile types,
explosion state, damage/body state and remaining world dependencies still gate
production online rooms and spectators. Lobby responsibilities and the native
continuous-session flow are unchanged.

Verified 2026-10-04: both grenade replay/control tests pass, including the full
trajectory/rotation comparison; attached-smoke replay, JS transaction tests and
authenticated-preview boundaries also pass. The tested preview is installed and
its four artifacts match the build byte-for-byte. The prior build is retained at
`instance/perfectdark/before-grenade-state-20261004`. No service restart is needed
for these preview assets.

### Removing extra airborne grenades

`capturePlayerState({grenadeRemovals: true})` opts into `pd-player-grenades-v2`.
It includes the same combined player/RNG/smoke/grenade checkpoint as v1, but
allows a recipient to discard supported airborne grenades absent from the
checkpoint. The default `{grenades: true}` still emits v1 and requires an exact
matching grenade set. Neither version creates missing authoritative grenades.

Native preflight determines removals before validating active-prop order and
smoke sources. The order comparison may skip only those specific extra grenades
and smoke; unrelated objects must still match. Staged smoke cannot retain a
removed grenade as its source, and surviving projectiles cannot reference a
removed grenade as owner, target or pickup recipient. All player, weapon,
grenade and effect validation finishes before any removal.

Application uses the original permanent-object cleanup to unregister proxies,
clear attached-smoke references, remove room membership, stop object sounds and
release the native model, projectile and prop. It does not detonate the grenade.
The checkpoint then restores the remaining effect pool and active-prop order.
Repeated application is idempotent. Removed local allocation IDs are retired;
allocator counters are not rewound or copied from the other engine.

```sh
node tests/games/perfectdark_grenade_removal_browser.cjs
node tests/games/perfectdark_grenade_removal_browser.cjs --control
```

The test uses controller input to throw a secondary grenade only in the recipient
engine. At the same native tick, the authority has no grenade and the recipient
has a grenade plus linked smoke. It rejects legacy/malformed corrections,
dangling sources, retained/deleted unrelated order entries, missing authoritative
identities, stale epochs and late player errors without mutation. Successful
removal emits no gameplay events and must match a 200-tick replay of object and
projectile state, smoke, random streams and events. The omitted-correction control
must produce a native explosion from the extra grenade.

Creation still requires an allocation reservation/rollback design: the native
weapon creation helper can evict another weapon under pool pressure. Future
spawn identity mapping and event identity reconciliation also remain necessary;
this narrow removal primitive does not align allocator history or provide a
complete rollback/online contract. Menus, match endings and continuous native
sessions remain untouched.

Verified 2026-10-04: the 200-tick removal replay and omitted-correction explosion
control pass on the final build. The legacy 150-tick grenade motion/fuse replay,
JS transaction tests and authenticated-preview boundary test also pass. The
installed preview artifacts match the tested build byte-for-byte; its prior
build is saved in `instance/perfectdark/before-grenade-removals-20261004`.

### Missing grenade creation and forward allocation recovery

`capturePlayerState({grenadeCreation: true})` emits `pd-player-grenades-v3`.
It extends v2 with each grenade's six-field `birth` row (weapon subtype bytes,
dual-weapon sentinel, model scale, projectile back-reference kind and pad
sentinel) and `allocation: [entityHighWater, propAllocationState, weaponCursor]`.
Creation is opt-in; the older v1 and v2 contracts are unchanged.

The native transaction reserves unused prop, weapon, projectile and model slots
and already allocated type-2 model RW cache storage. Reservation is read-only,
recomputed on validation, and includes smoke's subsequent prop/identity needs.
It never invokes the native weapon/projectile allocators that can evict an
existing object. No heap/stage-memory allocation occurs during creation.
Insufficient resources reject the complete player/effect transaction.

Creation currently accepts ordinary, unarmed, airborne grenades using the
already loaded `MODEL_CHRGRENADE` asset, its geometry-free layout, standard
object flags and a live player owner. Embedded, powered, armed-proximity,
custom-asset/geometry and unsupported reference states are rejected. Model,
weapon and projectile pointers are constructed entirely from local reserved
slots. Source smoke and the full active-prop order may reference the reserved
grenade and resolve before commit. After all validation passes, the transaction
initializes the local model, applies typed state, attaches the effect source and
restores scheduling. Creation emits no throw or explosion event.

New grenade IDs must be strictly ahead of the recipient's allocation high-water
mark, ordered and within the authoritative checkpoint's high-water mark. All
required smoke allocations must fit below that mark too. The transaction can
advance the allocation high-water mark and restore allocation cursors, but never
rewinds IDs or reuses retired identities. This covers a replica that missed a
throw and its smoke. A replica whose conflicting allocation history is already
ahead still rejects; arbitrary history remapping remains outside this contract.
Local event-outbox sequence IDs are also unchanged; replay comparison includes
native event payloads and their entity IDs, not local outbox serial numbers.

```sh
node tests/games/perfectdark_grenade_creation_browser.cjs
node tests/games/perfectdark_grenade_creation_browser.cjs --control
```

The fixture throws a real secondary grenade only in the authority engine.
Correction creates it and its attached smoke in the recipient, then compares
200 native ticks including a later controller-triggered throw, the new grenade's
identity, explosions and death events. It checks idempotence, no synthesized
gameplay events, invalid assets/owners/flags/birth data, stale/future IDs,
allocation limits, missing order entries, resource exhaustion and late player
validation failures. Rejected corrections must preserve both observed state
and allocation counters. It also presents frames and rejects the old checkpoint
after a new stage epoch. The control omits correction and must diverge.

These operations preserve native game flow and remain preview-only. General
projectile/world restoration, conflicting allocation-history reconciliation,
event delivery and online room/spectator integration are still outstanding.

Verified 2026-10-04: the final 200-tick creation replay passes with matching
subsequent throw/entity and explosion/death payloads, presentation and stage-epoch
checks. The omitted-creation control diverges. V2 removal replay, V1 motion/fuse
replay, JS transaction tests and authenticated-preview boundaries pass. Installed
preview artifacts match the tested build byte-for-byte; the previous build is
retained at `instance/perfectdark/before-grenade-creation-20261004`.


### Living-player health and shield correction

`captureVitalsState()` / `restoreVitalsState()` expose a typed `pd-vitals-v1`
checkpoint for health, shield and health-bar/damage-flash timers. Fifteen explicit
scalar fields are validated in the existing pose transaction. A bad field on a
later player rejects the entire transaction before any player changes. The
capture requires living players and restore requires the same tick and stage.
Zero-health/death transitions are deliberately rejected: invoking the native
death handler during restoration would drop items and update scores again.

`capturePlayerState({vitals:true, random:true})` includes the same versioned fields
in the combined movement/inventory/weapon/random transaction. The extension is
optional, preserving existing diagnostic captures. It is not a complete damage,
body-animation, shield-hit-effect, death, respawn or whole-world checkpoint.

Validation uses `tests/games/perfectdark_vitals_browser.cjs`: two real WASM
engines, health and shield correction, invalid second-player rejection, rejected
lethal correction, no emitted gameplay events, and matching native components
for 100 subsequent ticks. The weapon regression also passes with
`--random --vitals`, including divergent-history melee replay. Both ran against
the isolated local build; no production adapter was enabled or preview published.


### Optional GPU submission and fresh-engine replay

`PerfectDarkEngine.setPresentation(false)` skips GPU display-list submission in
controlled mode. Native display-list generation still runs: it advances game
visibility, animation and random state. Frame start/end also still run because
their window dimensions affect world-object activation. An initial experiment
that skipped those boundaries failed the stronger component comparison and was
corrected. Returning to `true`, then stepping once, builds a fresh display list;
`present()` can display it again. This option does not mute audio or implement a
network authority by itself. The normal preview defaults to presentation enabled.

`perfectdark_flow_browser.cjs --no-present --replay` compares every exposed
component and both RNG streams, as well as native menus and player observations,
through two one-minute matches and an arena change. A third fresh engine then
replays the recorded controller batches; each batch must match the SHA-256 of
the original captured observations. The trace is saved in
`.tmp/perfectdark/flow-no-present/input-trace.json`. The local Chromium run
matched 10,053 ticks and replayed them in 8,745 ms; runtime loading is excluded
from that replay measurement. Resumed drawing was inspected in
`presentation-resumed.png`. This is evidence for the exercised history, not a
proof of whole-game or cross-browser determinism and not an online lobby test.

`perfectdark_grenade_creation_browser.cjs --no-present` also passed with one
engine omitting GPU submission: native grenade creation, subsequent throw
identities, explosions, smoke, RNG, and 200 ticks of replay matched the rendered
engine. Earlier-stage correction was rejected after changing stage epochs.

Perfect Dark account saves (2026-10-09): `perfectdark_saves.js` syncs the native
2048-byte `eeprom.bin` to the same account-save API/database. This contains the
game's normal saved progression/profiles; it is not an arbitrary mid-mission
snapshot. At room preparation, the server freezes seat zero's account save.
Every player and late spectator loads that exact starting snapshot before the
native engine initializes, preserving deterministic replay. Only seat zero
uploads subsequent saves; guest and spectator accounts are never overwritten.
The snapshot is sent only in room preparation, not public room listings.

Updates flush every five seconds, on hiding the page, and on orderly exit.
Failed uploads leave a localStorage recovery copy. A later launch can upload a
non-conflicting recovery copy, then asks the player to reopen the room so every
replica receives the recovered snapshot. Revision conflicts preserve the copy
and stop automatic overwrites. Activation requires the same safe server reload.

Validation: `perfectdark_saves_browser.cjs` used native controller input to
create an EEPROM, uploaded it, restored identical bytes on a fresh browser,
and loaded a spectator replica without altering the spectator's account.
`perfectdark_saves_test.py` verifies immutable late-join snapshots and omission
from room listings. Account API and synchronized-room regression tests passed.
Production PID 7670 was not restarted.
