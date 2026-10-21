# Solo AI visibility investigation — October 13, 2026

The report described AI opponents disappearing for several seconds in solo
play, without obvious flickering or item use.

## Captured behavior

A deterministic three-lap solo race using the deployed 60 FPS build recorded
an AI racer with `BOO_EFFECT` active on simulation frames 4868 through 5074
(about 6.9 seconds). Its native visibility flag was set on frames 5034–5074,
including frame 5040 when it remained in the camera's draw list during Boo.
The race then returned that AI to its normal opacity. Screenshots and the
per-frame trace are under `.tmp/mk64-visibility-20261013/`.

This is a plausible explanation of the report, not proof of the user's exact
episode. CPU strategy code can activate Boo automatically; it does not require
an obvious item-box pickup. The opponent opacity fades to zero for the effect,
and its activation sound/particle setup is restricted to human players. That
behavior exists in the pinned upstream game and was not introduced by the
60 FPS change.

The trace covered 9,200 render passes with no fully transparent 64×32 texture
uploads used in draws. This is a targeted texture check, not a guarantee that
every sprite or visibility condition is correct. Separately, 23 original-frame
screenshots were pixel-identical between 30 FPS and 60 FPS presentation over
the opening part of the race.

## Separate interpolation defect fixed

The old guard compared absolute matrix elements. A lightning-sized kart
turning 180 degrees could pass that guard, while the blended basis collapsed
to zero and made the intermediate sprite degenerate. This can cause a brief
rendering loss; it does not explain a sustained multi-second disappearance.

The shared interpolation helper now checks normalized orientation, basis
lengths, degeneracy and handedness before blending affine matrices. Unsafe
transitions use the current transform. Perspective handling is separate.
`tests/games/mk64_matrix_interpolation.c` covers this failure and ordinary
motion, shrinking, reflections, degenerate bases, projection and camera cuts.

The rebuilt browser candidate passed 1,150 simulation-hash comparisons,
normal game speed, changed intermediate transforms and all three shutdown
checks. It measured 60.06 render FPS and 29.95 simulation FPS without browser
errors. Results: `.tmp/mk64-visibility-20261013/presentation-regression.json`.

The matching JavaScript/WASM pair containing the guard was published atomically
to `instance/mk64/build`. The prior build and SHA-256 manifest are retained in
the investigation directory. Reload Retro Games to load the new runtime; no
Python service restart is required for this native-only change.
