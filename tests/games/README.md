# Games browser checks

Persistent lobby checks use disposable accounts and saves with installed game builds:

```sh
.venv/bin/python tests/games/lobby_lifecycle_server.py
node tests/games/lobby_lifecycle_browser.cjs
NEXT_GAME=smash64 node tests/games/lobby_lifecycle_browser.cjs
node tests/games/catan_lifecycle_browser.cjs
```

The Retro fixture listens on loopback port 8079. The Catan check launches its own
temporary fixture. These cover late spectator joins, keeping the room and roles
between rounds, switching games/modes, and spectators taking available seats.
`PLAYWRIGHT_PATH` and `BROWSER_PATH` override the local browser tooling paths.
Server regression coverage is in `retro_test.py` and `catan_online_test.py`.

With the same loopback fixture running, `node tests/games/all_spectator_rejoin_browser.cjs`
checks every installed Retro game: a spectator joins before launch, leaves and
rejoins twice through the live room listing, and returns to the same lobby to
claim a seat. Video spectators must establish WebRTC and deliver 120 decoded frames per rejoin;
the report includes delivered resolution, frame rate, blank frames and audio/video stats.
Perfect Dark is checked for native replay catch-up and continuing game frames.
The test also catches stale reconnect tokens after an intentional leave.
It uses Chromium for WebGL games and Firefox with hardware WebGPU for CMR2.
`SPECTATOR_GAMES` selects comma-separated game IDs, `FIREFOX_PATH` overrides the
hardware browser, and `SPECTATOR_RESULTS` selects the JSON/screenshot output
directory (default `.tmp/all-spectator-rejoin`). Unavailable games are reported
as unverified and fail the full run. Catan's lifecycle check includes two
spectator leave/rejoin cycles in both base and Cities & Knights games.

To measure the spectator transport itself at 1080p/60, run
`node tests/games/spectator_quality_browser.cjs` against the same loopback fixture.
It supplies a moving 1920×1080 canvas and a tone through the real room/stream
code, checks decoded 1080p at ≥55 fps, verifies audio with the host muted, adds a
second viewer, rejoins twice, forces connection failure/recovery, checks the
no-WebRTC fallback, and verifies source tracks are released after viewers leave.
This isolates transport capacity from each installed game's native resolution
and rendering rate. Results are in `.tmp/spectator-quality/quality-results.json`;
`QUALITY_RESULTS` overrides that directory. `spectator_stream_test.py` covers
room-scoped signaling, role/epoch/token rejection, expiring fallback leases and
CMR2 coordinator migration. See [spectator video](../../docs/spectator-video.md)
for the quality target and deployment requirements.

For the current Mario Kart entry in Retro Games, use the isolated server and
portable browser checks documented in [the MK64 port README](../../ports/mk64/README.md).
`mk64_retro_browser.cjs` covers real multiplayer gameplay and restarts;
`mk64_spectator_browser.cjs` is the historical native-replay spectator check;
current video spectators use `all_spectator_rejoin_browser.cjs`;
`mk64_presentation_browser.cjs` compares 30/60 FPS native behavior. The old
standalone Mario Kart page and its browser tests have been retired.

To check Mario Kart spectator video after leaving and rejoining a running game,
start this disposable fixture, then run the browser check in another terminal:

```sh
.venv/bin/python tests/games/mk64_retro_server.py --port 8078 --build-dir instance/mk64/build
node tests/games/mk64_spectator_rejoin_browser.cjs
```

The check samples 120 displayed video frames after each of two rejoins, detecting blank
frames and stalled video while the host remains in a populated menu.
`MK64_PLAYWRIGHT` and `MK64_BROWSER` override the browser tooling paths;
`MK64_TEST_URL` overrides the loopback fixture URL.

Run `python tests/games/render.py`, then `node tests/games/browser.cjs`.
The harness renders the real Jinja templates and serves local assets through Playwright routes, without starting the application or accessing its databases.
Requires Jinja2, the bundled Playwright runtime, and Microsoft Edge.
Checks narrow layouts, invalid stakes, locked controls, pause/resume, resize during a race, finish/replay, saved credits, and deterministic winning/losing payouts.
Generated HTML and screenshots are ignored by Git.

Smash release qualification uses `retro_test.py --serve --smash --port 8068`
for the candidate build, or omits `--smash` to verify installed artifacts.
The fixture shares installed asset paths but puts account saves in its own
temporary database. `SMASH_URL=http://127.0.0.1:8068` selects that server.
`smash_netplay.cjs` supports `SMASH_MIXED_BROWSERS=1` (alternating Chromium and
Firefox seats), `SMASH_DROP_EVERY=3` (discard every third RTC packet),
`SMASH_RTC_RECOVERY=1`, `SMASH_FREEZE_MS=5000` (pause a Chromium renderer with
the debugger and verify bounded peer progress), and `SMASH_CPU_RATE=4`
(Chromium host CPU throttling). Use `SMASH_REPORT` to save simulation,
animation-callback, spectator-video, memory and transport metrics separately.
The network delay/jitter/burst settings inject ordered delivery delays; they
do not reproduce every property of a physical internet link or sleeping device.

`smash_desync_browser.cjs` verifies diagnostic download and same-room restart;
`SMASH_FAILURE_MODE=runtime_failure` exercises the runtime-exception path.
`smash_interruptions_browser.cjs` takes the guest browser offline, verifies
the connected group's lobby return, then reconnects/rejoins and verifies a
matching new match with the spectator. `smash_browser.cjs` also supports
`SMASH_MIXED_BROWSERS=1`: Chromium's confirmed reference is compared at every
frame with Firefox's delayed-input replay. `SMASH_ASSERT_CLEAN_RELOC=1` makes
unexpected relocation warnings fail the comparison.

For the licensed board artwork, run `python tests/games/render.py` followed by
`node tests/games/catan_browser.cjs`. This checks all 23 SVGs load, the 19-tile
board fits desktop/mobile widths, number tokens are valid, and the existing
turn/reset controls still work. It produces `catan-390.png` and `catan-1366.png`.

Mario Kart's `mk64_visual_browser.cjs` checks two-player GP graphics on the local
development harness: native countdown, a moving Lakitu lap sign, and (with
`MK64_VISUAL_ENDURANCE=1`) every row of the completed GP points panel. Supply
the exact candidate's `MK64_LINK_MAP`. The companion `mk64_matrix_history.c`
checks actor/camera coherence and history invalidation without browser timing.
See the port README for fixture and browser environment variables.

Mario Party 1 and 2 networking qualification (installed JS/Wasm, disposable users
and saves): start `.venv/bin/python tests/games/marioparty_lobby_server.py`, then
run these browser commands sequentially:

```sh
.venv/bin/python tests/games/marioparty_netplay_test.py
node tests/games/marioparty_session.cjs
node tests/games/marioparty_netplay_browser.cjs
MP_GAME=marioparty2 node tests/games/marioparty_netplay_browser.cjs
MP_NATIVE_FILES=1 MP_ROOM_PLAYERS=4 node tests/games/marioparty_runtime_browser.cjs
MP_NATIVE_FILES=1 MP_ROOM_PLAYERS=4 node tests/games/marioparty2_runtime_browser.cjs
```

The network browser test compares all four players' native checksums over 1,800
frames, checks distinct keyboard/controller inputs reach every peer, delays one
seat's outgoing inputs by 35–95 ms with one 1.5-second burst, then disconnects the host for 20 seconds, verifies every runtime pauses,
and reconnects the same native instance with matching checksums afterward. These are ordered input delays,
not physical WAN loss simulation. `MP_NET_FRAMES` increases the frame count;
`MP_TEST_URL`, `PLAYWRIGHT_PATH`, and `BROWSER_PATH` override loopback/tool paths.
Results are saved under `.tmp/marioparty-netplay/`. The runtime smoke tests also
require at least 80 decoded live spectator video frames. The protocol test checks
four-seat loading, duplicate/out-of-order inputs, a delayed seat, restart epochs,
matching/mismatching hashes, retained reconnects, invalid resume attempts, and
multiple missing players for both game registrations. The focused session test
checks pending-input replay and watchdog suspension using the installed Wasm ring.
See [qualification results](../../docs/marioparty-netplay-2026-10-16.md) for limits.

Mario Party reload and closed-tab recovery is documented in
[match recovery](../../docs/marioparty-recovery.md). Set `MP_RELOAD=1` and
`MP_NET_FRAMES=1320` on the network browser command for each game to verify host
reload and guest close/reopen beyond the old history window. Run
`marioparty_reload_test.py` for journal and recovery-barrier checks, and
`node tests/games/marioparty_replay_saves_browser.cjs` against the same fixture to
check original-save reconstruction, suppressed replay uploads and save conflicts.
