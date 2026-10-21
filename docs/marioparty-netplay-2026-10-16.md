# Mario Party network qualification — October 16, 2026

Both installed games passed the four-player loopback networking checks below.
This supports trying a group session on stable connections; it does not certify a
full multiplayer board match or uninterrupted play over the internet.

Current reload/closed-tab behavior and verification supersede the earlier
limitations below: see [match recovery](marioparty-recovery.md).

## Reconnect change (follow-up)

Mario Party 1 and 2 now pause on an unexpected player disconnect and retain the
running native game. Reconnecting from the same open tab restores the original
controller slot, replays confirmed inputs and resends pending inputs. Everyone
waits until all disconnected players return. The 15-second MK64 reconnect limit
and its client timeout do not apply to Mario Party. A connected player receives
lobby controls if the host disconnects.

Keep the original game tab open: closing/reloading loses the native state and
cannot resume this match. Intentional Leave still ends the match. A paused room
remains available while someone stays connected; an entirely disconnected room
is cleaned up after 120 seconds. This is process-local recovery, not recovery
across a server restart.

Both games passed the updated browser qualification: 600 initial frames, a
20-second host transport disconnect, then at least 180 resumed frames in the same
native module. All four players matched at 13 checksum checkpoints per game. Focused server tests
also accept reconnect after a simulated hour while another player stays, reject
wrong-account/epoch/state attempts, and verify the multi-player pause barrier.
These changes are in source; the production service has not been restarted.

## Original inspection results (before reconnect change)

| Check | Mario Party 1 | Mario Party 2 |
|---|---|---|
| Four native player instances over real Socket.IO/server routes | Pass, 1,800 frames | Pass, 1,800 frames |
| Independent native game-state hashes | 30 matching checkpoints per player | 30 matching checkpoints per player |
| Distinct buttons and analog directions from all four seats | Pass | Pass |
| One seat delayed 35–95 ms, plus a 1.5-second input interruption | Recovers, hashes match | Recovers, hashes match |
| Four native players plus live video spectator and resumed audio | Pass | Pass |
| Disconnect one player | All remaining players stop | All remaining players stop |
| Four-seat protocol: loading barrier, duplicate/reordered inputs, missing seat, restart/stale epoch rejection, desync detection | Pass | Pass |
| Independent deterministic party replay | 24,929 frames, matching hashes | 19,200 frames, matching hashes |

The replays use one human controller plus CPUs and independent native instances,
with different presentation schedules. They cover gameplay beyond startup, but
are separate from the four-player socket test. The four-player test holds distinct
inputs to verify routing; it is not a complete four-human board/minigame replay.
The existing shared server suite also passed all 18 tests; both original Mario
Party registration contract tests passed.

The smoke tests previously expected a native iframe on the spectator page and
timed out. Spectators now receive video. Those tests were updated to check native
players separately and require 80 decoded live spectator frames.

## Practical limitations

- Both games use `recomp-ring-lockstep-v1`. The slowest player's input delivery
  limits progress; stalls are expected when a connection or browser pauses.
- At the original inspection, a player disconnect ended the current match. Seamless player reconnection or
  mid-match resume was unavailable at inspection time. The tests
  originally confirmed that stop behavior; the follow-up tests now verify pause/resume.
- Chromium on this Linux host was tested. Mixed browsers, mobile backgrounding,
  real WAN latency/loss, and multi-hour group sessions remain unverified.
- The injected delays preserve ordered application delivery. They do not simulate
  every behavior of TCP congestion, a suspended device, or a physical network.
- Hash agreement verifies the native hash's covered state, not every rendered
  pixel or every possible gameplay path. Existing MP2 visual defects documented
  in its port README remain outside this networking qualification.

The original inspection changed only tests. The reconnect follow-up changes the
shared server relay, browser session and lobby code; installed game assets,
production saves and service configuration remain unchanged. Testing used a loopback fixture with disposable users
and a temporary save database.

## Reproduce and evidence

Commands are in [the games test README](../tests/games/README.md). New checks:

- `tests/games/marioparty_netplay_browser.cjs`
- `tests/games/marioparty_netplay_test.py`

Local four-player JSON evidence is under `.tmp/marioparty-netplay/`; replay
reports are `.tmp/mp-frame-bridge-report.json` and
`.tmp/mp2-frame-bridge-report.json`. Console logs from this run are
`.tmp/mp1-netplay.log`, `.tmp/mp2-netplay.log`, `.tmp/mp1-replay.log`,
`.tmp/mp2-replay.log`, `.tmp/mp1-spectator.log`, and `.tmp/mp2-spectator.log`.

Installed Wasm SHA-256 values:

- MP1: `67707860e399abe02ac201ece1372d43102cdbb51191898cb12429ade37dde81`
- MP2: `5522aa3727ee5b43ec5cfc4782385d50f83d10919788e2dec2172e90dc50e78d`
