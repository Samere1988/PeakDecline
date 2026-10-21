# Native 1080p: 15 viewers on good connections

The completed run passed all nine checks. See
`native-good-connections-results.json` for source hashes and per-viewer samples.
No production playback behavior changed for this test.

- Actual local Flask/HLS delivery, production FFmpeg encoding, and WebSockets.
- Synthetic 1920x1080 input at 25 fps; native `faster` encoder preset.
- 15 independent Edge contexts, 40–100 Mbps each, 10–80 ms latency.
- Ten viewers present when streaming starts; five join later.
- Three users pause, then resume separately. Two refresh; two leave and rejoin.
- A late joiner pauses and uses Go Live.
- Decoded 1080p and adaptive quality disabled verified in assessed all-viewer periods.

| Assessed period | Maximum viewer spread | Maximum server-clock error | Stalled samples |
| --- | ---: | ---: | ---: |
| All 15 after late joins | 0.261 s | 0.148 s | 0 / 225 |
| 12 continuing while three pause | 0.270 s | 0.166 s | 0 / 180 |
| All 15 after resumes | 0.265 s | 0.139 s | 0 / 225 |
| All 15 after refresh/rejoin | 0.231 s | 0.120 s | 0 / 225 |
| All 15 after Go Live | 0.232 s | 0.126 s | 0 / 225 |

Intentional pauses remained local, all assessed viewers advanced frames, and no
browser exceptions occurred. Warmup/recovery periods are saved separately and
are excluded from the steady-playback thresholds; the table does not claim
instantaneous recovery or zero buffering throughout the complete run.

The first attempt passed the initial synchronization check but stopped on an
automation click against faded controls. The completed run brings each browser
forward, hovers over the player, and clicks visible controls without force.

All browsers and the server run on one machine. This validates local playback
and synchronization under simulated good connections, not public Internet
capacity, physical-device behavior, or unmuted autoplay permission. The harness
permits autoplay explicitly to isolate synchronization.
