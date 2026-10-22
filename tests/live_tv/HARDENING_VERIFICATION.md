# Live TV hardening — October 22, 2026

Deployed on October 22, 2026 at 16:06:53 America/Toronto after the user ran the
administrator deployment command. All six live runtime files match the tested
release manifest. The website service is active. Both nginx and Flask return
401 for anonymous media, nginx returns 404 for the internal auth location and
legacy logs, and no legacy public `.log` files remain.

The fresh private deployment backup is
`/home/samer/Documents/ChatGPT/migration/live-tv-deploy-20261022-200653`.
The deployed code commit is `5e28dae650ff4a584f008e5ce49a239f143f21f5`.

The pre-change snapshot is commit `ef139d3f505332d5a6a4ffe6336ff839c9c2c7bc`
on the existing repository's
[backup branch](https://github.com/Samere1988/PeakDecline/tree/backup/live-tv-before-hardening-20261022-153906).
It includes the pre-existing uncommitted launcher work. Secrets, databases,
generated media and private logs are excluded from GitHub. The environment,
nginx configuration and service unit also have a private local backup.

## Changes

- Sustained drift is corrected in both directions. Firefox stays at 1x and
  corrects offsets over one second; other browsers seek for offsets over two
  seconds and use gentle rate correction below that. Seeks require buffered
  media, a consistent direction for three seconds, and a fifteen-second cooldown.
- Clock responses are filtered by latency, expire without extending their age,
  and must match the current stream session. Displayed-frame measurements and
  bounded local diagnostics help distinguish timeline drift from a stalled picture.
- Encoder exit or twenty seconds without advancing media triggers recovery.
  Three attempts and backoff prevent endless restart loops; sixty healthy seconds
  restores the retry budget. Replacement sessions reach all viewers. Paused
  viewers stay paused, and Stop continues to work during failed retries.
- Video-only sources publish all three variants. Native retains its dimensions
  and CRF setting, with an explicit bandwidth estimate for the HLS master.
- Native remains the default. Five seconds of continuous buffering or three
  substantial stalls in thirty seconds enables Auto for that viewer. Brief
  alignment waits do not lower quality; the menu explains the fallback.
- Both nginx and Flask require authentication for media and reject nonmedia
  filenames. The channel API omits provider URLs. New encoder logs are private
  and bounded; deployment archives legacy public logs privately.

## Verification

All media and accounts used for integration tests were generated or temporary.
The harness binds to loopback, isolates databases and stream directories, and
disables guide downloads. It never selects a production TV channel.

| Check | Result |
| --- | --- |
| Clock, lifecycle, player, status, quality, channel preference, cleanup and legacy-ID regressions | Passed |
| Low-RTT filtering, session guards, displayed-frame callbacks and bounded client recovery | Passed |
| Video-only FFmpeg output | All three playable HLS variants published |
| Killed encoder | Recovered in about 4.1 seconds |
| Frozen encoder | Recovered in about 27.2 seconds, including detection and shutdown |
| Explicit Stop after recovery | Encoder stayed stopped |
| Real Chromium and Firefox playback | Decoded frames, corrected lead and lag; Firefox stayed at 1x |
| Encoder replacement while Firefox was paused | Paused viewer remained paused |
| Throttled network | Native switched to Auto; playback recovered when bandwidth returned |
| Isolated nginx auth_request configuration | Anonymous media 401, authenticated media 200, logs 404, internal auth location 404 |
| Fifteen viewers, native 1080p | Alignment, pause/resume, refresh/rejoin and Go Live passed; Native retained |

The detailed current run summaries and source hashes are in
`hardening-results.json`. Full samples are retained locally under
`.tmp/live-tv-results/`; older checked-in September reports are historical.
The final source hashes are also recorded by the deployment manifest. The small
explicit-Play decoder-rebuild guard is covered by the final unit suite and the
final-source fifteen-viewer smoke run, separately from the earlier full churn run.

These are browsers on one Linux host with simulated network conditions, not
physical TVs or geographically distributed viewers. Native Safari/iOS playback,
long-session audible A/V synchronization and public-internet capacity remain
unverified. The initial Firefox audio workaround is preserved.

## Deploy and roll back

From a terminal on the server:

```bash
sudo python3 /home/samer/Documents/ChatGPT/live-tv-hardening/deploy/live_tv.py
```

The script verifies hashes for all six runtime files against the backup or
reviewed release, saves a fresh private rollback copy, updates only those files
and the nginx stream location, validates nginx, and restarts the website. It then
checks media protection through both Flask and nginx. A failed deployment
restores its code and configuration backup automatically.

On success it prints the exact rollback command, of this form:

```bash
sudo python3 /home/samer/Documents/ChatGPT/live-tv-hardening/deploy/live_tv.py \
  --rollback /home/samer/Documents/ChatGPT/migration/live-tv-deploy-20261022-200653
```

Restarting interrupts the current encoder. Viewers should reload Live TV after
deployment to use the new player. Unrelated launcher work is preserved.
