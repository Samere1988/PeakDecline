# Mario Party 1 and 2 match recovery

Source implementation and verification: October 16, 2026. Production has not
been restarted to activate these changes.

An unexpected player disconnect pauses the match. A returning player can keep
using the original tab, reload it, or reopen the room in a new tab in the same
browser while signed into the same account. The room list shows **Rejoin match**
when this browser holds that seat's recovery credential. A reload automatically
rejoins the room from its URL. Intentional **Leave** revokes that credential and
still ends the current match.

When a tab still has its native runtime, recovery reuses it. A fresh tab starts
with the match's original account-save snapshot, then replays every confirmed
controller frame. It must match a recent recorded native checksum before the
server releases the pause. Before the first checksum exists (the first second),
recovery relies on the original snapshot and inputs; normal live checksum checks
follow. Everyone stays paused until all missing players have recovered. A bad
reconstruction fails only that returning player's attempt and can be retried.

A connected player receives lobby controls when the host disconnects. The group
can choose to return to the lobby instead of waiting for a player who cannot
return. Controller slots stay fixed throughout recovery.

## Storage, saves and limits

- Controller history is stored in a compact temporary server file, up to 24 hours
  of game frames (about 83 MB for four players). Replay responses contain at most
  600 frames, and the browser consumes them in bounded batches with drawing
  skipped during reconstruction. Recovery time increases with match length.
- The rejoin credential persists in browser local storage and is also bound to
  the authenticated account on the server. Another account cannot take the seat.
  A reload may replace an old socket that has not yet reported its disconnect.
- Intermediate replay EEPROM is never uploaded. Once reconstruction succeeds,
  normal account-save syncing resumes with revision-conflict protection. Pending
  browser backup data is preserved before reconstruction.
- Room state and the journal are process-local: server restarts lose the match.
  Entirely disconnected rooms are cleaned up by the existing 120-second expiry
  tasks. Keep another player connected for longer absences. Clearing browser
  storage also removes the rejoin credential. Cross-device recovery is not
  implemented by this change.

## Validation

Both installed games passed four-player browser tests starting with 1,320 frames
(more than the former 1,200-frame retained history). Each test reloads the host,
then closes and reopens a guest tab. Original controller seats are restored, and
all four players match native checksums after both recoveries. The test uses real
Socket.IO routes, native Wasm builds, and a disposable account/save fixture.

Server tests cover chunk boundaries and journal limits, rejoining after an hour,
wrong-account and malformed resume rejection, stale-socket replacement, original
save delivery, checksum mismatch isolation/retry, simultaneous recovering seats,
initialization failure isolation, restart epochs, and abandoned-room cleanup.
Client tests cover bounded replay, suppression of live input during reconstruction,
replay checksums, and the pause barrier. A browser save test verifies that replay
starts from the original snapshot, cannot upload intermediate progress, resumes
uploads afterward, and preserves concurrent-save conflict checks. Shared MK64
and room protocol regressions also pass.

Start `.venv/bin/python tests/games/marioparty_lobby_server.py`, then run browser
commands sequentially against its loopback fixture:

```sh
.venv/bin/python -m unittest discover -s tests/games -p 'marioparty*test.py'
node tests/games/marioparty_session.cjs
MP_RELOAD=1 MP_NET_FRAMES=1320 node tests/games/marioparty_netplay_browser.cjs
MP_GAME=marioparty2 MP_RELOAD=1 MP_NET_FRAMES=1320 node tests/games/marioparty_netplay_browser.cjs
node tests/games/marioparty_replay_saves_browser.cjs
```

Omit `MP_RELOAD` to test the retained-tab transport-disconnect path instead.
Browser results are `.tmp/marioparty-netplay/marioparty-reload.json` and
`.tmp/marioparty-netplay/marioparty2-reload.json`. These tests establish the tested
recovery paths, not every possible board event, browser or real internet failure.
