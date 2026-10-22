# Ocarina of Time browser port

The Retro Games integration uses zalo's Emscripten fork of Ship of Harkinian,
with its source revision pinned in `ports/oot/sources.json`. The underlying game
is based on ZeldaRET's Ocarina of Time decompilation. The original game assets
come from the existing supported Ocarina of Time ROM in this installation.

## Build

Activate `.tmp/emsdk/emsdk_env.sh`, then run:

```
.venv/bin/python ports/oot/build.py --publish
```

The recipe applies `ports/oot/browser.patch`, compiles the engine, and copies
artifacts into `instance/oot/build`. It never restarts any service. Source,
build products, and dependency caches live under `.tmp/oot-source` and
`.tmp/oot-build`. Generated archives are extracted in the player's browser.

## Integration

`solo-media-v1` allows one player and late spectators. The player runs the
engine locally; spectators only receive bounded WebP video and 16 kHz mono
PCM audio. Spectators do not load the game runtime or game ROM. The existing
room seat authorization and media backpressure apply. Leaving as the player
ends that room session; leaving as a spectator does not interrupt play.

The shared N64 controller mapper owns input, including controller selection,
raw N64 mappings and deadzones. Its controls appear in the lobby and during
play. Keyboard controls: WASD stick, X A, C B, Z Z-trigger, Enter/Space Start,
Q L, E R, arrow keys C-buttons. The port's external Anchor multiplayer is
disabled; cutscene skips are explicitly disabled on startup. The fork's fast
text, chest, drop and movement defaults are removed.

## Local saves

Normal in-game saves live in IndexedDB under an account-specific filesystem
mount, independent of the room ID and runtime build. Returning in the same
browser/account restores the files. A Web Lock prevents simultaneous tabs for
the same account from overwriting saves. Browser storage failure is reported
instead of starting without persistence.

Export Save downloads the game's save slots and global settings in a versioned
JSON envelope. Import Save validates that envelope, pauses the game, replaces
save files, flushes browser storage and reloads the engine. Clearing site data
also clears local saves, so exports provide independent backups. These are
normal game saves, not arbitrary emulator save states.

## Isolated verification

```
.venv/bin/python -m unittest discover -s tests/games -p oot_test.py
.venv/bin/python tests/games/oot_browser_server.py
.tmp/emsdk/node/24.19.0_64bit/bin/node tests/games/oot_browser.cjs
```

The fixture listens only on loopback port 8076 and uses test authentication,
not the production database. Do not expose its routes publicly.

The running production process must eventually load the updated Python
catalog and room handlers. Do not restart it while users are playing; publishing
build files alone does not reload Python in the running process.

## Verified integration

The isolated Chromium run passed native boot, original-quest save creation,
shared-controller input, native simulation progress, late spectator video and
non-silent audio, local save restoration after destroying the runtime, export
through the download button, rejection of an invalid import, and restoration
of a deleted save through Import Save. Spectators made zero ROM/runtime
requests. The two solo room tests, six Diablo relay regression tests, and eleven
shared Retro Games tests passed. The pinned build recipe also completed an
incremental verification without recompilation.

Production was left running unchanged. Activate only during a safe server
restart after current players have finished.

Account saves (2026-10-09): `app/netplay/saves.py` provides authenticated,
CSRF-protected GET/PUT snapshots for OoT and Diablo. SQLite stores snapshots
under `(current_user.get_id(), game_id)` in `instance/retro-saves.sqlite3`;
include that file in server backups. No production database migration is needed.
Updates use a transactional revision check to reject stale sessions. Browser
IndexedDB remains the local copy; a small localStorage revision/hash records
whether it contains unsynced changes. Startup loads account saves before the
engine reads them. Existing local saves migrate when the account is empty.
Conflicting unsynced copies block startup instead of overwriting progress.
An unavailable account service also blocks startup, protecting existing saves.

Saved files sync every five seconds and on supported save/exit/visibility events.
Wait for “Saved to your account” before switching PCs. Closing immediately or
losing connectivity may leave progress only in that browser until it is reopened.
OoT also flushes on native save completion and before finishing an import.
Diablo uploads hero `.sv` files, not machine-specific configuration. Diablo room
mode persists heroes/inventory, but starts a new dungeon per game; this does not
add single-player world-state saves to its multiplayer engine mode.

The account API requires a safe production reload. Templates omit account sync
when served by the old process, so existing launches keep local persistence.
Tests use a separate temporary SQLite database. `account_saves_test.py` checks
account isolation, authentication, CSRF, validation and revision conflicts;
`account_saves_browser.cjs` checks migration, cross-browser restore and stale
upload rejection. The full OoT browser test also restores a native playthrough
in a fresh browser context.

Verification: both native browser tests passed cross-PC restore (including the
full Diablo hero bytes), original gameplay, and spectator delivery. Eight room
regression tests and two account API tests passed. The broader 175-test run had
one Perfect Dark catalog expectation failure and one profile-roster room setup
error; these are outside the save tests. Diablo's renamed native build was
installed atomically for future launches. Production PID 7670 remained active
with its original October 9 03:02:09 EDT start time; no reload was performed.


## ROM extraction off the main thread (October 21, 2026)

The first launch in a browser extracts the ROM into `oot.o2r` with the native
extractor, which runs for about 20 seconds without yielding. The runtime iframe
is same-origin, so on the page's thread this froze the room page and its
Socket.IO heartbeat (the Engine.IO ping timeout is 20 seconds). The runtime now
runs extraction in a dedicated worker with its own engine instance, fetching
the ROM there and transferring the archive back; the extractor's per-asset
output stays in the worker unless extraction fails. The page's engine loads
only after extraction, so the two instances never overlap in memory. Later
launches read the cached archive (`oot-assets-v1` Cache Storage) as before.
No native rebuild or Python change is involved.

`tests/games/oot_longtask_browser.cjs` boots cold and warm against the fixture
and fails on any main-thread task of 2 seconds or more. Before: cold 21.9–22.5 s
longest task and 8,427 console warnings. After: cold 567–590 ms and 6 warnings;
warm loads were already about 560 ms.
