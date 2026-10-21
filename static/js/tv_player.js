const socket = io();
const channelLogo = document.getElementById("current-channel-logo");
const video = document.getElementById("video-player");
const channelTitle = document.getElementById("current-channel-name");
// Keep Gecko Firefox at normal speed to avoid repeated audio time-stretching
// while investigating reported long-session A/V drift. FxiOS uses WebKit.
const firefoxStablePlayback = /Firefox\/\d+/i.test(
    typeof navigator === 'undefined' ? '' : navigator.userAgent
);

let hls = null;
let currentChannelId = null;
let chatInitialized = false;
let liveSyncTimer = null;
let generation = 0;
let clockSample = null;
let clockRequest = null;
let clockFailure = '';
let lastClockPoll = -Infinity;
let lastCorrection = -Infinity;
let behindSince = null;
let retryTimer = null;
let needsAlignment = true;
let startupPending = false;
const statusText = document.getElementById('current-status-text');
let recoveryNeeded = false;
let statusRequestId = 0;
let streamEpoch = null;
let streamRevision = -1;
let streamSession = null;
let pendingChannelId = null;
let channelCache = [];
let channelLoad = null;
let channelReloadNeeded = false;
let favoritePending = false;
let preferredMuted = false;
let preferredVolume = 1;
let playerPhase = 'idle';
let statusTimer = null;
let successUntil = 0;
let statusVersion = 0;
let autoplayMuted = false;

function showPlayerStatus(phase, message) {
    clearTimeout(statusTimer);
    const version = ++statusVersion;
    playerPhase = phase;
    if (statusText && statusText.textContent !== message) statusText.textContent = message;
    if (phase === 'loading' || phase === 'switching' || phase === 'buffering') {
        const token = generation;
        statusTimer = setTimeout(() => {
            if (token === generation && version === statusVersion && playerPhase === phase && statusText) {
                statusText.textContent = 'Taking longer than expected. Still trying — check your connection or try another channel.';
            }
        }, 20000);
    }
}

function showSyncStatus(message) {
    // Playback events own loading, errors and Play prompts. Clock polling must
    // never replace those with LIVE before frames actually start playing.
    if (playerPhase !== 'playing' || performance.now() < successUntil) return;
    if (autoplayMuted && video.muted) message = 'Playing muted — use the speaker button for sound';
    if (statusText && statusText.textContent !== message) statusText.textContent = message;
}

function rememberPlaybackPreference() {
    preferredMuted = !!video.muted;
    preferredVolume = Number.isFinite(video.volume) ? video.volume : preferredVolume;
}

function notifyLiveQualityLevels() {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
        window.dispatchEvent(new CustomEvent('live-quality-levels', {
            detail: {levels: hls?.levels || [], supported: !!hls}
        }));
    }
}

/* ───────────────── INIT ───────────────── */

document.addEventListener("DOMContentLoaded", () => {
    // ✅ Initialize chat/users immediately
    setupChat();

    // ✅ Load channels/favorites immediately (fixes your “type then delete” bug)
    loadChannels();

    // Join Live TV-specific presence list
    socket.emit("join_live_tv");
    socket.emit("request_live_tv_users");
    socket.on('connect', () => {
        socket.emit('join_live_tv');
        refreshLiveStatus();
        loadChannels();
    });
    socket.on('channels_updated', loadChannels);
    document.getElementById('live-favorite-toggle')?.addEventListener('click', toggleCurrentFavorite);
    document.getElementById('live-end-stream')?.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
            const response = await fetch('/api/live/stop', {
                method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({stream_session: streamSession})
            });
            const result = await response.json();
            if (result.state) applyLiveState(result.state);
            if (!response.ok) throw new Error(result.error || 'Could not end stream');
        } catch (error) {
            document.getElementById('live-favorite-feedback').textContent = error.message;
        } finally { button.disabled = false; }
    });
    document.addEventListener('error', (event) => {
        const img = event.target;
        if (img instanceof HTMLImageElement && img.matches('.ch-logo, .fav-icon, #current-channel-logo') && !img.dataset.fallback) {
            img.dataset.fallback = 'true';
            img.src = '/static/img/channel-fallback.svg';
        }
    }, true);

    // ✅ If someone changes the channel, update everyone
    socket.on("channel_changed", (data) => {
        ++statusRequestId;
        applyLiveState(data);
    });

    // Search should re-render list
    document.getElementById("search-box").addEventListener("input", renderChannels);

    // Get current stream status on load
    refreshLiveStatus();

    // Heartbeat
    setInterval(() => {
        fetch("/api/heartbeat", { method: "POST" }).catch(() => {});
    }, 5000);
});

/* ───────────────── PLAYER ───────────────── */

async function refreshLiveStatus() {
    const requestId = ++statusRequestId;
    try {
        const response = await fetch('/api/status', {cache: 'no-store'});
        if (!response.ok) throw new Error('Status unavailable');
        const data = await response.json();
        if (requestId === statusRequestId) applyLiveState(data);
    } catch (_) {
        if (requestId === statusRequestId && !currentChannelId && pendingChannelId === null) {
            showPlayerStatus('error', 'Unable to check live TV. Refresh to try again.');
        }
    }
}

function applyLiveState(data) {
    if (data.stream_epoch === streamEpoch && data.stream_revision < streamRevision) return;
    streamEpoch = data.stream_epoch;
    streamRevision = data.stream_revision;
    const id = data.is_streaming ? data.current_channel_id : null;
    const changed = id !== currentChannelId || data.stream_session !== streamSession;
    currentChannelId = id;
    streamSession = data.stream_session;
    channelTitle.textContent = data.current_channel_name || 'Select a Channel';
    if (channelLogo) channelLogo.src = data.current_channel_logo || '/static/img/default_channel.png';
    renderChannels();
    if (!changed) {
        if (!id && pendingChannelId === null) showPlayerStatus('idle', 'No active stream. Select a channel to start.');
        return;
    }
    if (id) initPlayer();
    else {
        ++generation;
        clearTimeout(retryTimer);
        clockRequest?.abort();
        clockSample = null;
        updateLiveSyncDisplay(null, null);
        stopLiveSyncMonitor();
        startupPending = recoveryNeeded = false;
        if (hls) { hls.destroy(); hls = null; }
        video.pause();
        video.removeAttribute('src');
        video.load();
        showPlayerStatus('idle', 'No active stream. Select a channel to start.');
    }
}

function initPlayer() {
    if (!currentChannelId) return;

    const url = `/static/stream/${currentChannelId}/index.m3u8?t=${Date.now()}`;

    const token = ++generation;
    autoplayMuted = false;
    recoveryNeeded = false;
    stopLiveSyncMonitor();
    clearTimeout(retryTimer);
    clockRequest?.abort();
    clockRequest = null;
    clockSample = null;
    updateLiveSyncDisplay(null, null);
    clockFailure = '';
    lastClockPoll = lastCorrection = -Infinity;
    needsAlignment = true;
    startupPending = true;
    if (hls) { hls.destroy(); hls = null; }
    video.pause();
    video.muted = preferredMuted;
    video.volume = preferredVolume;
    video.autoplay = false;
    showPlayerStatus('loading', `Loading ${channelTitle.textContent || 'channel'}…`);

    if (Hls.isSupported()) {
        hls = new Hls({
            enableWorker: true,

            liveSyncDuration: 6,
            liveMaxLatencyDuration: 30,
            maxLiveSyncPlaybackRate: 1,
            liveSyncOnStallIncrease: 0,

            maxBufferLength: 12,
            maxMaxBufferLength: 18,
            backBufferLength: 6,

            lowLatencyMode: false,

            capLevelToPlayerSize: true,
            // Live TV starts at native quality by default.  Viewers can opt
            // into Auto/720p/480p from the shared settings cog.
            startLevel: 0
        });

        hls.loadSource(url);
        hls.attachMedia(video);

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
            if (token !== generation) return;
            hls.currentLevel = Math.max(0, hls.levels.length - 1);
            notifyLiveQualityLevels();
            // Begin playback as soon as the manifest is ready. The shared
            // clock aligns playback afterward; it must not gate autoplay.
            safePlay(token);
            startLiveSyncMonitor();
        });

        hls.on(Hls.Events.LEVEL_UPDATED, () => enforceLiveSync('playlist'));

        hls.on(Hls.Events.ERROR, (_, data) => {
            if (data.fatal && token === generation) {
                recoveryNeeded = true;
                showPlayerStatus('error', video.paused && !startupPending
                    ? 'Playback interrupted. Press Play to reconnect.'
                    : 'Playback interrupted. Reconnecting…');
                console.warn("HLS error, retrying...");
                clearTimeout(retryTimer);
                retryTimer = setTimeout(() => {
                    if (token === generation && (startupPending || !video.paused)) initPlayer();
                }, 3000);
            }
        });
    } else {
        video.src = url;
        notifyLiveQualityLevels();
        startLiveSyncMonitor();
        safePlay(token);
    }
}

function safePlay(token = generation) {
    if (token !== generation) return;
    video.muted = preferredMuted;
    video.play().catch(error => {
        if (token !== generation) return;
        if (error.name === 'AbortError') return;
        // Browsers may reject sound before the viewer has interacted with the
        // page. Start the stream muted so a channel switch never leaves a
        // blank player; sound remains available from the speaker control.
        if (!preferredMuted) {
            video.muted = true;
            video.play().then(() => {
                if (token !== generation || video.paused) return;
                startupPending = false;
                autoplayMuted = true;
                successUntil = 0;
                showPlayerStatus('playing', 'Playing muted — use the speaker button for sound');
            }).catch(() => {
                if (token !== generation) return;
                startupPending = false;
                showPlayerStatus('blocked', 'Press Play to join live');
            });
            return;
        }
        startupPending = false;
        showPlayerStatus('blocked', 'Press Play to join live');
    });
}

function stopLiveSyncMonitor() {
    behindSince = null;
    if (liveSyncTimer) {
        clearInterval(liveSyncTimer);
        liveSyncTimer = null;
    }
    video.playbackRate = 1;
}

async function pollLiveClock() {
    if (clockRequest || !currentChannelId) return;
    const token = generation, controller = new AbortController();
    clockRequest = controller;
    const sent = performance.now();
    lastClockPoll = sent;
    const timeout = setTimeout(() => controller.abort(), 2500);
    try {
        const response = await fetch(`/api/live-clock/${currentChannelId}`, {cache: 'no-store', signal: controller.signal});
        if (!response.ok) {
            const failure = await response.json().catch(() => ({}));
            const reasons = {
                inactive_stream: 'Server does not recognize this as the active stream',
                missing_playlist: 'Server has no timeline playlist for this stream',
                unreadable_playlist: 'Server cannot read the timeline playlist',
                invalid_timestamps: 'Server cannot read timestamps from the timeline playlist'
            };
            const reason = reasons[failure.reason] || (failure.error === 'Stream unavailable'
                ? 'Server does not recognize this as the active stream'
                : failure.error === 'Stream clock unavailable' ? 'Server cannot read the stream timeline' : 'Server timeline unavailable');
            throw new Error(`${reason} (HTTP ${response.status})`);
        }
        const sample = await response.json();
        const received = performance.now(), rtt = (received - sent) / 1000;
        if (token !== generation || sample.channel_id !== currentChannelId) return;
        if (rtt > 2) { clockFailure = 'Server timeline response is too slow'; return; }
        if (![sample.target_pdt, sample.edge_pdt, sample.max_extrapolation].every(Number.isFinite)) {
            clockFailure = 'Server returned an invalid timeline'; return;
        }
        clockSample = {...sample, received, rtt};
        clockFailure = sample.fresh ? '' : 'Server is waiting for new chunks';
        enforceLiveSync();
    } catch (error) {
        // A single failed poll must not discard an otherwise fresh sample.
        if (token === generation) clockFailure = error.name === 'AbortError'
            ? 'Server timeline request timed out' : error.message;
    } finally {
        clearTimeout(timeout);
        if (clockRequest === controller) clockRequest = null;
    }
}

function programOffset() {
    // Media currentTime origins differ for late joins. Map through dated HLS
    // fragments, never compare raw currentTime across browsers.
    const fragments = (hls?.latestLevelDetails || hls?.levels?.[hls.currentLevel]?.details)?.fragments || [];
    const fragment = fragments.find(f => f.programDateTime != null &&
        Number.isFinite(f.programDateTime) && Number.isFinite(f.start) &&
        clockSample?.session === f.relurl?.split(/[\\/]/).pop().split('?')[0].replace(/_\d+\.ts$/, ''));
    if (fragment) {
        const playingDate = hls.playingDate;
        // Prefer the demuxed fragment currently playing: unbuffered playlist
        // fragments may still have provisional media start positions.
        if (playingDate && Number.isFinite(playingDate.getTime())) {
            return playingDate.getTime() / 1000 - video.currentTime;
        }
        return fragment.programDateTime / 1000 - fragment.start;
    }
    if (!hls && typeof video.getStartDate === 'function') {
        const date = video.getStartDate().getTime() / 1000;
        if (Number.isFinite(date)) return date;
    }
    return null;
}

function sharedTarget() {
    if (!clockSample?.fresh) return null;
    const age = (performance.now() - clockSample.received) / 1000;
    if (age > clockSample.max_extrapolation) return null;
    return Math.min(clockSample.target_pdt + age + clockSample.rtt / 2, clockSample.edge_pdt - 0.25);
}

function updateLiveSyncDisplay(offset, targetPdt) {
    const server = document.getElementById('live-server-time');
    const viewer = document.getElementById('live-viewer-time');
    const difference = document.getElementById('live-sync-difference');
    if (!server || !viewer || !difference) return;
    const valid = currentChannelId !== null && Number.isFinite(targetPdt);
    const viewerPdt = valid && Number.isFinite(offset) && Number.isFinite(video.currentTime)
        ? offset + video.currentTime : null;
    const origin = clockSample?.stream_start_pdt;
    const format = seconds => {
        const elapsed = Math.max(0, seconds - origin);
        const hours = Math.floor(elapsed / 3600);
        const minutes = Math.floor(elapsed / 60) % 60;
        const rest = (Math.floor(elapsed * 10) % 600 / 10).toFixed(1).padStart(4, '0');
        return `${hours ? hours + ':' : ''}${String(minutes).padStart(2, '0')}:${rest}`;
    };
    server.textContent = valid && Number.isFinite(origin) ? format(targetPdt) : '—';
    viewer.textContent = Number.isFinite(viewerPdt) && Number.isFinite(origin) ? format(viewerPdt) : '—';
    if (!valid || !Number.isFinite(viewerPdt)) {
        difference.textContent = currentChannelId === null ? 'No active stream'
            : !valid ? clockFailure || (clockSample ? 'Server timeline is stale' : 'Waiting for server timeline')
            : 'Waiting for video timeline';
        return;
    }
    const delta = viewerPdt - targetPdt;
    const rounded = Math.abs(delta).toFixed(1);
    const gap = `${rounded}s ${rounded !== '0.0' && delta > 0 ? 'ahead' : 'behind'}`;
    const state = video.paused ? 'Paused' : video.seeking ? 'Syncing'
        : playerPhase !== 'playing' ? 'Loading' : Math.abs(delta) <= 1 ? 'In sync' : 'Out of sync';
    difference.textContent = `${state} · ${gap}`;
}

function enforceLiveSync() {
    const now = performance.now();
    if (now - lastClockPoll >= 1000) pollLiveClock();
    const offset = programOffset(), targetPdt = sharedTarget();
    updateLiveSyncDisplay(offset, targetPdt);
    if (video.paused && !startupPending) { behindSince = null; video.playbackRate = 1; return; }
    if (offset === null || targetPdt === null) {
        behindSince = null;
        video.playbackRate = 1;
        showSyncStatus('Playing — live sync temporarily unavailable');
        return;
    }
    const target = targetPdt - offset, drift = target - video.currentTime;
    showSyncStatus(Math.abs(drift) <= 1 ? 'LIVE' : 'Catching up to live…');
    if (video.seeking) { behindSince = null; return; }
    let seekable = false;
    let buffered = false;
    for (let i = 0; i < video.seekable.length; i++) {
        if (target >= video.seekable.start(i) && target < video.seekable.end(i)) seekable = true;
    }
    for (let i = 0; i < video.buffered.length; i++) {
        if (target >= video.buffered.start(i) && target + 0.25 < video.buffered.end(i)) buffered = true;
    }
    if (startupPending && video.paused) {
        // Start with media at the common target already available. Starting
        // earlier and repeatedly seeking into downloads creates startup stalls.
        if (buffered && seekable) {
            startupPending = false;
            if (Math.abs(drift) > 0.15) video.currentTime = target;
            needsAlignment = false;
            lastCorrection = now;
            safePlay();
        } else if (seekable && Math.abs(drift) > 1 && now - lastCorrection > 4000) {
            // Move the loader's focus too: a paused element otherwise fills
            // its buffer around an obsolete position and never reaches live.
            lastCorrection = now;
            video.currentTime = target;
        }
        return;
    }
    // Startup/resume and an explicit Sync request may align immediately.
    // During normal playback never rewind to chase a moving clock sample.
    if (needsAlignment && Math.abs(drift) <= 0.35) needsAlignment = false;
    if (needsAlignment && seekable && now - lastCorrection > (buffered ? 1000 : 4000)) {
        lastCorrection = now;
        video.currentTime = target;
        video.playbackRate = 1;
        needsAlignment = false;
        behindSince = null;
        return;
    }
    // A transient target jump or stalled download must not trigger seek loops.
    // Skip forward only after sustained, substantial lag, into buffered media.
    if (drift > 4 && buffered && seekable && video.readyState >= 3) {
        if (behindSince === null) behindSince = now;
        if (now - behindSince >= 3000 && now - lastCorrection >= 15000) {
            video.currentTime = target;
            lastCorrection = now;
            behindSince = null;
            video.playbackRate = 1;
            return;
        }
    } else {
        behindSince = null;
    }
    if (video.readyState >= 3 && !firefoxStablePlayback) {
        video.playbackRate = Math.abs(drift) <= 0.35 ? 1 : (drift > 0 ? 1.02 : 0.98);
    } else {
        video.playbackRate = 1;
    }
}

function startLiveSyncMonitor() {
    stopLiveSyncMonitor();
    liveSyncTimer = setInterval(enforceLiveSync, 250);
    enforceLiveSync();
}

video.addEventListener('play', () => {
    if (recoveryNeeded) { initPlayer(); return; }
    if (playerPhase === 'paused' || playerPhase === 'blocked') showPlayerStatus('loading', 'Joining live…');
    // A viewer may pause locally, but when they resume they rejoin the shared
    // live edge instead of replaying stale buffered content.
    needsAlignment = true;
    enforceLiveSync();
});

video.addEventListener('pause', () => {
    video.playbackRate = 1;
    if (currentChannelId && !startupPending && playerPhase !== 'switching' && playerPhase !== 'error') {
        showPlayerStatus('paused', 'Paused. Press Play to return to live.');
    }
});
video.addEventListener('canplay', enforceLiveSync);
video.addEventListener('playing', () => {
    if (!currentChannelId || video.paused || recoveryNeeded) return;
    startupPending = false;
    if (playerPhase === 'switching' || playerPhase === 'error') return;
    if (playerPhase !== 'playing') {
        successUntil = performance.now() + 3000;
        showPlayerStatus('playing', `Now playing ${channelTitle.textContent || 'live TV'}`);
    }
});
video.addEventListener('waiting', () => {
    if (!video.paused && playerPhase === 'playing') showPlayerStatus('buffering', 'Buffering… Waiting for more video.');
});
video.addEventListener('volumechange', () => {
    if (autoplayMuted && !video.muted) {
        autoplayMuted = false;
        successUntil = 0;
        enforceLiveSync();
    }
});
video.addEventListener('ended', () => {
    if (currentChannelId && !startupPending && playerPhase !== 'switching') {
        showPlayerStatus('error', 'Stream ended. Select a channel or refresh to retry.');
    }
});
video.addEventListener('error', () => {
    if (currentChannelId && !hls) showPlayerStatus('error', 'Unable to load this channel. Try another channel or refresh to retry.');
});
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { lastClockPoll = -Infinity; enforceLiveSync(); }
});

async function playChannel(id, name) {
    if (pendingChannelId !== null) return;
    pendingChannelId = id;
    const label = name || channelCache.find(ch => ch.id === id)?.name || 'channel';
    if (id !== currentChannelId) showPlayerStatus('switching', `Switching to ${label}…`);
    const requestedGeneration = generation;
    ++statusRequestId;
    try {
        const response = await fetch(`/api/play/${id}`, {method: 'POST'});
        const data = await response.json();
        if (data.state) applyLiveState(data.state);
        if (!response.ok) throw new Error(data.error || 'Unable to start channel');
        if (currentChannelId === id && video.paused && !startupPending) safePlay();
        loadChannels();
    } catch (error) {
        // A late failure from an older request must not cover a newer stream.
        if (generation === requestedGeneration || currentChannelId === null) {
            showPlayerStatus('error', `Unable to switch to ${label}. Try again or choose another channel.`);
        }
    } finally {
        pendingChannelId = null;
    }
}

/* ───────────────── CHANNEL LIST ───────────────── */

function loadChannels() {
    if (channelLoad) { channelReloadNeeded = true; return channelLoad; }
    channelLoad = fetch("/api/channels", {cache: 'no-store'})
        .then(r => { if (!r.ok) throw new Error('Channels unavailable'); return r.json(); })
        .then(channels => {
            channelCache = channels;
            renderChannels();
        }).catch(() => {}).finally(() => {
            channelLoad = null;
            if (channelReloadNeeded) { channelReloadNeeded = false; loadChannels(); }
        });
    return channelLoad;
}

function renderChannels() {
            updateFavoriteButton();
            const list = document.getElementById("channel-list");
            const favs = document.getElementById("favorites-list");

            // ✅ Fix: trim hidden whitespace so first-load doesn’t filter everything out
            const term = (document.getElementById("search-box").value || "").trim().toLowerCase();

            const signature = JSON.stringify([term, channelCache]);
            if (list.dataset.signature === signature) {
                list.querySelectorAll('.channel-item').forEach(item => item.classList.toggle('active', Number(item.dataset.channelId) === currentChannelId));
                return;
            }
            list.dataset.signature = signature;
            list.innerHTML = "";
            favs.innerHTML = "";

            [...channelCache].sort((a, b) => (b.play_count || 0) - (a.play_count || 0)
                || (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase()) || a.id - b.id).forEach(ch => {
                const nameLower = (ch.name || "").toLowerCase();

                // ✅ Only filter if term is not empty
                const matchesSearch = !term || nameLower.includes(term);
                if (!matchesSearch && ch.Favorites !== true) return;

                const item = document.createElement("div");
                item.className = `channel-item ${ch.id === currentChannelId ? "active" : ""}`;
                item.dataset.channelId = ch.id;
                item.onclick = () => playChannel(ch.id, ch.name,ch.logo);
                item.title = `${ch.play_count || 0} plays`;
                const img = document.createElement('img');
                img.className = 'ch-logo';
                img.loading = 'lazy';
                img.decoding = 'async';
                img.src = ch.logo || '/static/img/default_channel.png';
                const label = document.createElement('span');
                label.textContent = ch.name;
                item.appendChild(img);
                item.appendChild(label);
                if (matchesSearch) list.appendChild(item);

                if (ch.Favorites === true) {
                    const fav = document.createElement("div");
                    fav.className = "fav-card";
                    fav.onclick = () => playChannel(ch.id, ch.name,ch.logo);

                    const icon = document.createElement('img');
                    icon.className = 'fav-icon';
                    icon.loading = 'lazy';
                    icon.decoding = 'async';
                    icon.src = ch.logo || '/static/img/default_channel.png';
                    icon.alt = ch.name;
                    const name = document.createElement('div');
                    name.className = 'fav-name';
                    name.textContent = ch.name;
                    fav.appendChild(icon);
                    fav.appendChild(name);

                    favs.appendChild(fav);
                }
            });
}

function updateFavoriteButton() {
    const button = document.getElementById('live-favorite-toggle');
    if (!button) return;
    const channel = channelCache.find(ch => ch.id === currentChannelId);
    const favorite = channel?.Favorites === true;
    button.disabled = !channel || favoritePending;
    button.textContent = favorite ? '★ Remove Favorite' : '☆ Add Favorite';
    button.setAttribute('aria-pressed', String(favorite));
}

async function toggleCurrentFavorite() {
    const channel = channelCache.find(ch => ch.id === currentChannelId);
    if (!channel || favoritePending) return;
    favoritePending = true;
    const feedback = document.getElementById('live-favorite-feedback');
    if (feedback) feedback.textContent = '';
    updateFavoriteButton();
    try {
        const response = await fetch(`/api/channels/${channel.id}/favorite`, {
            method: 'PUT', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({favorite: !channel.Favorites})
        });
        if (!response.ok) throw new Error('Favorite could not be saved');
        const saved = await response.json();
        const cached = channelCache.find(ch => ch.id === saved.id);
        if (cached) cached.Favorites = saved.Favorites;
        renderChannels();
        loadChannels();
    } catch (_) {
        if (feedback) feedback.textContent = 'Could not save favorite. Please try again.';
    } finally {
        favoritePending = false;
        updateFavoriteButton();
    }
}

/* ───────────────── CHAT ───────────────── */

function setupChat() {
    // ✅ Prevent double-binding handlers if called again
    if (chatInitialized) return;
    chatInitialized = true;

    const input = document.getElementById("chat-input");
    const box = document.getElementById("chat-messages");
    const users = document.getElementById("users-list");
    const count = document.getElementById("user-count");

    document.getElementById("send-btn").onclick = send;

    input.addEventListener("keypress", e => {
        if (e.key === "Enter") send();
    });

    function send() {
        const msg = input.value.trim();
        if (!msg) return;
        socket.emit("chat_message", msg);
        input.value = "";
    }

    socket.on("chat_message", data => {
        const div = document.createElement("div");
        div.className = "msg";
        const author = document.createElement('strong');
        author.textContent = data.user;
        div.appendChild(profileAvatar(data.avatar));
        div.appendChild(author);
        div.appendChild(document.createTextNode(`: ${data.text}`));
        box.appendChild(div);
        box.scrollTop = box.scrollHeight;
    });

    const viewerPictures = new Map();
    socket.on("live_tv_profiles_update", list => {
        list.forEach(person => viewerPictures.set(person.name, person.avatar));
    });
    socket.on("live_tv_users_update", list => {
        users.innerHTML = "";
        count.textContent = list.length;

        list.forEach(u => {
            const row = document.createElement('div');
            row.className = 'user-row';
            row.append(profileAvatar(viewerPictures.get(u)), document.createTextNode(u));
            users.appendChild(row);
        });
    });
}
