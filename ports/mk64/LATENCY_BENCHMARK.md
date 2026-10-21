> Historical: this report covers the retired standalone `/mk64` service. The active Retro Games integration and current tests are documented in `README.md`.

# Mario Kart 64 latency benchmark — October 2026

The current room uses input lockstep: a browser runs the game locally, but it
waits for every racer's input for the next simulation frame. The browser queues
up to four future inputs. These tests used one Windows PC with isolated browser
sessions and a localhost Socket.IO server. Delays were injected into WebSocket
traffic; these are controlled stress tests, not measurements from Montreal to
Florida, New York, or Maryland.

| Scenario | Race speed | Button press to consumed input | Frame gaps over 100 ms in 12 s |
| --- | --- | --- | --- |
| 2 players, localhost | 30.4 FPS | 139–149 ms | Not sampled |
| 2 players, +30 ms each way for both | 30.4 FPS | 141–151 ms | Not sampled |
| 2 players, +60 ms each way for both | 30.5 FPS | 150–172 ms | Not sampled |
| 4 players, localhost | 30.4–30.5 FPS | 146–169 ms | 0 per client |
| 4 players, one connection +60 ms each way with periodic 100 ms spikes | 27.4 FPS | 143–173 ms on the sampled press | 10–11 per client; longest 167–183 ms |

The room now probes each player's Socket.IO round trip and chooses that
player's input lead separately. The following checks used the same fixture:

| Adaptive scenario | Chosen lead | Race speed | Button press to consumed input | Frame gaps over 100 ms in 12 s |
| --- | --- | --- | --- | --- |
| 2 local players | 1, 1 frames | 30.1–30.2 FPS | 37–44 ms | 0 |
| 2 players, one +30 ms each way | 1, 3 frames | 30.3 FPS | 38 ms nearby, 109 ms delayed | 0 |
| 4 players, one +60 ms each way with periodic 100 ms spikes | 1, 1, 1, 6 frames | 30.4–30.6 FPS | 53–57 ms nearby, 210 ms delayed | 0–1 per client |

A forced one-frame lead for both players under +30 ms each-way delay ran at
only 17.7 FPS. A forced two-frame lead for both kept 30 FPS but measured
79–117 ms. Individual queue lengths gave the nearby player low latency
without slowing the delayed player or the shared simulation.

The button timing ends when the game's controller-read function consumes the
input. It does not include the final render and monitor scan-out, so it is not
controller-to-photon latency. The single timed press does not describe the
worst press during a jitter spike. Race speed is averaged over 12 seconds;
frame gaps expose freezes hidden by the average. All tests maintained matching
simulation hashes and continued racing.

The four-player control rules out four browser sessions alone as the source of
the measured pauses. A delayed input set can stall every client. Fixed delay
was mostly absorbed by the former shared four-frame queue, at the cost of
roughly 150 ms baseline input-to-simulation time. Adaptive leads reduce that
cost for nearby players, but a distant player's input must still be buffered
longer to keep the race smooth.

This does not determine whether server video streaming would feel faster.
A local WebRTC loopback attempt did not establish a media connection, so no
streaming latency measurement is reported. A decisive comparison needs a
low-latency stream from the Montreal host and actual players in each region,
using the same controller-to-visible-response measurement on both systems.

The automated room test is `tests/games/mk64_multiplayer_comprehensive.cjs`.
Raw results are in `.tmp/mk64/latency-*.json`.
