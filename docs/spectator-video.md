# Spectator video

All 13 Retro games with presentation streams use the same WebRTC publisher and
viewer, including spectators present at launch and those joining during play.
Perfect Dark renders its synchronized simulation locally; Catan sends board
state. Derby is excluded. GTA V remains standalone without a shared room.

The video target is **1920×1080 at 60 fps**, with a 12 Mbps ceiling per viewer.
The original game canvas is captured directly. Smaller native canvases are not
upscaled, slower games are not frame-interpolated, and browser congestion/CPU
control can reduce the stream when needed. Chromium receives an 8 Mbps initial
codec hint so a fast connection does not spend its first seconds at camera-call
bitrates. Other engines may ignore this optional hint. The standard RTP sender
parameters still apply.

Game audio comes from the mixer before the host's volume control through a
MediaStream destination; the spectator has independent mute/volume controls.
No camera, microphone or screen-sharing permission is requested. The stream
contains only the game's canvas and audio mix.

The server authenticates both ends against the current room, running epoch,
player/spectator roles and connection token. Seat one publishes except in CMR2,
where the active coordinator publishes. Spectators receive no controller seat.
Leaving, restarting or returning to the lobby closes the peer connections and
stops capture tracks without stopping the host's game. Coordinator changes and
failed connections trigger fresh negotiation.

## Network fallback and configuration

Signaling uses the existing `/retro` Socket.IO connection. WebRTC uses the same
validated `NETPLAY_ICE_SERVERS` configuration as rollback multiplayer (default
STUN servers; configured TURN credentials are forwarded only to room members).
A TURN service is needed for reliable high-quality video on networks which
cannot establish a direct peer connection. No TURN service is provisioned by
this change.

Until video is decoded, or if frames stop arriving, the existing authenticated
relay supplies WebP frames up to 1280×720 at 20 fps, with bounded frames and
16 kHz mono fallback audio. Large images are reduced to remain within the relay
limit. Viewers renew a five-second streaming lease; server relaying is suppressed
only while that lease is active. One viewer falling back does not downgrade
another viewer's established stream. The publisher skips snapshot encoding when
all viewers are streaming.

The Python signaling module must be loaded by restarting `peakdecline.service`.
Browsers should reload and use a fresh round; build fingerprints include the
shared streaming and audio code. The native media event names are retained so
the improved client fallback can still operate during a rolling frontend/backend
update. Existing in-progress rounds should be finished before the service restart.

## Native timing

Super Mario 64's web build previously ran the desktop frame sleep inside an
already paced browser animation loop. That blocked browser painting and reduced
spectator delivery to about 7.5 fps in the local check. The web build now skips
that extra sleep, retaining its 30 Hz simulation. The installed runtime was
rebuilt; Chromium delivered approximately 26–28 displayed fps (30 encoded fps)
after the fix. The change is recorded in `ports/sm64/browser.patch`.

## Verification

`tests/games/spectator_quality_browser.cjs` measures delivered 1080p/60 using a
moving canvas and tone through real authenticated room connections. It also
checks multiple viewers, rejoining, audio before local mute, forced failure,
fallback, recovery, missing WebRTC support, and resource cleanup.

`tests/games/all_spectator_rejoin_browser.cjs` exercises every installed native
engine, measuring actual decoded video for both rejoins, and verifies return to
the same lobby and claiming an open player seat. Results include each engine's
source dimensions and delivered media statistics. These are local browser tests,
not a claim that every game renders 1080p/60 or that every remote network can
carry it.
