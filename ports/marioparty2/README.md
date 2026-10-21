# Mario Party 2 native browser port

Uses ahead-of-time C/WebAssembly translation of the original US program and
browser implementations of its platform services. There is no CPU interpreter or
emulator fallback. The source revisions and ROM SHA-1 are pinned in sources.json.
Original game assets stay local and are not part of the port source.

The shared lobby has four player seats, controller setup and spectators present
before launch. The catalog requires a separate playable.json release manifest;
a diagnostic build or archive alone never makes this game available.

## Build and test

From the repository root, with the same native compiler, Emscripten, Node and
Playwright installation used for Mario Party 1:

    .venv/bin/python ports/marioparty2/build.py
    .tmp/emsdk/node/24.19.0_64bit/bin/node ports/marioparty2/os_test.cjs
    .tmp/emsdk/node/24.19.0_64bit/bin/node ports/marioparty2/audio_test.cjs
    .tmp/emsdk/node/24.19.0_64bit/bin/node ports/marioparty2/fpu_test.cjs
    .tmp/emsdk/node/24.19.0_64bit/bin/node ports/marioparty2/math_test.cjs
    .tmp/emsdk/node/24.19.0_64bit/bin/node ports/marioparty2/palette_test.cjs
    .tmp/emsdk/node/24.19.0_64bit/bin/node ports/marioparty2/boot_probe_test.cjs
    .tmp/emsdk/node/24.19.0_64bit/bin/node ports/marioparty2/frame_bridge_test.cjs

The isolated build needs the pinned N64Recomp and SM64 renderer repositories, as
recorded in sources.json, and the US ROM already installed under static/roms/N64.
The renderer/audio implementation is shared with Mario Party 1. MP2-specific
platform addresses and process scheduling live in this directory; MP1's running
module is not altered. Build/test commands do not restart the application.

## Platform adaptation

The extraction audit contains 8,528 functions in 117 code sections, with 3,948,092
instruction bytes checked against the original ROM. The obsolete 64DD boot path
and internal exception dispatch are explicit unsupported services. Cartridge OS
threads, message queues, controller reads, PI DMA and graphics/audio tasks use
hosted native implementations.

`prepare_fpu.py` preserves the cartridge's integer-conversion rounding mode per
guest context. WebAssembly has no mutable host arithmetic rounding environment;
the upstream fenv-based helper is insufficient for CTC1/CVT sequences used by
MP2's trigonometry. Arithmetic itself currently uses WebAssembly's nearest mode.
Unsupported operations remain explicit errors; numerical assertions stay enabled.

`prepare.py` corrects the pinned disassembly's vector-length entry boundary:
the call at `0x800B1878` targets a leading NOP at `0x800B1840`, four bytes before
the body label. Including that NOP prevents the translator from creating an empty
function that returns zero distance/speed during Western Land's train ride.
`math_test.cjs` executes both original math entry points on known vectors.

`prepare_renderer.py` recognizes RGBA 4/8-bit tile descriptors when RGBA16 palette
lookup is enabled. The failing minigames explicitly load a palette and select
this mode; those texels must be decoded through the palette, not rejected as an
unsupported direct-colour format. The original display lists are unchanged.
`palette_test.cjs` compares actual WebGL pixels for RGBA/CI 4/8-bit tiles and
verifies that replacing the palette changes their colours.

Persistent account saves and late joining are not implemented for Mario Party 2.
EEPROM lives in the current running session, as in the current Mario Party 1 port.

## Lobby title image

The artwork is an actual title-screen canvas capture from this native module,
not a recreated or generated image. Use contain sizing to show the whole screen.

## Release validation

The initial release uses the shared four-seat lobby and controller setup, with
no flavour text. The staged application files were served through the website's
runtime routes to four players and a spectator; all rendered and stayed connected
past checksum exchange, with audio resumed by a user gesture.

Independent player and spectator runtimes matched throughout a 16,500-frame Rules
Land tutorial replay and a 19,200-frame Pirate Land replay. The latter covers
Roll Out the Barrels, Balloon Burst, results, and the return to the board on turn
two. Hosted OS/process, audio and per-context FPU conversion tests also pass.
The complete 19,200-frame replay also passed with every frame rendered and no
runtime or WebGL errors.
This is initial gameplay coverage, not certification of every board or minigame.

To link a candidate application module after building the core:

    .venv/bin/python ports/marioparty2/build_boot_probe.py --runtime-dir .tmp/marioparty2-port/release

To repeat the full-render Pirate Land check with that candidate:

    MP_BUILD_DIR=.tmp/marioparty2-port/release MP_INPUT_FILE=ports/marioparty2/party_inputs.json MP_TICKS=19200 MP_SCENARIO=party .tmp/emsdk/node/24.19.0_64bit/bin/node ports/marioparty2/boot_probe_test.cjs

The release JS/Wasm, source pins and validation manifest live under
`instance/marioparty2/build`. New catalog entries load when the application
process restarts; building and staging this port does not restart the live server.

## Expanded board and minigame checks

The 2026-10-10 crash-fix build completes all 72 targeted runtime cases with no
runtime/WebGL errors and matching independent replay checksums. Western Land's
train ride also passes through the normal controller-only menu path, reaches
turn two at tick 13,333 and matches the continuously rendered replay. The
19,200-frame Pirate Land player/spectator frame bridge and an isolated four-player
plus spectator lobby pass as well.

The four original crashes (Western Land, Look Away, Archer-ival and Dizzy Dancing)
are fixed. Day at the Races, Filet Relay and Torpedo Targets still have visible
geometry defects. See [current results](validation/report.md),
[fix details](validation/crash-fixes.json), and the
[original failing matrix](validation/initial-2026-10-09/report.md).
These are targeted checks, not certification of every game event or input path.

`coverage_test.cjs` runs a matrix of six board fixtures and 66 cartridge
minigame/event entries (including duels, Chance Time and Driver's Ed). It uses the
unmodified candidate release module. Test-only memory setup chooses the board or
minigame at a normal transition and configures CPU teams; it does not replace
gameplay code. These cases are distinct from the controller-only Pirate Land and
Western Land replays.

    MP_REPORT_DIR=.tmp/mp2-coverage-rendered .tmp/emsdk/node/24.19.0_64bit/bin/node ports/marioparty2/coverage_test.cjs
    MP_FULL_RENDER=0 MP_REPORT_DIR=.tmp/mp2-coverage-sync .tmp/emsdk/node/24.19.0_64bit/bin/node ports/marioparty2/coverage_test.cjs
    .venv/bin/python ports/marioparty2/coverage_report.py

For a separate candidate report, pass `--build-dir`, `--rendered`, `--sync`,
`--natural`, and `--board-captures` pointing to that candidate’s own artifacts.
The reporter rejects results carrying a different runtime digest.

The first run renders continuously after entering the target. The second skips
most presentation and compares periodic and final guest-state checksums. Use
`MP_BUILD_DIR` to select an isolated candidate, `MP_FILTER` to select case names and `MP_SHARD`/`MP_SHARDS` for independent process
shards. Reports and captured screens stay under `.tmp`; these commands never
restart the server or publish a new runtime. `coverage_findings.json` records
visual defects and confirmed reproduction notes that an exit-code check misses.

An automated completion result is not certification of every variant, board
event, full campaign, or human input path. Review screenshots and findings along
with runtime and synchronization results.

`coverage_natural_boards.json` supplies controller-only selection paths for the
five initially unlocked boards. Bowser Land uses a test fixture. For additional
visual captures, `MP_CAPTURE_AT` enables continuous drawing from that VI tick;
short capture runs are separate from the completion matrix.
