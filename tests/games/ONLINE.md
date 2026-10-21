# CATAN online implementation and activation

Implemented in `app/catan_rules.py`, `app/catan_online.py`, and the CATAN page/scripts.
The production app registers the dedicated blueprint and `/catan` socket namespace
when it next starts. No production process was restarted during implementation.

## Playing

Sign in and open `/games/catan`. Create a private invite-only room or choose to list
it in the room list (new rooms are listed by default in the creation dialog).
The room cards reuse Watch Together's styles and show waiting/in-progress status,
player names, host and spectators. Invite visitors explicitly choose playing or
spectating. Players wait at the board, with seat controls and chat in the sidebar;
the preview board becomes the actual board on start. Share the invite link. Three or four players choose seats and ready
up before the host starts. Additional people can watch as spectators (32 total room
members maximum). Each account controls only its seat and receives only its own
resource and development cards. The server generates dice and shuffled boards/decks.

Included: snake-order initial placement, starting resources, legal roads/settlements/
cities, bank shortages, ports, multi-resource player offers, bank trading, robber,
discarding, random theft, all base development-card types, new-card/one-card-per-turn
restrictions, Longest Road, Largest Army, hidden victory points, and victory checks.
Room chat and recent public move history are separate from watch-room chat.

Refresh restores the same seat. Disconnected players keep their seats. After two
minutes without the host, another room member can claim host. A host may close a
match after a seated player has been absent for two minutes. Explicit resignation
ends that match and enables a rematch; it does not grant another person access to
the departing player's hand. Returning to the room list does not resign.

## Persistence and deployment boundary

- Dedicated file: `instance/catan.sqlite3`, with SQLite WAL sidecars. It is created
  lazily on the first game API request. Tests use temporary files, never this path.
- `CATAN_DATABASE` in Flask config can override that path. Back it up using SQLite's
  backup API or a consistent filesystem snapshot including the WAL, not a live copy
  of the main file alone.
- Authenticated HTTP commands carry a session CSRF token, unique command ID, and
  expected room version. Transactions serialize mutations. Duplicated acknowledgments
  cannot spend resources twice. Stale competing moves return a fresh private view.
- Socket notifications contain only room ID and version. The browser retrieves its
  own authenticated snapshot. Two-second polling recovers missed events or blocked
  sockets; it also refreshes presence. Open tabs continue presence polling in the background (browser suspension can still interrupt heartbeats).
- No external sound/art requests are needed. The existing Socket.IO client CDN is
  used; if unavailable, HTTP polling keeps the game functional.
- Each account can host five recently active rooms. Commands are limited to 40 per
  ten seconds. After 60 seconds without a heartbeat from any human member (including spectators),
  a room closes, disappears from the list and rejects reconnects/actions. Expiration
  is enforced on API access before refreshing presence; no scheduled task is needed.
  Closed records are retained seven days, then cleaned up on room creation.

Activation needs the new Python modules loaded by the application. Schedule a safe
application restart or deploy an isolated game instance and route CATAN to it; do
not restart the active streaming process without an appropriate window. No watch,
live-TV, player synchronization or streamer behavior was changed by this work.

## Verification

Run from the repository root:

```powershell
.\.venv\Scripts\python.exe tests/games/catan_online_test.py
.\.venv\Scripts\python.exe tests/games/catan_simulation_test.py
.\.venv\Scripts\python.exe tests/games/catan_load_test.py
node tests/games/catan_online_browser.cjs
python tests/games/render.py
node tests/games/catan_engine.cjs
node tests/games/catan_browser.cjs
```

The browser fixture binds an ephemeral **localhost-only** port, uses temporary
storage and synthetic accounts, and never imports production routes or boots the
production application factory. Its resource-seeding helper exists only in tests.

Tests cover authorization/CSRF, private hands, spectator permissions, socket room
isolation, stale and duplicate actions, competing writes, restart recovery, host
recovery, rematches, rule edge cases, three complete automated matches with card/
piece conservation, and independent browsers playing/trading/building across rooms.

Local workload result: 24 rooms / 96 simulated accounts; 960 authenticated snapshots
through 16 concurrent workers; zero failures; median approximately 24 ms and p95
44 ms on this development machine, followed by successful concurrent moves in all
24 rooms. This uses Flask test clients, not 96 actual networked browsers. It is not
a production capacity guarantee or a sustained load/soak test.

## Scaling boundaries

This implementation supports multiple independent rooms on one host. SQLite writes
are serialized across rooms; separate workers must use the same local database.
Polling preserves correctness without a cross-worker socket queue, but notifications
from another worker may arrive only on the next poll. Before distributing across
hosts, migrate state/command transactions to a shared transactional database and
configure Socket.IO message-queue coordination and sticky connections. Measure
latency and resource usage with the actual proxy, network and streaming workload.

Not included: Seafarers/Cities & Knights expansions, bots, matchmaking/rankings,
automated turn deadlines, player replacement mid-game, or full-game replay archives.
No production deployment or load test against live viewers was performed.

## Private three-player testing

In Create Room select “Private test: control three players yourself”. The server
creates three ready seats, forces the room private, and restricts access to its
creator. Start, then use Red / Blue / Orange to control each seat, including
placement, trades and discards. Refresh preserves the selected seat. The normal
server rules and command validation still apply. Synthetic seats do not keep an
empty room alive. This works through normal authenticated website access once
the updated Python backend is deployed; the loopback-only four-tab sandbox is
not a remote-access endpoint.

## Viewport layout and resource feedback

Online rooms fill the viewport; board size is constrained by both available width
and height. Hand/build controls stay beneath the board, with compact player stats,
bank and chat alongside on desktop. Trade opens in a popup. On narrow phones,
Players & chat opens the sidebar as a panel while the board and hand fit the screen.
Positive resource changes for the current private hand animate from a producing
tile (or bank) into the matching card. Initial loads and seat switches do not replay
gains. Reduced-motion users receive the text notification without flying cards.
Browser checks cover 320x640, 390x844, 768x1024, 1366x768, 1536x864 and 1920x1080,
including board/port bounds, visible hand, trading and resource receipt animations.

## Negotiated trading

The trade popup uses clickable giving/receiving resource cards, Players and Bank /
ports modes, and the existing resource artwork. Clicking a card in your hand opens
trade selection. Bank mode uses the player's best rate per resource and supports
multiple exchanges in one atomic command.

Player offers remain pending after acceptance. The current player selects an
accepted response to confirm the exchange; only then do cards move. Players can
decline, change their response, edit into a counteroffer, and accept someone else's
counteroffer. Leaving one side empty makes an open-ended offer that must be made
specific through a counteroffer before confirmation. Trade preferences allow
blocking/unblocking another player. Offers expire when replaced, completed or the
turn ends; each player has at most one counteroffer. Final confirmation rechecks
both hands, consent, turn, and blocking under the room transaction. Duplicate
commands cannot transfer cards twice. Trade response updates tolerate concurrent
responses to the same still-valid offer.

Reference: https://blog.colonist.io/improving-the-colonist-trade-system/
This implements the documented negotiation flow; it is not a claim of exact parity
with every current Colonist feature or expansion. The backend advertises tradeVersion
2; the new UI stays inactive against an older running server. Deploy/restart the
backend and refresh all game clients to activate the new flow together.

## Importing the licensed development-card artwork

Run `powershell -ExecutionPolicy Bypass -File .\tools\import-catan-development-cards.ps1`
from the repository root. The script downloads the five licensed SVGs directly from
the Colonist CDN, validates them, stores them under `static/assets/catan/colonist`,
and updates `sources.json`. It only changes static files; it does not restart or
contact the running game service.
