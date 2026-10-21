# Diablo / DevilutionX

Diablo is registered in the Retro Games room picker as `devilutionx`. It uses the
full Diablo archive at `instance/devilutionx/data/diabdat.mpq`, served by an
authenticated route. It does not use shareware data or expose the archive under
`static/`. The original file in Downloads is left intact.

## Build

The upstream commit is pinned in `ports/devilutionx/sources.json`. With the
existing Emscripten SDK in `.tmp/emsdk` and CMake/Ninja in the Python environment:

```sh
.venv/bin/python ports/devilutionx/build.py --publish
```

The script checks out the pinned source, applies checked source replacements to a
separate build copy, and publishes the JS, WASM, asset bundle and license to
`instance/devilutionx/build`. No proprietary game data is included in that bundle.
The catalog disables the game if any required file is missing.

## Playing and saves

Create a room, choose player or spectator roles, ready up, and start as usual.
Each player chooses **Multi Player** and selects or creates their own hero. The
first player creates the native game; the other seats automatically join it.
The native game supports four players. The room's first seat hosts the game even
if the room owner is spectating. Difficulty is Normal and game speed is 20 ticks
per second, with running in town disabled. Native keyboard, mouse, gamepad and touch controls remain available.

The full archive is roughly 494 MiB, so the first load can take a while. Saves and
settings live in IndexedDB, separated by signed-in account. Clearing site data
removes them. The runtime uses IDBFS automatic persistence and flushes saves when
returning to the lobby. Save files are local to that browser/device.

A player leaving or disconnecting ends the room's game, matching the room
service's non-reconnecting backends. Return to the lobby and start another room;
characters persist. Spectators can join and leave a running game without taking
a player slot. They see the first player's view at 10 fps, with mono 16 kHz
sound after pressing **Enable sound**. Spectators do not load the full archive.
Media uses the site's authenticated Socket.IO connection rather than a separate
peer connection. It is bounded and dropped under backpressure.

## Protocol

`app/netplay/native.py` implements the join handshake from the pinned upstream
`dvlnet/packet.h`. It assigns player IDs from authenticated room seats and relays
native messages/turns. Clients cannot send as another seat, forge server join
packets, send game packets as spectators, or stream media from another seat.
Rooms and epochs isolate both game packets and presentation. TLS provides
transport encryption; upstream packet encryption is disabled for this adapter.

`ports/devilutionx/runtime/peak_net.cpp` adapts that relay to upstream `net::base`.
The build skips native network menus, connects the selected hero to its assigned
room, and suppresses the upstream inline Emscripten network thread so the main
loop can pump turns. Read-only native state exports support gameplay checks.

## Checks

```sh
.venv/bin/python tests/games/devilutionx_test.py
.venv/bin/python tests/games/retro_test.py
```

The tests use isolated Flask/Socket.IO sessions and temporary instance data.
The real-runtime browser check verifies two independently loaded full-game
clients, synchronized movement, a 20-second simulation soak, live spectator
video/audio without downloading the archive, and heroes surviving a page reload:

```sh
.venv/bin/python tests/games/devilutionx_browser_server.py
# In another terminal (uses the installed Playwright/Chromium by default):
node tests/games/devilutionx_browser.cjs
```

Override `PLAYWRIGHT_PATH`, `CHROMIUM_PATH`, or `RETRO_TEST_URL` for another
workstation. The fixture listens only on localhost and uses test identities;
it must never be exposed through the public reverse proxy.

## Service handoff

The system unit is `peakdecline.service`. If a temporary
`peakdecline-recovery.service` user unit is serving port 8000, it has the same
working directory, executable, environment, and restart policy. The user manager
has lingering enabled, so it remains available after logout. The transient user
unit disappears on reboot; the enabled system unit resumes normal startup.
To hand back sooner with administrator access, stop the temporary worker and
start the system unit:

```sh
systemctl --user stop peakdecline-recovery.service
sudo systemctl start peakdecline.service
```

Do not run both workers on port 8000 at once. A normal managed deployment should
use `sudo systemctl restart peakdecline.service`.
