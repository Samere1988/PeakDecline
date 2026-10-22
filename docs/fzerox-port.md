# F-Zero X browser source port

F-Zero X uses the same Retro Games lobby, authenticated Socket.IO relay,
recomp-net input rings, session driver, loading barrier, and restart protocol as
MK64. Its C/C++ game code compiles to WebAssembly. No N64 CPU emulator is used.
The original MK64 page and binaries are separate.

## Build

Use the project Python virtual environment and Emscripten 4.0.10 toolchain
prepared for MK64. The first build downloads pinned dependencies. Asyncify
linking alone can take several minutes.

```powershell
.venv/Scripts/python.exe ports/fzerox/build.py --publish
```

The default ROM is `static/roms/N64/F-ZERO X (U) [!].z64`. `--rom` accepts an
alternate source for validation; the website still uses the catalog's ROM path.
The required US revision 0 MD5 is `753437d0d8ada1d12f3f9cf0f0a5171f`.
`sources.json` records the decomp and G-Diffuser revisions. Submodule gitlinks
pin libultraship and Torch. Existing checkouts at different revisions are
preserved and rejected, rather than reset.

Without `--publish`, artifacts stay in `.tmp/fzerox/runtime-build/` for testing.
`--configure` regenerates adapted libultraship sources and CMake configuration.
`--target renderer_probe` builds a minimal renderer diagnostic.

Publishing installs `fzerox.js`, `fzerox.wasm`, `fzerox.data`, and `licenses.txt`
under `instance/fzerox/build/`, recreating files to inherit Windows permissions.
The data file contains Fast3D shaders; game assets come from the local ROM.
License notices are preserved and linked below the game. Build artifacts,
checkouts, ROMs, and extracted data are not committed.

Restart the website after installing Python route/catalog changes. F-Zero
becomes selectable when all registered files are readable. HTTPS is required
outside localhost: the runtime uses SharedArrayBuffer and WebGL2. Isolation
headers are supplied on the lobby, embedded runtime, and worker responses;
the reverse proxy must preserve them.

## Runtime adaptations

- `compile.py` generates WASM32 header overlays and selects cartridge sources,
  excluding hardware-only and 64DD code. Game code, graphics, audio, and the
  scheduler are linked explicitly; arbitrary missing functions are not stubbed.
- `web_fiber.c` implements cooperative threads using Emscripten fibers. The host
  callback uses `simulateInfiniteLoop=false` so the fiber trampoline can unwind
  normally between browser frames.
- `configure_runtime.py` adapts libultraship to SDL/WebGL2 and a bounded worker
  pool. `prepare_browser_sources.py` replaces native memory probes with WASM
  bounds, selects 8-byte display-list conversion, preserves cartridge texture
  loading, and corrects C ABI signatures.
- `prepare_audio_sources.py` enables the cartridge audio engine and adapts
  upstream soundfont decoding to its bank layout. Audio commands, sequence-font
  indices, and sequence envelopes are converted from the original big-endian
  representation. It restores cartridge sequence startup, the permanent
  allocator's explicit return value, and the cartridge audio opcode. Synthesized
  PCM is delivered through SDL/WebAudio; keyboard/touch gestures activate audio.
- `web_main.cpp` advances one 60 Hz VI tick only after a complete synchronized
  input row exists. All four controller slots are supplied together. Random
  seeds and the game clock are reproducible. Renderer interpolation is disabled.
- The runtime page reports a fixed 960x720 canvas size and devicePixelRatio 1
  to SDL, so every player renders at the same resolution. Transition wipes read
  the rendered frame back into game memory; a different canvas size (phone touch
  layout, small window, HiDPI) desynchronized the match after the attract demo.
- `web_state.c` hashes pointer-free game state, RNG state, and racer physics.
  Renderer buffers, addresses, browser time, and local audio queues are excluded.
- Save writes use the runtime's in-memory filesystem. Every launch or restart
  begins from the same clean save. Per-user saves are not loaded into matches.

Choose VS Battle and the corresponding 2/3/4-player option, then each participant
confirms their machine. Keyboard, standard gamepads, previously saved N64
mappings, and touch buttons feed the shared input codec. Spectators run the
simulation without submitting controller input.

## Reuse for another source-compiled game

`static/js/netplay/wasm_frame_adapter.js` owns iframe lifecycle, keyboard/gamepad/
touch input, checksums, cancellation, and restart cleanup. F-Zero's registration
is `fzerox_adapter.js` plus its templates and `Game` catalog entry.

A compatible runtime page implements `startPeakGame()` and calls:

```javascript
peakGameBridge.loaded();              // joins the loading barrier
peakGameBridge.ready(frame);          // false means wait without advancing
const pads = peakGameBridge.pads(frame);
// Apply every controller slot and advance exactly one deterministic tick.
peakGameBridge.completed(frame, hash);
peakGameBridge.failed(message);       // report a runtime failure
```

Frames start at 1. `loaded()` does not grant permission to simulate: wait for
`ready(1)` and the server barrier. The adapter retains 120 completed checksums.
Restart destroys the iframe and creates fresh game memory, workers, and save
state. Each game supplies its own frame/input hooks, deterministic state hash,
browser build, and assets. The lobby and transport require no separate room
server for another compatible game.

## Verification

```powershell
.venv/Scripts/python.exe ports/fzerox/test_fiber.py
.venv/Scripts/python.exe tests/games/retro_test.py
node tests/games/retro_core.cjs
.venv/Scripts/python.exe tests/games/retro_app_preflight.py

# Local test lobby using the isolated build; no production databases.
.venv/Scripts/python.exe tests/games/retro_test.py --serve --fzero
# In another terminal:
node tests/games/fzerox_netplay.cjs
$env:FZERO_PLAYERS='4'
node tests/games/fzerox_netplay.cjs
```

The fixture listens only on `127.0.0.1:8066`. Tests use Playwright from the
workspace runtime and its Chromium build; set `PLAYWRIGHT_PATH`/`BROWSER_PATH`
to override. Seat 0 is a phone-like context (mobile user agent, touch, 844x390),
and the run idles through the attract demo before the menus. They drive the real menus into VS racing,
compare completed-frame checksums between players, check the spectator video, introduce
100 ms input delay, verify PCM reaches WebAudio after ordinary game input,
restart the room, and exercise departures. They also check standard gamepad
mapping and touch-button input. Screenshots and logs are written under
`.tmp/fzerox/`.

Standalone renderer/GP tests use `fzerox_runtime_server.py` on port 8067,
`fzerox_renderer.cjs`, `fzerox_boot.cjs`, and `fzerox_race.cjs`.

Validated on Windows/Edge on 2026-10-02: two-player and four-player VS races,
each with a spectator, matched all collected completed-frame hashes through
frames 2493 and 2611 respectively. Both runs included 100 ms added input delay,
nonzero WebAudio output, restart, gamepad/touch input checks, and departures.
The MK64 browser race regression, shared lobby/core checks, fiber checks, and
isolated production-app route preflight also passed. The verified build was
installed under `instance/fzerox/build/` and its authenticated runtime route
returned 200 with the game marked available.

These are local smoke tests, not exhaustive testing of every track or device.
Internet packet loss, mobile GPU performance, and long matches need broader
playtesting. Lockstep waits for missing input; there is no rollback, mid-match
joining, reconnection, or automatic state repair. Perfect Dark still needs its
own source port and an evaluated synchronization strategy.
