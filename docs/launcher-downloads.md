# Private Windows launcher preview

The owner requested a private download containing the launcher and all current game data, and
selected a first preview with the three available Windows game executables. This is a personal
test transfer, not a public game download. Original data stays outside source control.

`/launcher-preview/` and `/launcher-preview/download/<release-id>` both use the existing monitoring
owner check: authenticated, active, matching immutable owner ID and username. Other accounts get
404; anonymous requests go to sign-in. The home-page Windows Launcher card is owner-only.
Signing in from this page returns to the preview through the login destination allowlist.

Artifacts live under `instance/launcher-downloads`, outside static routing. `release.json` selects
one fixed basename, byte count and SHA-256. The server rejects malformed metadata, missing or
truncated files and symlinks. All responses disable caching and indexing. File responses support
HEAD and HTTP ranges with authorization on every request, including resumed downloads.

## Preview 2, 21 October 2026

- Installer: `peakdecline-setup-20261021-2.exe`, 1,499,308,628 bytes.
- SHA-256: `196ba0e4005e57a5f56da7cf6a3655c5e171d94ac77f4f6c329e27352af13284`.
- Playable Windows builds: A Link to the Past, Sonic 1 (2013), Sonic 2 (2013).
- Data also included for Diablo, Perfect Dark, Driver 2, Colin McRae Rally 2, Super Mario 64,
  Ocarina of Time, F-Zero X and Mario Kart 64. Their Windows executables are pending.
- ES-DE 3.5.0 portable, collection theme, launcher, DLLs, notices and instructions included.
- Open the EXE, click Install, then Finish. It chooses a short per-user path automatically,
  unpacks the collection and adds desktop and Start-menu shortcuts. No administrator access is
  normally needed. Reinstall and uninstall retain personal saves/settings.
- No server account database, cookies, credentials, personal saves, settings or run logs included.

The portable payload packager is `../peakdecline-harness/tools/package_windows_preview.py`. Its explicit
`--include-game-data` option implements this user's private-bundle request. Packaging inputs and
build outputs stay in that repository's ignored `build/` directory. The ZIP includes a per-file
SHA-256 inventory. All 3,677 bundled file hashes were checked after compression and extraction.
`tools/build_windows_installer.py` in the harness verifies that payload and compiles the installer
with official Inno Setup 7.1.0. See `installer/windows/README.md` there for build instructions.
The original ZIP is retained privately as a rollback artifact.

## Validation and activation

Eleven focused download tests pass, including EXE download instructions, content type and rejection
of executable script extensions. The earlier ZIP release also passed five existing profile tests
and production-app owner/other-account, HEAD and range checks. Windows checks are recorded in the harness
at `docs/windows-development.md`. Windows hardware/controller qualification is still pending.

The final installer passed fresh installation, all payload hashes, shortcut launch, repair,
reinstall preservation and uninstall preservation under an isolated Wine prefix. The published
private EXE copy was SHA-256 verified before replacing metadata atomically. A production-app test
client confirmed the installer page and checksum, actual EXE HEAD and byte-range responses,
anonymous redirection and denial for another real account. The EXE handler is active: the service was restarted on 21 October at 12:34 Toronto time.
This release changes only artifact metadata, so another service restart is unnecessary. Sign in as
the owner and open `https://peakdecline.com/launcher-preview/`. The prior EXE and ZIP remain in the
private directory for rollback.

Preview 2 launches games directly, starts the three Windows games fullscreen even with old
windowed settings, and returns directly to ES-DE on game exit. Windows launcher/game executables
use the GUI subsystem, avoiding console windows. A separate Controller setup system exposes
per-game bindings without interrupting normal launches. The library/theme clearly names each
section. Installing the new EXE over Preview 1 keeps the same desktop shortcut and personal files.

For another release, build to a fresh directory, verify its file inventory, copy the artifact to a
temporary filename under `instance/launcher-downloads`, verify its SHA-256, rename it to its final
name, and replace `release.json` atomically last. Metadata is read per request; later artifact
updates do not require another service restart. Never place these private bundles in `static/`.


Preview 2's upgrade regression passed, including the existing desktop shortcut, both ES-DE sections,
all payload hashes (with exact preservation checks for existing personal files), saved Sonic
records, native settings and a frontend volume preference. The upgraded uninstaller preserves
personal files. The staged EXE matched its SHA-256 before metadata activation. Production-app
checks confirmed the new owner page, actual EXE HEAD and byte-range responses, and access denial
for anonymous/other accounts. No service restart was needed for this metadata-only release.

## Preview 3: updater enabled, 21 October 2026

The current private download is `peakdecline-setup-20261021-3.exe`, 1,509,420,600 bytes,
SHA-256 `b325f19fc02a23b12c9b6c93af9f36da3a6fa95d1c8ee32826a190a821372f48`.
Install once over Preview 2 to replace the shortcut with the updater-enabled entry
point. The three playable Windows games and all eleven data sets are retained.

The desktop shortcut checks for signed updates in the background, downloads changed
files, and offers installation/restart after exiting ES-DE. Saves, records, controller
settings and personal ES-DE state are excluded. Recovery journals restore failed or
interrupted installations. The stable runtime and trust anchor require an installer
replacement if they change; ordinary program/game/data updates use the new channel.

`app/launcher_updates.py` exposes `/launcher-updates/latest` and content-addressed
objects only to the dedicated client bearer credential. This is separate from browser
owner authorization; the private installer includes that credential, not the account
password/cookies. The server stores its hash under `instance/launcher-updates`, mode
700 for the directory and 600 for private files. Signing keys remain outside this
repository. Never serve the update directory under `static/`.

The owner restarted the website at **14:39:15 Toronto time**. Live authenticated
manifest access returns 200, anonymous access returns 404, and the bundled Windows
runtime verified a production signature and downloaded/hash-checked a real program
object over HTTPS. Subsequent releases activate by atomically changing `latest.json`
and need no restart. Publication instructions are in the harness's
`docs/windows-updates.md`; the next update sequence is 4.

Seventeen website tests pass. Production-app checks verified the owner download
page, the real EXE HEAD/range responses, other-account denial, signed feed and object
authorization. The installer upgrade/desktop startup/settings preservation/uninstall
regression passed under Wine. Full physical Windows qualification remains pending.
Preview 2 metadata and its EXE remain private for rollback.
