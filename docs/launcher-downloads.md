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

## Preview 1, 20 October 2026

- Installer: `peakdecline-setup-20261020-1.exe`, 1,499,298,114 bytes.
- SHA-256: `65b5535127657c2e94051afb724cfc15993d8d1ab6e0dec08bd8329dbbcfcbab`.
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
anonymous redirection and denial for another real account. These local checks use the updated
application code; the running service still needs the restart below.

The existing ZIP route is active. The updated EXE handler requires restarting the running Flask
service after files are installed:

```sh
sudo systemctl restart peakdecline.service
```

The service manager required administrator authentication, so the agent could not perform that
restart. Source and the verified private artifact are installed; activation is pending this step.
The old running handler accepts ZIP filenames only, so the page may show that the download is being
prepared until it loads the updated EXE handler. The previous ZIP and
`release-portable-20261020-1.json` remain in the private directory for rollback.
After restarting, sign in as the owner and open `https://peakdecline.com/launcher-preview/`.

For another release, build to a fresh directory, verify its file inventory, copy the artifact to a
temporary filename under `instance/launcher-downloads`, verify its SHA-256, rename it to its final
name, and replace `release.json` atomically last. Metadata is read per request; later artifact
updates do not require another service restart. Never place these private bundles in `static/`.
