# Mario Kart visual audit — October 15, 2026

The reported mode was two-player Grand Prix. Three rendering defects were
identified and corrected in the browser port; the original game assets were
not missing or corrupt.

## Findings and changes

1. **Lakitu alternated in apparent size at 60 FPS.** Camera matrices were
   interpolated, while his matrix came from an untracked sequential HUD pool.
   A moving camera therefore saw his current position from the previous half
   frame's viewpoint. The lap-sign reproduction measured about 9.99% average
   width change between the two presentations of one simulation frame, even
   with HD replacements disabled. Explicit per-player matrix registration now
   interpolates Lakitu with the camera. The same six-frame sample averaged
   0.32%; remaining changes are ordinary movement. History is keyed by Lakitu's
   role, and visibility gaps, scene changes and unsafe transforms bypass it.
   Sequential HUD pool indices are not treated as persistent object identities.

2. **Results names and scores were separated by widescreen HUD anchoring.**
   Each glyph/rectangle inherited the racing layout policy. Glyphs crossing
   position thresholds received different offsets. Menu display-list markers
   now select a consistent proportional layout for results, pause and menus,
   while the race HUD retains edge anchoring. Layout state resets per pass.

3. **Entire result rows disappeared against track depth.** The interpreter
   enabled depth testing from the RSP geometry flag alone, ignoring the RDP
   depth-compare flag. Font commands inherit the geometry flag but explicitly
   use a render mode without depth comparison. The interpreter now respects
   both controls; depth writes are separately gated. The WebGL backend supports
   write-only passes using `GL_ALWAYS` and restores that policy after FXAA and
   track-TV rendering. This shared correction also applies to other overlays
   with the same render modes.

## Verification

- Two-player Grand Prix completed all three laps using CPU steering while
  retaining both human seats. The finished points table was visually inspected.
  Six consecutive presentations contain all eight names/score rows; every row
  has more than 6,000 visible text pixels in its expected region. Evidence:
  `.tmp/mk64-visual-audit/final/`.
- A separate native 30/60 FPS comparison matched all 1,150 gameplay hashes.
  It measured 29.99 simulation frames/sec and 59.97 presentations/sec in the
  upgraded mode, with normal timer speed and no browser errors. Cooperative
  shutdown, blocked input and network-failure shutdown checks also passed.
- Actual GPU vertex captures measure the lap sign in both split-screen views.
  `tests/games/mk64_visual_browser.cjs` rejects size oscillations above 2% and,
  with `MK64_VISUAL_ENDURANCE=1`, checks all eight results rows. The lap-sign
  mode uses a targeted native-object-state injection; it does not pretend that
  an entire lap was naturally completed in the short test.
- The matrix-history regression exercises relative camera/actor depth, role
  changes, visibility gaps, scene cuts and the rule that intermediate frames
  never overwrite history. Existing matrix, layout, HD-loader and HD-decoder
  tests passed. C regressions were compiled with Emscripten and run under Node
  because this host lacks a complete native C linker toolchain.
- Original-asset integrity: 627 media fragments, 3,736 bank objects across 13
  banks, and 84 endian overlays matched their pinned checksums. Recursive source
  includes and the pinned source manifest also passed.
- HD integrity: all 24,569 manifest mappings resolved to 24,455 decodable WebP
  files with matching dimensions and filename hashes. No power-of-two original
  was mapped to a non-power-of-two replacement, avoiding incomplete repeating
  WebGL textures. No missing or corrupt files were found.

## Scope and remaining coverage

This checks the reported two-player GP flow, shared rendering paths, asset
integrity and presentation/state separation. It is not an exhaustive visual
playthrough of all courses, battle arenas, GPUs or rescue situations. Particles
and unregistered world actors still use native animation cadence; this change
only adds stable transform history for Lakitu. His common rendering path covers
countdown, lap signs, finish, wrong-way and rescue roles, but targeted screenshots
and measurements cover countdown/lap signs, plus the natural GP finish.

The HD manifest currently contains full Lakitu frames, while his native renderer
uploads overlapping half sprites (56×36 or 72×28). Those halves fall back to the
original artwork. This is a texture-pack coverage gap, not missing game data,
and was not the cause of the size flicker; the non-HD control reproduced it.

The final candidate also passed the real two-player Retro Games flow: audio,
controls, 200 matching race hashes, retained reconnect, two native restarts and
cooperative shutdown on departure. Player presentation rates were 60.05 and
59.97 FPS. Two older test harnesses needed updates for asynchronous shared-lobby
cleanup (retaining the disposed module and providing/awaiting timer cleanup);
no networking production code was changed in this audit.

The permanent short visual regression passes on the candidate and rejects the
old installed build for an 11.06% same-frame size oscillation with HD disabled.
The permanent endurance regression also passed all six eight-row samples.

Published on 2026-10-16 to `instance/mk64/build` after verifying the candidate,
installed files and source hashes against the qualification manifest. The JS
loader was identical, so only the WASM required an atomic replacement. The
previous pair is backed up in `.tmp/mk64-visual-audit/installed-before-publish/`.
No production service restart was required; existing browser sessions need to
reload Retro Games to load the updated native build.

The installed build passed the short Lakitu visual regression (largest measured
same-frame width change 0.74%) and the full three-lap two-player GP regression.
All eight results rows appeared in six consecutive presentation samples, with
no browser or GL errors. The results screenshot was also visually checked.
Evidence is in `.tmp/mk64-visual-audit/installed-smoke/report.json` and
`.tmp/mk64-visual-audit/installed-grand-prix/report.json`. These checks used an
isolated localhost harness serving the installed files. The production service
remained active and returned HTTP 200. Exact hashes, publication status, checks
and limits are recorded in `.tmp/mk64-visual-audit/release.json`.
