# Cities & Knights artwork

These 177 Colonist images were imported for the Cities & Knights
implementation. The PeakDecline owner confirmed a license to use Colonist art;
see the [parent artwork notes](../README.md) for the distribution terms.

The directory contains:

| Category | Files | Contents |
| --- | ---: | --- |
| Knights | 74 | Three levels, active and inactive states, twelve colors, plus two atlas sprites |
| Progress cards | 29 | Politics, science, and trade fronts and backs |
| City walls | 12 | One marker for each player color |
| Merchant | 12 | One marker for each player color |
| Dice | 10 | Six red die faces and four event die faces |
| Reference | 10 | City improvements, track diagrams, and related icons |
| Barbarians | 6 | Ship, ordinary and attack track hexes, defender, and battle icons |
| Metropolises | 4 | Three discipline markers and the status icon |
| Commodities | 3 | Cloth, coin, and paper cards |
| Emblems | 2 | Cities & Knights and its 5–6 player emblem |
| Interface | 15 | Game utility and chat buttons, action and road icons, and player portraits |

`sources.json` records the source URL, byte length, and SHA-256 checksum for
every image. The two PNG knight sprites were restored to their original
transparent canvas from the Colonist game sprite atlas; their frame and crop
coordinates are also recorded in the manifest. The ordinary barbarian hex is
extracted from Colonist's tracker reference image, with its obscured tip
restored from the other side of that same hex. The repeatable importer is
[`tools/import-catan-cities-knights.py`](../../../../../tools/import-catan-cities-knights.py).

The previously imported `../sounds/` library contains the Cities & Knights
effects for city improvements, walls, knights, metropolises, and related events.
Gameplay serves artwork and audio from local files.
