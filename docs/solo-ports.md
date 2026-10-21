# Additional single-player source ports

Implemented October 9, 2026. No production service restart was performed.

| Game | Engine | Status |
| --- | --- | --- |
| Super Mario 64 | sm64pc/sm64ex | Built and browser-tested with existing US ROM |
| A Link to the Past | snesrev/zelda3 | Built and browser-tested with existing US ROM |
| Sonic 1 (2013) | mattConn/Sonic-Decompilation-WASM | Built with supplied mobile data; gameplay, spectators and account saves tested |
| Sonic 2 (2013) | same RSDKv4 engine | Built with supplied mobile data; gameplay, spectators and account saves tested |
| Driver 2 | OpenDriver2/REDRIVER2 + PsyCross | Engine built; missing original game data; gameplay unverified |

The running server must reload the Python catalog before these entries appear. Arrange that separately when existing sessions can be interrupted safely. Missing assets keep an entry unavailable.

## Original assets

Mario uses the existing US ROM with SHA-1 `9bef1128717f958171a4afac3ed78ee2bb4e86ce`. Zelda uses the existing US ROM with SHA-256 `66871d66be19ad2c34c927d6b14cd8eb6fc3181965b6e517cb361f7316009cfb`. The build extracts their assets locally.

This browser build uses the **2013 mobile editions**, not Genesis ROMs. Newer RSDKv4 upstream releases also support Sonic Origins datapacks, but Origins compatibility has not been implemented or tested in this older browser fork. Supply each game's `Data.rsdk` from an existing installation or backup, or an APK containing exactly one `Data.rsdk` or `Data.rsdk.xmf` file. The importer checks the `RSDKvB` header. Target locations are `instance/sonic1/data/Data.rsdk` and `instance/sonic2/data/Data.rsdk`. The user supplied mobile-format files in Downloads. Sonic 1 SHA-256: `59760e72c1c75cbe916c988e391a752ab887d4bd3098f95b0e0151e777898ba4`. Sonic 2 SHA-256: `7476a3287a98344bf867f98632874d7cf6010057d2e5b18685e0704090241ce5`; the second file exactly matches the archive inside the supplied Sonic 2 APK. See the [browser port instructions](https://github.com/mattConn/Sonic-Decompilation-WASM).

Driver requires a complete installed REDRIVER2 data folder prepared using [upstream installation instructions](https://github.com/OpenDriver2/REDRIVER2/wiki/Installation-instructions). Both discs are required. The build accepts a tree containing `DRIVER2/LEVELS/{CHICAGO,HAVANA,VEGAS,RIO}.LEV`, or an installed tree containing `install/Driver2CD1.bin` and `install/Driver2CD2.bin`. This preliminary check does not prove all audio, movies and configuration are present. Validate gameplay, sound and saving after importing data. Its packaged assets become `instance/driver2/build/driver2.data`.

## Builds

Source commits are pinned in `ports/{sm64,zelda3,sonic,driver2}/sources.json`. Browser changes are recorded alongside them as patches; Driver also has a separate PsyCross patch and CMake file. Original assets are not stored in those port directories. Upstream license notices are retained alongside the Sonic, Zelda and Driver patches. Sonic's engine credits Christian Whitehead, Rubberduckycooly and RMGRich; its license includes noncommercial and asset-distribution restrictions.

Use Emscripten 4.0.18, native C/C++ build tools, Git, Python with Pillow and PyYAML, and `.venv/bin/cmake` plus `.venv/bin/ninja`. This workspace has a local SDK under `.tmp/emsdk` and extracted native compiler tools under `.tmp/native-tools/bin`; the recipe prepends that local tools directory when present.

```bash
source .tmp/emsdk/emsdk_env.sh
.venv/bin/python ports/solo/build.py all --publish
.venv/bin/python ports/solo/build.py sonic --publish --sonic1-data /path/to/sonic1/Data.rsdk --sonic2-data /path/to/sonic2/Data.rsdk
.venv/bin/python ports/solo/build.py driver2 --publish --driver-data /path/to/installed-redriver2
```

Run builds/publishing outside active sessions for the affected game: replacing JS and WASM is not a transactional deployment. These commands never restart the service.

## Lobby, spectators and saves

Each entry has one player seat and the existing spectator lobby. The host runs the native WebAssembly engine. Spectators receive canvas frames and audio, without downloading or running the engine or game assets. Controller profiles are configurable per game. The shared player also supports keyboard input, fullscreen and volume.

Native save files synchronize through the existing authenticated account-save API and SQLite store. Saves are scoped to account and game, with revision checks to prevent silent concurrent overwrites. Browser-local IDBFS paths and tab locks are also scoped to account and game. A fresh device downloads the account save before the engine starts. Spectators never write player saves.

Mario stores `sm64_save_file.bin` (512 bytes). Zelda stores `sram.dat` (8192 bytes) and optional numbered native save-state files. Sonic allows SData/SGame/UData files; Driver allows config/progress files. Only allowlisted native files are uploaded. Saving still depends on reaching the game's own save points; account synchronization does not turn every frame into a save. Export/import provides an additional portable JSON backup.

## Validation

`tests/games/solo_ports_test.py` checks private asset access, readiness gating, one-player rooms and late spectators. `tests/games/account_saves_test.py` covers per-account storage and native file validation. Existing OoT and retro room tests also passed.

`tests/games/solo_ports_browser.cjs` runs against the isolated loopback fixture in `tests/games/oot_browser_server.py`, using a temporary database. Mario, Zelda, Sonic 1 and Sonic 2 passed actual native boot, input, spectator video, non-silent audio, native save upload and byte-for-byte restoration in a fresh browser context. Spectators made no native runtime/build/data requests. These checks do not constitute full playthrough testing. Driver requires equivalent browser verification after assets are supplied. Sonic checks select a real save slot, reach Green Hill / Emerald Hill, move and jump, and verify that the playthrough slot survives a fresh browser context.

Sonic browser patches initialize only supported SDL subsystems (the upstream all-subsystems call left audio uninitialized) and schedule the engine at 60 Hz without the native blocking delay. The APK importer also accepts `assets/Data.rsdk.xmf`.
