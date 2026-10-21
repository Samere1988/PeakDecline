# Mario Party 2 board and minigame coverage

Isolated Chromium tests of the release Wasm. The live service and production assets are not changed.

Results: 69 PASS, 3 VISUAL_ISSUE.

Board cases set the board index during normal setup and advance into play. Minigame cases set the chosen minigame at the normal instructions transition, configure CPU players and the cartridge category’s team grouping, then execute original code. Gameplay frames render continuously after the target is entered. The independent replay skips most presentation and compares guest-state hashes every 600 ticks plus the final state. These are targeted regression checks, not complete campaigns or exhaustive human-controller testing.

PASS means the target ran, produced audio, and exited (minigames), or reached the next board turn (boards), without a runtime/WebGL error. INCOMPLETE means the frame budget expired before completion; it does not establish a game bug. Fixture-only failures require reproduction through normal menu inputs. MATCH checks deterministic execution and presentation independence; actual network transport has separate lobby tests.

| Case | Result | Independent replay | Ticks |
|---|---|---|---|
| Bowser Slots | PASS | MATCH | 16064 |
| Roll Out The Barrels | PASS | MATCH | 16568 |
| Coffin Congestion | PASS | MATCH | 16502 |
| Hammer Slammer | PASS | MATCH | 15852 |
| Give Me ABrake | PASS | MATCH | 15858 |
| Mallet Go Round | PASS | MATCH | 16148 |
| Grab Bag | PASS | MATCH | 17764 |
| Bumper Balloon Cars | PASS | MATCH | 16660 |
| Rakin Em In | PASS | MATCH | 16858 |
| Day At The Races | VISUAL_ISSUE | MATCH | 17968 |
| Face Lift | PASS | MATCH | 17384 |
| Crazy Cutters | PASS | MATCH | 16980 |
| Hot Bob Omb | PASS | MATCH | 18084 |
| Bowl Over | PASS | MATCH | 15820 |
| Rainbow Run | PASS | MATCH | 18372 |
| Crane Game | PASS | MATCH | 19466 |
| Move To The Music | PASS | MATCH | 17264 |
| Bob Omb Barrage | PASS | MATCH | 16170 |
| Look Away | PASS | MATCH | 16906 |
| Shock Drop Or Roll | PASS | MATCH | 17398 |
| Lights Out | PASS | MATCH | 15610 |
| Filet Relay | VISUAL_ISSUE | MATCH | 16894 |
| Archerival | PASS | MATCH | 16974 |
| Toad Bandstand | PASS | MATCH | 17908 |
| Bobsled Run | PASS | MATCH | 19430 |
| Handcar Havoc | PASS | MATCH | 17086 |
| Balloon Burst | PASS | MATCH | 16176 |
| Sky Pilots | PASS | MATCH | 19174 |
| Speed Hockey | PASS | MATCH | 17370 |
| Cake Factory | PASS | MATCH | 17022 |
| Dungeon Dash | PASS | MATCH | 17636 |
| Magnet Carta | PASS | MATCH | 17330 |
| Lava Tile Isle | PASS | MATCH | 16174 |
| Hot Rope Jump | PASS | MATCH | 18326 |
| Shell Shocked | PASS | MATCH | 16118 |
| Toad In The Box | PASS | MATCH | 18224 |
| Mecha Marathon | PASS | MATCH | 17752 |
| Roll Call | PASS | MATCH | 17528 |
| Abandon Ship | PASS | MATCH | 16478 |
| Platform Peril | PASS | MATCH | 17076 |
| Totem Pole Pound | PASS | MATCH | 16478 |
| Bumper Balls | PASS | MATCH | 17554 |
| Bombs Away | PASS | MATCH | 17294 |
| Tipsy Tourney | PASS | MATCH | 16312 |
| Honeycomb Havoc | PASS | MATCH | 20546 |
| Hexagon Heat | PASS | MATCH | 16538 |
| Skateboard Scamper | PASS | MATCH | 17028 |
| Slot Car Derby | PASS | MATCH | 17600 |
| Shy Guy Says | PASS | MATCH | 16360 |
| Sneak NSnore | PASS | MATCH | 16446 |
| Drivers Ed | PASS | MATCH | 19052 |
| Chance Time | PASS | MATCH | 16134 |
| Western Land duel | PASS | MATCH | 16228 |
| Pirate Land duel | PASS | MATCH | 16030 |
| Horror Land duel | PASS | MATCH | 17576 |
| Space Land duel | PASS | MATCH | 16190 |
| Mystery Land duel | PASS | MATCH | 16456 |
| Bowser Land duel | PASS | MATCH | 16168 |
| Bowsers Big Blast | PASS | MATCH | 19256 |
| Looney Lumberjacks | PASS | MATCH | 16156 |
| Torpedo Targets | VISUAL_ISSUE | MATCH | 18988 |
| Destruction Duet | PASS | MATCH | 17014 |
| Dizzy Dancing | PASS | MATCH | 16112 |
| Tile Driver | PASS | MATCH | 16620 |
| Quicksand Cache | PASS | MATCH | 17450 |
| Deep Sea Salvage | PASS | MATCH | 17178 |
| Western Land | PASS | MATCH | 13333 |
| Pirate Land | PASS | MATCH | 14053 |
| Horror Land | PASS | MATCH | 13719 |
| Space Land | PASS | MATCH | 11781 |
| Mystery Land | PASS | MATCH | 12349 |
| Bowser Land | PASS | MATCH | 13961 |

## Normal-menu board cross-checks

- Western Land: PASS
- Pirate Land: NOT_RUN
- Horror Land: NOT_RUN
- Space Land: NOT_RUN
- Mystery Land: NOT_RUN
- Bowser Land: NOT_RUN

## Findings

- **mg-11-DayAtTheRaces:** Runs to completion, but the race-camera capture at tick 16289 shows missing/corrupted track geometry. Runtime completion alone is not a visual pass.
- **mg-23-FiletRelay:** Completes with matching simulation state, but the split-screen gameplay captures show missing player body geometry (heads/feet render separately).
- **mg-67-TorpedoTargets:** Completes and matches replay state, but both split-screen views show missing submarine hull geometry; crew/windows and propellers render as disconnected pieces.
