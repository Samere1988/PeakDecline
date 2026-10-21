> Historical: this report covers the retired standalone `/mk64` service. The active Retro Games integration and current tests are documented in `../ports/mk64/README.md`.

# Mario Kart 64 multiplayer test report

Completed October 1, 2026. Tests used separate authenticated browser contexts on the local isolated Flask/Socket.IO fixture, with the current game bundle. No production databases were used.

## Results

| Players | Sustained race test | Measured simulation FPS per client | Added network delay | Result |
| --- | --- | --- | --- | --- |
| 2 | 12 seconds | 30.06, 29.98 | None | Pass |
| 3 | 12 seconds | 30.02 on all clients | None | Pass |
| 4 | 60 seconds | 30.01 on all clients | 40 ms each direction | Pass |

Each run selected the actual requested player count in the game, selected a character from every client, entered a race, accelerated every player, and steered player two. The test reads the game's selected-player count rather than assuming that a four-person room means a four-player race.

The four-player run compared 1,798 completed-frame hashes across all four clients with no differences. Those hashes cover the game frame, game mode, random seed, and each player's type, position, velocity, lap count, and effects. All four clients produced 3,602 non-silent audio buffers during the measured minute. The latency test intercepted 23,881 WebSocket messages, confirming that the configured delay was applied to live traffic.

Restart passed for two, three, and four players, including comparison of 120 completed frames after restart. Departure notices remained visible without JavaScript or WebAssembly errors. Returning to the room browser passed in the three- and four-player runs.

Additional checks passed:

- Six room unit tests: authentication, two/four-player inputs, out-of-order future inputs, lobby host transfer, joining/start rules, and reseating after departure.
- Three route tests: authentication, build availability, and restricting served build files.
- Controller mapping unit and browser tests, using simulated gamepads: detection, solo/online input, disconnect, keyboard input, and raw-controller setup.
- Room-browser UI: create dialog, waiting and full lobbies, guest departure, and mobile layout.
- Volume slider: displayed value, saved setting, and live audio gain/mute.
- Screenshots reviewed for two-, three-, and four-way racing layouts.

## Problems found and fixed

1. The online test fixture defaulted to an older candidate bundle. It now defaults to `instance/mk64/build`. The comprehensive test also checks that the fixture's WebAssembly SHA-256 matches that bundle.
2. A departing player caused the remaining clients to abort in WebAssembly, replacing the useful departure message with a generic crash. Shutdown now cancels the game loop, silences audio, preserves the departure message, and offers a working **Return to rooms** button. The rebuilt bundle passed the departure checks for all player counts.

The tested WebAssembly SHA-256 is `4596b343df3de0353e8a34d13e178c96fe829577d106d8c3ebbac51dd4b17450`.

## Scope and limits

These are automated Edge/Chromium tests on one PC, using software WebGL. Network delay is simulated; separate physical devices, real internet jitter, packet loss, and physical controllers were not tested. Audio checks measure generated output, not listening quality. The races exercise driving but do not complete an entire cup or cover every course.

Opening another tab did not stall the game: each client advanced about 150 frames in five seconds. However, headless Chromium still reported `document.visibilityState` as `visible`. Real hidden/minimized-tab throttling therefore remains unverified.

## Reproduce

Start the fixture in one terminal:

```powershell
python tests/games/mk64_test.py --serve-online
```

Run the comprehensive test in another terminal. Set `MK64_TEST_PLAYERS` to 2, 3, or 4. For the endurance/latency run:

```powershell
$env:MK64_TEST_PLAYERS = '4'
$env:MK64_TEST_NETWORK_DELAY = '40'
$env:MK64_TEST_RACE_MS = '60000'
node tests/games/mk64_multiplayer_comprehensive.cjs
```

Raw results and screenshots are saved as `.tmp/mk64/test-2p-*`, `test-3p-*`, and `test-4p-*`.
