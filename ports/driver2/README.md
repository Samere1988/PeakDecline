# Driver 2 browser port

REDRIVER2 is compiled to WebAssembly with its native PsyCross graphics/API layer.
There is no console CPU emulator. The source and submodule revisions are pinned in
sources.json. Browser changes are captured in browser.patch and psycross.patch.

The existing Retro Games lobby provides one player, late spectators, controller
setup, video/audio streaming and account-linked saves. Only the player downloads
and executes game assets. Spectators receive the shared media stream.

## Assets and build

Supply a complete installed REDRIVER2 data tree with DRIVER2/LEVELS containing
CHICAGO, HAVANA, VEGAS and RIO .LEV files and the extracted FMV AVI movies.
Windows executables and DLLs are not included or executed.

With the project's Emscripten SDK on PATH:

    .venv/bin/python ports/solo/build.py driver2 --driver-data /path/to/installed/tree --publish

The startup preload is about 162 MB (155 MiB). Movies are authenticated downloads
loaded on demand, then removed from the WebAssembly filesystem. The AVI files
already contain audio; separate WAV sidecars are not preloaded. The browser yields
during playback so input, audio and spectator delivery continue working.

Publication writes instance/driver2/build and instance/driver2/data/fmv. The new
streamed-assets-v1.json manifest gates availability. The previous assets.json
marker is deliberately absent during the initial rollout: the old server keeps
the game unavailable until a restart loads the matching catalog and FMV route.
No build or publication command restarts the live service.

## Saves

Native config.dat and progress.dat live under /save, scoped to the signed-in
account, and sync through the existing account-save service. Options > Save
Settings creates config.dat. Completed story missions write progress.dat;
Undercover > Load Game resumes that progress. This does not save an arbitrary
mid-mission position. Wait for the site's save status before leaving.

## Validation (2026-10-09)

A separate loopback fixture used temporary databases and saves, never production
accounts. Native intro/story cinematics, the first mission and Chicago Take A
Ride driving were checked in Chromium. The full campaign has not been tested.

Automated checks passed:

- Shared single-player lobby and late-spectator constraints.
- Authenticated FMV route, range requests and missing-file handling.
- Spectator video and nonzero audio without downloading game assets.
- Real native config.dat creation through Options > Save Settings.
- Byte-identical save restoration in a fresh browser context for the same account.
- Account isolation, conflict handling and progress.dat path validation.

Run tests:

    PYTHONPATH=tests/games .venv/bin/python -m unittest solo_ports_test account_saves_test
    .venv/bin/python tests/games/driver2_browser_server.py
    SOLO_GAMES=driver2 node tests/games/solo_ports_browser.cjs

The browser fixture listens on 127.0.0.1:8076 and uses .tmp/redriver2/peak-build.
