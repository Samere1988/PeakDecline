# Colonist game artwork

Graphics downloaded from Colonist's publicly served base-game assets on
2026-09-16. The PeakDecline owner confirmed that they hold a license for this use.
These are third-party graphics, not original PeakDecline art or an open-source
asset pack. Retain the applicable license and attribution when distributing.

`sources.json` records each source URL, local filename, and SHA-256 checksum.
SVG files are used as image resources without injecting their markup into the
page. All assets are served locally; gameplay makes no requests to Colonist.

The wood/lumber, sheep/wool, and wheat/grain names are mapped to PeakDecline's
existing resource names. Piece colors follow red, blue, orange, and green seats.

The interface assets include original player frames, ribbons, card backs, bank,
trade and hourglass icons, award icons, and action-button backgrounds.
`port-pier.png` is the original `port_pier` frame extracted losslessly from the
public game sprite atlas and restored to its original transparent 96×288 canvas.
Its atlas URL and crop metadata are recorded in `sources.json`.

`sounds/` contains all 48 MP3 effects referenced by the inspected public game
bundles, including base-game, lobby, and expansion effects. Its own `sources.json`
records original URLs, sizes, and checksums. Current game actions use the relevant
effects; expansion and lobby sounds are retained for future features. Audio starts
only after player interaction, supports persistent muting, and stops when hidden.
# Development card artwork

The five `dev-*.svg` files were imported from Colonist on 2026-09-18 using
`tools/import-catan-development-cards.ps1`, replacing the temporary local artwork.
Their source URLs and SHA-256 checksums are recorded in `sources.json`.
