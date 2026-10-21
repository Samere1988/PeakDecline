# Account saves

All current games with persistent progress use the signed-in PeakDecline account.
The server is authoritative; browser storage provides a retry/recovery copy.
Sign into the same account on a compatible browser, start the same game, and its
save restores before play. Native saves transfer when the game writes them; this
is not continuous mid-mission saving in games that lack save states. Wait for the
saved status before switching devices. Browser/GPU requirements still apply.

## Coverage

- GTA V: native Documents files plus modification times; restored into the upstream
  account-specific IndexedDB before the game module starts. Polls every two seconds
  and receives a notification after native writes. Existing local account saves migrate.
- Derby: credits, races and wins; account-specific browser backup plus server snapshots.
  Previous shared browser progress has an explicit import button.
- EmulatorJS library and watch-room host: per-ROM account key, full save state and
  battery save; snapshots every ten seconds, manual save, hide and game switch.
  EmulatorJS is pinned to 4.2.3. Legacy shared battery storage is detached before
  core startup; existing matching browser saves and downloaded states can be imported
  explicitly. Legacy storage is retained. Watch-room viewers do not own the emulator.
- Mario Kart 64: native 512-byte EEPROM, including the legacy online route. The
  rebuilt port reads `/eeprom.bin` before startup and writes it on native EEPROM writes.
- F-Zero X, Smash Bros., Mario Party 1 and 2: native SRAM/save/EEPROM snapshots.
- Perfect Dark, Ocarina of Time, Diablo, Mario 64, Sonic 1/2, A Link to the Past and
  Driver 2 retain their existing account save adapters.
- Catan retains its existing server-owned game/session database.

Shared native multiplayer matches distribute one immutable initial snapshot from
player one's account. Only player one uploads progress; peers and spectators use
that initial snapshot without writing it to their own account. Saves never appear
in public lobby listings. Restarting a match may require reopening its lobby when
another session or a pending upload changed the starting revision.

## Storage and recovery

`instance/retro-saves.sqlite3` stores account/game/revision snapshots, with the
previous five revisions in `save_history`. Back up this database with the site.
`/games/saves/<game>` and the compatible `/games/retro/saves/<game>` routes require
login, validate native file names and sizes, require session CSRF for PUT, and reject
stale revisions. Responses are private/no-store. Emulator keys hash the relative ROM
path and must correspond to a ROM in the server library. Request limit is 48 MiB
for GTA/emulator snapshots and 16 MiB for other games (including base64 overhead).

New adapters keep last-confirmed and pending snapshots in `peak-account-sync-v1`
IndexedDB under account/game keys. Failed uploads retry. Conflicts stop uploads and
provide download-backup and use-server-save actions; the latter archives the browser
copy under a timestamped recovery key before restoring and reloading. Do not clear
browser storage while an upload is pending. Existing adapters retain their prior
conflict/recovery UI. Server cannot retrieve local saves until that browser is opened.

## Validation and deployment (2026-10-11)

Python suites: `account_saves_test.py`, `mk64_room_test.py`, `retro_test.py`,
`gta5_test.py`. Isolated fixture: `all_saves_browser_server.py` on loopback 8078,
with temporary save database and fake accounts. Never use fixture authentication
in production.

Browser suites: `all_saves_browser.cjs` (isolation, conflicts/recovery, spectator
ownership, GTA native files/timestamps and Derby), `native_saves_browser.cjs`
(actual MK64/F-Zero/Smash/Mario Party 1/2 boots and fresh-context native restoration),
`emulator_saves_browser.cjs` (real SNES core and fresh-context save-state startup).
GTA save bootstrap is tested independently from its expensive engine; previous
headed GPU validation reached the sandbox world. This is not a complete GTA
playthrough or a claim that every EmulatorJS core was exercised.

MK64 build source is pinned to `aeef740f2132bfc91ca767dad824570df42ce920`, using the
local Emscripten 4.0.18 toolchain through `PEAK_EMCC`. Staged output is
`.tmp/mk64-save-build`; previous production JS/Wasm are in
`.tmp/account-save-backup`. Publish the two build files to `instance/mk64/build`,
then restart `peakdecline.service` to activate the Python/template changes.

Deployment confirmed at 12:48 EDT: production service restarted successfully, new
save routes require login (302), and the live account sync script matches the tested
file. Authenticated save/restore validation used the isolated browser fixtures above.
