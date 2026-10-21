# Colin McRae Rally 2.0 browser port

This port runs OpenCMR2 in each player's browser using Emscripten and SDL's
experimental WebGPU backend. The ordinary Peak Decline lobby supplies room
membership, readiness, controller selection, invite links, fullscreen, sound,
account saves and spectators. The original game supplies car and race settings.
A WebGPU-capable desktop browser is required. Original PC data remains private
under `instance/cmr2/data`, outside the static directory.

## Network model

`app/netplay/cmr2.py` owns the native session description and player roster.
`net_browser.cpp` implements the game's DirectPlay-shaped networking API over
the authenticated Socket.IO room. Each browser simulates its local car and
exchanges the game's original packets. The first available player coordinates
race settings; if they leave, that responsibility moves to the next player.
The server does not render or simulate the race. Disconnects preserve native
player IDs rather than renumbering cars mid-race.

The current transport uses WebSocket/TCP, including the game's originally
unreliable car updates. Clients coalesce obsolete queued car updates, but TCP
head-of-line blocking can affect poor or high-latency connections. Do not
interpret server-owned rooms as authoritative physics or cheat prevention.
Spectators receive compressed video and audio from the settings coordinator.

## Building

Pinned upstream revisions are in `sources.json`; `browser.patch` and `sdl-browser.patch` contain the
source changes. No original game data is committed. Provide an extracted PC
installation containing `Game`, `FrontEnd`, `Sounds`, `CountrySpecific` and
`SetupRep`. The asset manifest includes sizes and SHA-256 hashes; files load
on demand and the authenticated asset route serves only manifest entries.

Use Emscripten 4.0.18, CMake/Ninja, glslangValidator and Dawn's Tint from the
pinned release. The builder accepts `CMR2_GLSLANGVALIDATOR` and `CMR2_TINT`
executable paths, or the local cache under `.tmp/opencmr2/tools`. Place the
pinned Dawn release's `emdawnwebgpu.remoteport.py` in that tools directory.

```sh
source .tmp/emsdk/emsdk_env.sh
.venv/bin/python ports/cmr2/build.py --data /path/to/extracted/game
```

The candidate is generated under `.tmp/opencmr2/browser-build/game`. The
builder does not restart the live service or enable an unverified candidate.
Catalogue availability requires all declared build files, private data's
`installed.json`, and a `verified.json` acceptance record in
`instance/cmr2/build`. Keep matching JavaScript, Wasm and asset manifest
files together when publishing.

## Verification

```sh
PYTHONPATH=tests/games .venv/bin/python -m unittest cmr2_assets_test cmr2_relay_test account_saves_test retro_test catalog_test solo_ports_test
PYTHONPATH=tests/games .venv/bin/python tests/games/cmr2_browser_server.py
```

The browser fixture runs on loopback port 8088 with its own temporary database,
accounts, game catalogue and save storage. It uses the candidate assets without
changing production. Test driving, two native players joining and moving,
creator departure, spectator video/audio, profile restoration and controller
input before writing a verification record.

## Accepted build (2026-10-13)

Initial Chromium checks covered native Finland driving,
two-player native session joining, remote car movement, spectator video and
nonzero audio, continued driving after the creator leaves, controller pad
mapping, native PPS creation, byte-identical fresh-browser profile restoration,
and account isolation. These checks did not establish rendering fidelity or frame pacing and missed rejected geometry uploads. Thirty server checks passed. Browser acceptance runs
with `node tests/games/cmr2_browser.cjs`; it writes a digest-bound verification
record only after all checks pass. The standalone native save check is
`node tests/games/cmr2_saves_browser.cjs`.

Publish an accepted candidate with `.venv/bin/python ports/cmr2/publish.py`.
This validates build and asset digests and copies the private assets into
`instance/cmr2`. The live service needs a reload to register the new routes.

This is an experimental WebGPU port. The full campaign, eight simultaneous
racers, mobile browsers and remote/WAN latency have not been validated.
Network guest driver entries are temporary; create a native driver profile
for persistent progress. The relay preserves the game's original car-state
protocol; it is not deterministic lockstep or server-authoritative physics.

## Rendering corrections (2026-10-13)

WebGPU rejected some odd-sized 16-bit index uploads, discarding race frames.
Geometry transfers now pad their byte sizes and offsets to four-byte alignment
without changing the primitive index counts. Failed render passes are reported
before subsequent API calls can overwrite the error.

Disabled graphics tracing no longer captures a JavaScript stack for every draw.
Lens-flare samples use one outstanding asynchronous readback, retaining the last
completed visibility result while a new sample is pending. SDL fence queries
also poll download mapping without turning a zero-time query into a blocking
browser wait. Explicit blocking waits and diagnostic capture remain supported.

The runtime checks for a hardware WebGPU adapter before downloading game data.
A software adapter produces an actionable error rather than a race running at
only a few frames per second.

Run `node tests/games/cmr2_render_browser.cjs` for the Firefox rendering check.
It verifies actual textured scene pixels, no rejected GPU commands, at least
30 FPS and 95th-percentile frame gaps below 50 ms during a solo Finland race.
Run `node tests/games/cmr2_software_browser.cjs` for software-adapter rejection.
The browser fixture uses its own temporary Firefox profile with WebGPU enabled;
it does not change the user's browser preferences. Firefox multiplayer,
controller mapping, spectator video/audio and profile restoration are covered
by `node tests/games/cmr2_browser.cjs`.

Chromium headless on this Linux host either selects SwiftShader or, when forced
to the NVIDIA Vulkan adapter, presents a blank canvas. It cannot qualify hardware
rendering here; the rendering check defaults to Firefox and checks scene pixels
rather than trusting frame counters alone. CMR2_BROWSERS=chromium selects that
engine explicitly for diagnosis on another host.

After the checks pass, publish a renderer-only update using
`.venv/bin/python ports/cmr2/publish.py --build-only`. Publication requires matching
native and rendering verification digests. This preserves the installed private
data. Users must leave the old game and reload the page to load the new Wasm.

## Race memory exhaustion (2026-10-13)

A live Firefox race reported WebGPU out-of-memory errors, followed by invalid
buffers and bind groups. The experimental SDL backend released WebGPU handles
without explicitly destroying the storage of per-frame uniform pages, upload
staging buffers and cycled resource generations. Browser garbage collection
is not a reliable way to retire those GPU allocations; the
[WebGPU memory-lifetime explanation](https://gpuweb.github.io/gpuweb/explainer/#memory-management)
describes why temporary buffers and textures need explicit destruction.

Retired buffers and textures now destroy their GPU storage after their last
tracked command finishes. Download staging buffers are destroyed after their
mapping is consumed. Active resources remain usable until they are released or
cycled. Runtime graphics failures also produce a visible room error.

The browser frame wait has a timer fallback for withheld animation callbacks
and caps presentation at 60 FPS on high-refresh displays. Rendering acceptance
now exercises withheld callbacks, high-refresh pacing and a further 60-second
race soak while measuring explicit buffer creation/destruction and live bytes.
Publication requires bounded GPU buffer storage during that soak.

## Binding descriptor pressure (2026-10-13)

A second live Firefox/7900 XTX Finland failure still reported out-of-memory
errors with the cleanup build. An extended Linux measurement showed about
41,000 new bind groups per ten seconds despite bounded GPU buffer storage.
Firefox has [documented descriptor-heap exhaustion reporting as OOM](https://bugzilla.mozilla.org/show_bug.cgi?id=1962738);
this is evidence of excessive binding churn in the port, not proof of the
user's browser/driver's exact failure mechanism.

The backend now keeps a bounded 512-entry LRU binding cache across frames and
reuses up to 64 completed uniform pages. Keys retain their layout, view, sampler
and buffer handles to prevent stale-address reuse, and retain the binding sizes
while allowing dynamic uniform offsets to change. Commands keep their own
references when a cache entry is evicted. Storage cleanup still waits for the
last submitted use. Runtime graphics failures include frame and binding counts.

Rendering acceptance now runs three additional minutes in the Finland race,
tracks textures and live Dawn handles, and requires fewer than ten new bind
groups per frame as well as bounded buffer storage. Local Linux testing cannot
qualify the user's AMD graphics path; confirm the published build on
the affected machine.

## Latency audit (2026-10-13)

Controller state previously refreshed on the 100 ms room/UI timer. The native
keyboard and movie bridges now read the selected controller on demand through
`Module.cmr2Pad`, so presses and releases no longer wait for that timer. The
original car simulation still runs at 25 Hz; this removes a separate source of
delay without changing physics or replay timing. The mapped stick and triggers
still act as digital keys; proportional steering/throttle needs a native analog
input bridge.

Only the current coordinator now encodes spectator video and downsamples audio.
Previously every racer performed that work, although only the coordinator's
output could be sent. Capture and transmission also skip a busy socket, so
spectator media does not accumulate behind queued race traffic. This cannot
preempt a media packet already sent on the shared WebSocket. An unreliable car
state transport and separate spectator media remain larger follow-up work;
TCP head-of-line blocking is still possible.

The frame-callback watchdog now waits 33.3 ms instead of 100 ms, allowing the
game to resume sooner when animation callbacks are withheld. Actual fallback
frame rate still depends on browser timer throttling and rendering cost.
Normal presentation remains capped at 60 FPS. The renderer acceptance check now
requires more than 80 frames in four seconds with callbacks withheld.

The native car decoder rejected every packet after a gap of at least 100 ticks
(four seconds at 25 Hz), because its last accepted sequence never advanced.
It now accepts a newer full snapshot across those gaps. Both receive and decode
stages compare the 16-bit sequence modulo its half-range, allowing rollover
while rejecting duplicates and stale packets. Browser acceptance drops incoming
car snapshots for six seconds and verifies remote motion recovers.

Focused regressions run without original game assets:

```sh
node --test tests/games/cmr2_latency.cjs
.venv/bin/cmake --build .tmp/opencmr2/browser-build --target cmr2_net_regression -j8
node .tmp/opencmr2/browser-build/cmr2_net_regression.js
```

The native regression links the actual game receiver and decoder. Multiplayer
acceptance additionally verifies that other racers do not encode spectator
frames, capture follows coordinator migration, and native controller reads
exceed the old 10 Hz timer rate. Use the existing full multiplayer and rendering
acceptance commands before publishing a rebuilt candidate.

Local Firefox validation passed 30 server checks, the focused JavaScript/native
regressions, and the full multiplayer/save checks. The driving sample measured
54.8 FPS with 17.1 ms p95 frame gaps and a 100.5 ms worst gap; occasional hitches
remain. The three-minute soak kept tracked GPU buffer storage at 6,027,336 bytes
and averaged one new bind group per frame. With animation callbacks withheld,
88 frames completed in four seconds, versus 37 in the earlier acceptance run.
The controller bridge was read 125 times in five seconds; the non-coordinator
encoded zero spectator frames. These are local fixture results, not WAN latency
or end-to-end physical controller-to-display measurements. The native candidate
requires publication to replace the installed Wasm.

## Solo Firefox frame stalls and remote diagnostics (2026-10-14)

Phase timing isolated repeated 50–53 ms presentation work while lens-flare GPU
download mappings were pending. Although the application polled its readback
fence, SDL's swapchain frame-slot acquisition performed a blocking wait on the
same download. Frame slots now wait for GPU queue completion only. Public fences
still wait for download completion, and the application retains its one pending
readback until it can safely consume the pixels. This is a local downstream SDL
patch; it is not an upstream contribution.

In matching 40-second Firefox driving runs, the baseline had 20 frame gaps over
50 ms and a 67.48 ms maximum. The fix had none over 50 ms, a 27.48 ms maximum,
and 17.44 ms p99. These measurements use the server's GPU, not the affected
Radeon 7900 XTX. The rendering acceptance now measures native frame boundaries,
drives for 30 seconds plus 10 seconds of coasting, and artificially delays GPU
mapping callbacks by 200 ms. It requires continued presentation at 50 FPS or
better, p99 below 50 ms, and no gaps over 100 ms under that stress, before the
existing three-minute resource soak.

The delayed-mapping acceptance passed at 60.01 FPS, 17.30 ms p99 and 32.68 ms
maximum across 2,401 frames, exercising 134 delayed mappings. Five detailed
diagnostic reports reached the room transport. Tracked GPU buffer storage stayed
at 6,002,752 bytes throughout the 180-second soak, with one new bind group per
frame and no rejected rendering commands.

For diagnostics on a separate PC, open `/games/retro?cmr2-diagnostics=1` before
creating or joining a CMR2 room. Once the rebuilt native runtime and updated
server telemetry validator are active, the existing authenticated diagnostics
channel sends bounded summaries every ten seconds: p95/p99 frame intervals,
counts over 50/100 ms, and the worst frame split into game recording, renderer
submission/waits, presentation pacing, and time between native frames. These
are elapsed browser-thread timings, not GPU timestamp queries or physical
input-to-display latency. Background tabs and non-driving states are excluded.
The fixed-size histogram caps percentile bins at 1000 ms; the exact maximum is
reported separately. No screen, input, or save data is uploaded. Ordinary rooms
continue sending their existing average-FPS/latency reports.

Use `journalctl -u peakdecline.service -f -o cat` to observe live NETPLAY records,
or pipe recent records through `tools/netplay_report.py --room ROOM` to summarize
them. Native/static publication requires a page reload. The Python validator
change requires the normal service restart before detailed reports are accepted.

Published the accepted native/static update on 2026-10-14 UTC using `--build-only`;
installed JavaScript/Wasm digests match both acceptance records. The full browser
multiplayer/save tests, software-GPU rejection, focused input/network regressions,
and 47 Python checks passed. The live service rejected the attempted restart
because interactive administrator authentication is required. Until an operator
runs `sudo systemctl restart peakdecline.service`, use ordinary room FPS reports;
the new optional detailed records are only accepted by the updated validator.
