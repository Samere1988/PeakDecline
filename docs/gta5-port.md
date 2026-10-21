# GTA V browser port

Installed and activated October 11, 2026. Entry: `/games/gta5`, linked from `/games`.
The user restarted the service; public HTTPS requests to the landing page and
Wasm asset correctly redirect unauthenticated visitors to login. Production
authenticated playback was not retested; rendered sandbox startup was verified
through the isolated fixture using the same game routes and installed assets.

The preserved PlayGTA5 `full-game-v1` release from
https://github.com/alihammoud21/playgta5 supplies the compiled browser runtime.
This is not an engine source build. All 14 release ZIPs and 12,482 game files
(21,158,604,965 bytes) were checked against the release SHA-256 inventory.
The release inventory's SHA-256 is
`6def50e4232646763c1ad4c7e317a5afbd884b81c428e46f975ca7f58ee1d835`.

## Layout

- `instance/gta5/game`: original, checksum-verified runtime and data.
- `instance/gta5/verified.json`: installation receipt, required for availability.
- `app/gta5.py`: authenticated routes, runtime URL adaptation, range serving,
  compressed/uncompressed batch reads, and browser isolation headers.
- `templates/gta5.html`: browser checks and Story/Sandbox launch choices.
- `tools/install-gta5.py`: safe extraction and per-file verification from
  previously downloaded ZIPs, inventory, and checksums. Upstream installers
  and executables are not run.

All game routes require the existing PeakDecline login. No nginx changes or
public static asset alias are needed. JavaScript and HTML are adapted when
served to scope root-relative paths to `/games/gta5`; originals remain intact.
Byte-range requests return 206 with Content-Range. The batch endpoint accepts
at most 1 MiB of JSON, 1,000 file ranges and 64 MiB of response data. Resolved
paths must remain within the data/build roots, including through symlinks.

The runtime uses WebGPU, Wasm Memory64, shared memory and workers. Launch
defaults are 2560×1440, 30 FPS and the upstream reduced-memory profile. The
game loads assets on demand and caches them in the browser. A fast first-load
connection and capable desktop GPU are recommended.

Saves/settings retain the upstream IndexedDB implementation, scoped to a hash of
the authenticated account ID, and synchronize native `/userdata/Documents/` files
and timestamps with `/games/saves/gta5`. Server saves restore before engine startup.
Existing account-scoped browser saves migrate on first launch. Wait for the saved
status before switching devices; concurrent edits preserve a browser recovery copy.
See `docs/account-saves.md`. There is no multiplayer integration. Client diagnostic
uploads are discarded rather than persisted.

## Validation and deployment

Run `.venv/bin/python tests/games/gta5_test.py` for isolated authentication,
URL rewriting, per-account storage names, range/MIME, batch compression/EOF,
input limits, path/symlink traversal and incomplete-install checks.

Browser validation reached the rendered sandbox world with the RTX 3080 in
Chromium. The initial headless Vulkan adapter was unavailable; use a headed
browser for this host. Software SwiftShader produced graphics errors and is
not a validated fallback. To repeat the smoke check, start
`.venv/bin/python tests/games/gta5_browser_server.py`, then run
`VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/nvidia_icd.json node tests/games/gta5_browser.cjs`.
The fixture is loopback-only with fake test accounts and no production database
access. Screenshots are saved under `.tmp/gta5-*.png`. This is a startup smoke
test, not a complete playthrough or save/restore verification.

The current production service does not reload Python automatically. Activate
the new routes with `sudo systemctl restart peakdecline.service`; this briefly
interrupts active site sessions. Administrator authentication is required.
After restart, verify `/games/gta5` redirects unauthenticated visitors to login,
then test the launch as a signed-in user. A loading screen alone does not verify
gameplay or graphics compatibility.

Rollback: remove the GTA V card from `templates/games.html`, remove its route
registration from `app/routes.py`, and restart the service. Retain the private
asset directory if a later reinstall is wanted.
