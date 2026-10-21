# Mario Kart 64 browser port

Mario Kart is launched from **Games → Retro Games** at `/games/retro`.
The standalone page and `/mk64` Socket.IO relay were retired on October 13,
2026. The active integration uses the shared `/retro` relay and authenticated
`/games/retro/build/mk64/` asset routes.

## Runtime and presentation

The browser build derives from the pinned MKart360 decompilation port in
`sources.json`. The original game and network input stream run at 30 Hz;
racing retains its original two physics steps per simulation frame. Rendering
now targets **60 FPS** by drawing an interpolated midpoint and the original
frame, without accelerating the game, countdown, timer, or audio.

Interpolation covers stable camera, kart, shadow and per-player Lakitu matrices.
Lakitu history resets when his role changes or his visible frames are interrupted. Course/scene
changes and large discontinuities reset or bypass interpolation. Particle,
HUD and menu animations retain their native cadence. `module.mk64RenderFps = 30`
selects the original presentation for comparisons. All players render at **1920×1080, 16:9** with an FXAA postprocessing pass.
The wider camera preserves geometry proportions; race HUD elements anchor to
the appropriate edges of each split-screen viewport.

Affine interpolation checks normalized orientation and scale before blending.
Small or shrinking karts cannot bypass the camera-cut guard and collapse into
an invisible midpoint during a sharp turn. The native regression in
`tests/games/mk64_matrix_interpolation.c` exercises the same helper used by the
browser runtime and can be compiled with a C compiler and `-lm`.

The native loop supports cooperative cancellation. Stop/restart waits until
`_web_is_stopped()` reports that the suspended game loop returned before starting
a replacement. `_web_render_frames()` counts presentations and
`_web_interpolated_matrices()` counts changed intermediate transforms.

## Networking

- One to four players run the same game locally; the server relays complete,
  ordered input sets. A spectator runs the same deterministic simulation.
- Input buffering adapts to measured round trips and jitter, with a one-frame
  minimum and delayed reductions. The initial setting uses lobby measurements.
- A disconnected player has 15 seconds to reconnect from the **same open tab**.
  Racers pause while a seat is disconnected. The server retains up to 1,200
  complete frames and the client resends its exact unconfirmed inputs. Reloading
  a tab cannot reconstruct its native state and is not supported as recovery.
- Spectators have a bounded 1,200-frame queue and accelerated catch-up. A failed
  spectator does not terminate racers. During the loading barrier, timed-out
  spectators are removed if the racers have loaded.
- Startup and runtime errors propagate to the room. Checksums include game/menu
  selections, RNG, race/course/timer state and all eight karts' principal state.
  They are diagnostic checks, not complete save-state serialization.
- Build fingerprints use stat-invalidated caching; cold hashing runs outside
  the gevent networking loop. Room state remains process-local: deploy with
  one Socket.IO worker. A server restart ends existing sessions.

## Build

Requires Python, Git and the Emscripten SDK pinned in `sources.json`. Assets are
prepared from the locally supplied US ROM (SHA-1
`579c48e211ae952530ffc8738709f078d5dd215e`); generated game data stays outside source control.

```sh
python ports/mk64/prepare.py --rom 'static/roms/N64/Mario Kart 64 (U) [!].z64'
python ports/mk64/build.py --output-dir .tmp/mk64/candidate-netplay
```

`PEAK_EMCC` can select an existing `emcc.py`. Otherwise the builder uses
`.tmp/mk64/emsdk/upstream/emscripten/emcc.py`. Keep the candidate separate from
`instance/mk64/build` until runtime and integration checks pass. Publish the
matching JavaScript/WASM pair together.

The build generates compatibility copies without editing upstream source.
These preserve the original texture byte streams, convert big-endian game/audio
structures, fix segmented pointer handling, and preserve the course television
framebuffer. Television readback occurs only on original simulation frames.
Audio produces two synthesis buffers per original game frame. Saves use the
shared account save service and the starting player's EEPROM snapshot.

## Verification

The following tests use isolated state and do not open production databases:

```sh
.venv/bin/python tests/games/retro_test.py
.venv/bin/python tests/games/catalog_test.py
.venv/bin/python tests/games/mk64_server_recovery_test.py
node tests/games/retro_core.cjs
node tests/games/mk64_session.cjs
```

Start the candidate fixture in one terminal:

```sh
.venv/bin/python tests/games/mk64_retro_server.py
```

Run the real Retro Games browser flow in another:

```sh
node tests/games/mk64_retro_browser.cjs
MK64_TEST_PLAYERS=4 MK64_TEST_NETWORK_DELAY=40 MK64_TEST_JITTER=80 \
  node tests/games/mk64_retro_browser.cjs
node tests/games/mk64_spectator_browser.cjs
```

Set `MK64_PLAYWRIGHT` and `MK64_BROWSER` for your installed Playwright module and
Chromium executable. The fixture defaults to localhost port 8068 and a temporary
save database; `--build-dir` and `--port` override its settings. Set
`MK64_TEST_URL` to a corresponding localhost URL. Reports and screenshots go to
`.tmp/mk64-netplay-20261013/`.

Browser checks cover native player selection, driving, audio, matching hashes,
render/simulation speed, retained reconnect, repeated restart disposal and
explicit departure. They use software WebGL and simulated ordered network delay;
real WAN/mobile performance and all-course coverage require additional testing.

For direct 30/60 FPS comparisons, run `ports/mk64/dev_server.py` with its
`--build-dir` pointing at the same candidate, then run
`node tests/games/mk64_presentation_browser.cjs`. Set `MK64_HARNESS_URL` to that
server and `MK64_LINK_MAP` to the matching build's `link.map`. This compares
per-frame hashes, game timer speed, interpolated transforms and native shutdown.
`MK64_PRESENTATION_ENDURANCE=1` adds three laps with deterministic CPU steering
and item acquisition/use checks. It validates presentation against the native
30 FPS baseline; the Retro fixture separately validates multiplayer transport.

## Graphics and mod compatibility

[SpaghettiKart](https://github.com/HarbourMasters/SpaghettiKart) is a separate
Mario Kart decompilation port with high-resolution/widescreen settings,
interpolated frame rates, antialiasing and a custom asset system. Its
[MK64 Reloaded](https://github.com/GhostlyDark/MK64-Reloaded) texture pack supports
HD replacements in SpaghettiKart's O2R mod format.

This runtime now imports MK64 Reloaded v2026.04.03 through a local adapter.
Original decoded texture checksums identify replacements; HD pixels upload only
to the GPU, leaving game memory, simulation and network inputs unchanged.
The prepared pack maps 10,429 PNGs; 138 unsupported or unidentified PNGs retain
original textures. Replacements stream on demand, with six concurrent downloads
and a 64 MiB decoded bitmap cache. Initial menus preload common assets.
The pack's credits are retained alongside the generated WebP files.

```sh
python ports/mk64/prepare_hd.py --pack /path/to/mk64-reloaded-v2026.04.03-sk-hd.o2r \
  --rom 'static/roms/N64/Mario Kart 64 (U) [!].z64' --output-dir /path/to/hd-assets
python ports/mk64/build.py --output-dir .tmp/mk64/candidate-hd \
  --hd-manifest /path/to/hd-assets/manifest.json
```

Publish the manifest's referenced files under
`static/mk64-hd/<assetId>/`, including credits. The build embeds the manifest
and loader; publish its matching JavaScript/WASM pair together. Pack provenance
and SHA-256 are pinned in `sources.json`.

FXAA runs after the scene render. Course television readback downsamples on the
GPU to the original 320×240 buffer and crops to 4:3. Native shutdown releases
textures, framebuffers and shaders; the loader cancels pending downloads.
`Module.mk64GraphicsBaseline = true` is a test-only 640×480 comparison mode.

Graphics checks include `mk64_graphics.c`, `mk64_matrix_history.c`, `mk64_hd_prepare_test.py`,
`mk64_hd_loader.cjs` and `mk64_hd_browser.cjs`. Set `MK64_TEST_GPU=hardware`
for physical-GPU browser checks. Software WebGL is substantially slower at
1080p; measured hardware results do not predict all client devices.

## Provenance

- [MKart360](https://github.com/sirdankz/MKart360), revision pinned in `sources.json`,
  derives from the Mario Kart 64 decompilation and Fast3D renderer lineage.
  Preserve upstream notices: its license covers only the explicitly identified
  original code, not all decompiled code or generated assets.
- [Emscripten](https://github.com/emscripten-core/emsdk) supplies the browser toolchain.
- The local WebGL backend and presentation bridge are maintained in `src/`.
  ROMs, extracted assets and third-party checkouts are not source deliverables.

The October 15 [visual audit](../../docs/mk64-visual-audit-2026-10-15.md) fixes
Lakitu camera-relative flicker, widescreen results layout and incorrectly
depth-tested menu text. `node tests/games/mk64_visual_browser.cjs` exercises
the two-player GP countdown and a moving lap sign on the development harness.
Set `MK64_VISUAL_ENDURANCE=1` to complete a three-lap GP and verify all eight
results rows. Set `MK64_HARNESS_URL`, `MK64_LINK_MAP`, and `MK64_TEST_OUTPUT`
to the local candidate, its matching map, and a separate evidence directory.


## Online server authority

The online catalog uses `mk64-server-authority-v1` and `instance/mk64/authority-graphics-20261017`.
Each authenticated room owns a headless Node simulation at 30 game frames per
second. Browsers predict local inputs, retain 120 frames of input/hash history,
and restore/replay authoritative checkpoints without stopping other players.
Presentation runs separately, targeting 60 Hz, with 120 ms translation smoothing;
large corrections snap. Replay suppresses duplicate audio and speculative save
writes. Native menus, controllers, HD textures and audio use the existing player.
The standalone `instance/mk64/build` remains a separate build.

Build from the repository root, then publish the matching three files together
(`mk64.js`, `mk64.wasm`, `state-manifest.json`) to `instance/mk64/authority-graphics-20261017`:

```sh
python3 ports/mk64/build.py --authority-candidate --output-dir .tmp/mk64/candidate-authority \
  --hd-manifest static/mk64-hd/reloaded-2026.04.03-98d852481dbb/manifest.json
sudo systemctl restart peakdecline.service
```

Node must be on the service PATH, or configure `MK64_NODE`. The default limit is
four room workers; `MK64_AUTHORITY_ROOMS` accepts 1–8. Workers have bounded command
queues, startup and liveness timeouts, and are reaped when rooms close. Worker IPC
has no public listener. Clients send authenticated seat inputs; they cannot
publish canonical state or terminate a match by reporting a mismatched hash.

State transfer uses a build-specific linker manifest containing 26.8 MB of game
state, excluding libc, Asyncify, GL and framebuffer state. Compressed sparse
checkpoints arrive at 5 Hz. The baseline advances every second using acknowledged
anchors. Each client has at most one unacknowledged packet; slow clients receive
a fresh full baseline when the bounded anchor history expires. Decompression
runs in a dedicated browser worker. A warmed driving test measured about 62 KB
per checkpoint, or 2.5 Mbit/s per client; initial joins and course changes require
larger transfers. These figures are workload measurements, not bandwidth limits.

The fast checksum covers gameplay and menu fields. A full authoritative refresh
at least every 30 frames also repairs divergence in state outside that checksum.
Missing inputs are held for six frames, then neutralized. Disconnecting neutralizes
only that seat. Account-bound recovery tokens survive reloads and closed tabs;
rejoining restores the same seat from current server state. An abandoned room
expires after 120 seconds. Spectators follow native snapshots and never hold up
players. The original host account owns server EEPROM saves, protected by revision
compare-and-swap so another session's progress cannot be silently overwritten.

Validation commands (the native tests use the candidate directory above):

```sh
node tests/games/mk64_authority_native.cjs
node tests/games/mk64_authority_network.cjs
node tests/games/mk64_authority_modes.cjs
node tests/games/mk64_authority_race_test.cjs
node tests/games/mk64_authority_bandwidth.cjs
node tests/games/mk64_checkpoint_worker.cjs
.venv/bin/python -m unittest discover -s tests/games -p 'mk64_authority*test.py'
MK64_TEST_ASYNC=gevent .venv/bin/python -c "from gevent import monkey; monkey.patch_all(); import sys,unittest; sys.path.insert(0,'tests/games'); unittest.main(module='mk64_authority_room_test')"
```

The native checks cover cross-instance replay, four-player state, native menus,
a complete four-race cup with results and course transitions, lost/delayed/duplicate
inputs, reordered snapshots, absent seats, and deliberate hashed and unhashed
state corruption. Room tests cover authenticated input ownership, reconnect,
live-tab takeover, slow spectators, anchor expiry, saves and worker cleanup.
Browser acceptance uses the normal lobby/player with HD textures and audio:

```sh
.venv/bin/python tests/games/mk64_retro_server.py --port 8073 \
  --build-dir .tmp/mk64/candidate-authority --authority-diagnostics
```

This loopback-only disposable fixture adds controls for driving, injecting a
position error, and simulating 200 ms RTT with input loss. The older port-8072
prototype is not the production lobby. Passing these checks does not guarantee
zero stutters on every device or network, nor exhaustive all-course determinism.

The October 17 graphics update groups the minimap outline, finish line and racer
markers under one widescreen anchor. Shells, bananas and fake item boxes use
actor/camera identity for matrix interpolation, including their visible shadows.
Sprite animation retains its original art frames; physics and item logic are unchanged.
`mk64_item_presentation_test.py` tests identity across matrix-pool movement,
cameras and actor-state changes; `mk64_graphics.c` tests minimap grouping.
