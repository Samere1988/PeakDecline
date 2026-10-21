# Mario Party 1 native browser port

The first playable build is staged in `instance/marioparty/build`, with the shared
four-seat lobby, controller setup and spectators. The production service has not
been restarted; it must reload the updated application before the new catalog entry
becomes visible. Existing game saves have not been changed.

This is an initial native port, not an exhaustive compatibility certification.
Spectators must join before launch. EEPROM currently lasts only for the running
session; account saves and resuming after closing the game are not implemented.

The runtime uses ahead-of-time translation of the original US program to C,
then WebAssembly, with browser implementations of N64 platform services. There is
no CPU interpreter, EmulatorJS or emulator fallback.

## Reproduce

From the repository root, using the workspace's Emscripten 4.0.18 installation,
local native C/C++ compiler, CMake/Ninja, Playwright and Chromium:

```bash
.venv/bin/python ports/marioparty/build.py --audit-all
.venv/bin/python ports/marioparty/compile_core.py
.venv/bin/python ports/marioparty/build_boot_probe.py
.tmp/emsdk/node/24.19.0_64bit/bin/node ports/marioparty/os_test.cjs
.tmp/emsdk/node/24.19.0_64bit/bin/node ports/marioparty/audio_test.cjs
.tmp/emsdk/node/24.19.0_64bit/bin/node ports/marioparty/boot_probe_test.cjs
```

The script checks the ROM SHA-1, checks out the exact source commits recorded in
`sources.json`, creates an isolated Python environment, extracts assembly and
metadata, builds N64Recomp, translates the retail `rand8` routine, compiles it to
WebAssembly, and executes it in headless Chromium. A temporary HTTP server listens
only on loopback and closes after testing. `MP_BROWSER` can select another Chromium
executable. Game data and generated source remain under `.tmp`.

The probe checks 1,000 sequential outputs for each of six seed values, including
signed-boundary and overflow cases, against the algorithm documented in the
upstream decompilation. It executes the actual translated ROM instructions, not a
handwritten substitute. This validates a small translation/memory/arithmetic path;
it establishes nothing about rendering, audio, boot, boards or multiplayer.

## Current evidence

- Original US ROM SHA-1: `1159bd56730094bfc71be30113e1cfc8bacf34f3`.
- Extracted metadata: 7,192 functions in 133 code sections.
- All 2,987,164 extracted instruction bytes checked against the source ROM.
- Browser probe: 6,000 outputs matched; no JavaScript page errors.
- One raw encoded block remains outside decoded metadata: `__LeoBootGame2`, ROM
  offset `0x835CC`, length 11,236 bytes.
- Full translation and compilation now succeed: 143 translation units, 7,059
  defined symbols in the core archive. Unsupported platform imports remain explicit errors.
- `LeoBootGame` is explicitly replaced with an unsupported disk-boot error because
  it jumps into self-modifying encoded code. The hardware-presence probe returns no 64DD attached, selecting the original cartridge startup path.
- Original cartridge startup now runs through nine OS threads, VI events, PI DMA,
  native process fibers, controller reads, EEPROM and original graphics/audio tasks.
- Browser screenshots verify the original N64 logo, 3D intro, title screen and
  village menu. Start/A input advances the original menus and dialogue.
- A 14,500-VI replay completes Coin Block Blitz and returns to Mini-Game Island.
  A pixel regression checks Mario remains visible with the board camera’s negative viewport origin.
- A 24,929-VI replay completes party setup, the first DK’s Jungle Adventure round,
  Whack-a-Plant and Slot Car Derby, and returns to board turn two.
- The native renderer uses pinned SM64 source-port rendering code, adapted for
  original F3DEX2 commands, fixed-point matrices, cartridge vertex layout, quads,
  seven lights, palette banks, tile loads, intensity-texture alpha and signed viewport origins.
- Hosted OS/process tests verify priority preemption, blocked sends/receives,
  queue bounds/order, VI timing, controller byte layout, EEPROM file persistence,
  process sleep timing, destructor/unlink/free ordering and repeated reset.
- Native audio tests verify ADPCM, PCM byte order, pole filtering and saved history.
  Real game PCM is non-silent and passes a clipping check across the party replay;
  the browser audio context resumes on user interaction. Subjective audio fidelity is not certified.
- The browser boot regression checks visible startup pixels, no runtime/WebGL
  errors, actual audio/graphics tasks, overlapping code-section dispatch and invalid
  section rejection. Original game code performs overlay BSS initialization.
- Lobby checks verify four player seats, spectator selection, controller setup and
  no lobby flavour text. Room protocol checks cover a spectator present at start.
  The full loopback lobby launches four native players and a spectator using the
  production runtime template. Separate instances match checksums across 1,050
  four-controller frames and across the complete 24,929-frame party replay with
  one human and three CPUs, even when presentation is skipped. Late joining and
  player reconnection are unsupported by the existing lockstep backend.

The catalog requires `marioparty.js`, `marioparty.wasm` and `playable.json` in
`instance/marioparty/build`. The staged manifest records source revisions, asset
hashes, validation and limitations. The runtime template uses the native module
through the shared frame bridge. No production service restart was performed.

The metadata is generated from a pinned splat disassembly. Section and function
boundaries are validated for alignment/contiguous instruction bytes and their
ROM-to-VRAM mapping. Successful generation is not proof that all code paths or
indirect calls have been discovered.


## Hosted OS implementation

`runtime/os.c` replaces a subset of libultra services, using Emscripten
[fibers](https://github.com/emscripten-core/emscripten/blob/main/site/source/docs/api_reference/fiber.h.rst)
to preserve compiled C call stacks across blocking operations. It does not execute
MIPS instructions. Thread contexts include separate guest registers and native
stacks. Queues retain their guest-visible count, head index and buffer layout.
The priority-zero idle loop yields to the host rather than spinning in the browser.
This schedules at OS calls and deterministic 60 Hz VI ticks. General-purpose libultra timers are still missing.
Internal libultra thread-list operations and unsupported hardware services still
throw. The thread structure is not a complete register-dump representation.

Compile the translated archive at `-O2` before linking with Asyncify: unoptimized
large translated functions exceed Chromium's WebAssembly local-variable limit
when stack-switch instrumentation is added. The boot and OS test modules are
separate: synthetic test thread entries never replace cartridge functions.

## Validation and staging

Build the application module separately from diagnostics:

```bash
.venv/bin/python ports/marioparty/build_boot_probe.py --runtime-dir .tmp/marioparty-port/release
MP_BUILD_DIR=.tmp/marioparty-port/release MP_TICKS=14500 MP_PRESENT_AFTER=14480 MP_INPUT_FILE=ports/marioparty/gameplay_inputs.json .tmp/emsdk/node/24.19.0_64bit/bin/node ports/marioparty/boot_probe_test.cjs
MP_BUILD_DIR=.tmp/marioparty-port/release MP_SCENARIO=party MP_TICKS=24929 MP_PRESENT_AFTER=24909 MP_INPUT_FILE=ports/marioparty/party_inputs.json .tmp/emsdk/node/24.19.0_64bit/bin/node ports/marioparty/boot_probe_test.cjs
MP_BUILD_DIR=.tmp/marioparty-port/release .tmp/emsdk/node/24.19.0_64bit/bin/node ports/marioparty/frame_bridge_test.cjs
MP_BUILD_DIR=.tmp/marioparty-port/release MP_SCENARIO=party MP_TICKS=24929 MP_INPUT_FILE=ports/marioparty/party_inputs.json .tmp/emsdk/node/24.19.0_64bit/bin/node ports/marioparty/frame_bridge_test.cjs
.venv/bin/python tests/games/marioparty_test.py
```

`MP_PRESENT_AFTER` accelerates CPU/gameplay replay by omitting earlier drawing;
it does not skip game ticks. Normal-presentation full-round testing also passed.
The frame-bridge test checks that rendering frequency does not alter game state.

For full lobby/browser testing, start `tests/games/marioparty_lobby_server.py` in
another terminal. It listens only on loopback port 8078, uses fixture users, and
never opens production databases. Then run:

```bash
.tmp/emsdk/node/24.19.0_64bit/bin/node tests/games/marioparty_lobby_browser.cjs
MP_NATIVE_FILES=1 MP_ROOM_PLAYERS=4 .tmp/emsdk/node/24.19.0_64bit/bin/node tests/games/marioparty_runtime_browser.cjs
```

`MP_NATIVE_FILES=1` tests the actual staged assets through the HTTP build routes.
To test an unpublished candidate instead, omit that flag and set `MP_BUILD_DIR`.
Stop the fixture server after testing. Do not replace live release files while a
room is running; validate candidates separately and coordinate deployment.

Remaining coverage: other boards/minigames, long full matches, browsers beyond
Chromium, and subjective audio fidelity. Unsupported platform calls fail explicitly.
Account saves and late spectators require additional integration.

The graphics renderer and scalar mixer are adapted from the pinned
[SM64 source port](https://github.com/sm64pc/sm64ex). Adaptations are generated under
`.tmp/marioparty-port/renderer`; the existing SM64 checkout is not modified.
`prepare_renderer.py` reads Git objects from the pinned revision. The ABI1 pole
filter recurrence was checked against the primary
[alist implementation](https://github.com/mupen64plus/mupen64plus-rsp-hle/blob/master/src/alist.c).
No CPU emulator or emulator plugin is built or loaded.

The recorded `gameplay_inputs.json` follows the original menus to Mini-Game Island and starts Coin Block Blitz. Replay it with `MP_INPUT_FILE=ports/marioparty/gameplay_inputs.json MP_TICKS=14500 MP_PROGRESS=1` when running `boot_probe_test.cjs`. This is a longer diagnostic, not a claim that all boards/minigames work.

For manual local testing, run `interactive_probe.cjs` with the same Node executable.
It accepts JSON lines specifying ticks and N64 buttons, and writes screenshots
and recorded controls under `.tmp`. `MP_INPUT_FILE` and `MP_TICKS` preload a replay;
`{"ticks":900,"pressEvery":180,"fast":true}` repeats A while skipping intermediate
drawing. `{"ticks":2,"trace":true}` captures draw calls and per-task images. Its HTTP listener is loopback-only; `{"quit":true}` closes it.

Upstream sources: [Mario Party decomp](https://github.com/mariopartyrd/marioparty)
and [N64Recomp](https://github.com/N64Recomp/N64Recomp). N64Recomp's MIT license is
retained as `N64Recomp-LICENSE`. No retail ROM is stored in this port directory.
