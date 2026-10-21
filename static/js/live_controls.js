// Live-specific actions; visual controls are shared with Watch Together.
(() => {
    const shell = document.getElementById('live-player-shell');
    if (!shell) return;
    const play = document.getElementById('live-play-toggle');
    const mute = document.getElementById('live-mute-toggle');
    const volume = document.getElementById('live-volume');
    const fullscreen = document.getElementById('live-fullscreen-toggle');
    let hideTimer;

    function reveal() {
        shell.classList.add('controls-visible');
        clearTimeout(hideTimer);
        if (!video.paused) hideTimer = setTimeout(() => shell.classList.remove('controls-visible'), 3000);
    }
    function update() {
        play.textContent = video.paused ? '▶' : '❚❚';
        play.title = video.paused ? 'Play' : 'Pause';
        play.setAttribute('aria-label', play.title);
        const silent = video.muted || video.volume === 0;
        mute.textContent = silent ? '🔇' : '🔊';
        mute.title = silent ? 'Unmute' : 'Mute';
        mute.setAttribute('aria-label', mute.title);
        volume.value = video.muted ? 0 : video.volume;
        reveal();
    }
    function togglePlay() {
        if (!currentChannelId) return;
        if (video.paused) safePlay(); else video.pause();
    }
    function toggleMute() {
        if (video.muted || video.volume === 0) { video.muted = false; if (!video.volume) video.volume = 1; }
        else video.muted = true;
        if (typeof rememberPlaybackPreference === 'function') rememberPlaybackPreference();
    }
    async function toggleFullscreen() {
        try {
            if (document.fullscreenElement) await document.exitFullscreen();
            else if (shell.requestFullscreen) await shell.requestFullscreen();
            else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
        } catch (_) {
            fullscreen.title = 'Fullscreen unavailable in this browser';
            fullscreen.setAttribute('aria-label', fullscreen.title);
        }
    }
    play.addEventListener('click', togglePlay);
    mute.addEventListener('click', toggleMute);
    volume.addEventListener('input', () => { video.volume = Number(volume.value); video.muted = video.volume === 0; rememberPlaybackPreference(); });
    document.getElementById('live-go-live').addEventListener('click', () => {
        if (!currentChannelId) return;
        needsAlignment = true;
        lastCorrection = lastClockPoll = -Infinity;
        if (recoveryNeeded) { initPlayer(); return; }
        if (video.paused) safePlay();
        enforceLiveSync();
        reveal();
    });
    fullscreen.addEventListener('click', toggleFullscreen);
    document.addEventListener('fullscreenchange', () => {
        fullscreen.title = document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen';
        fullscreen.setAttribute('aria-label', fullscreen.title);
    });
    for (const event of ['play', 'pause', 'volumechange', 'loadedmetadata']) video.addEventListener(event, update);
    shell.addEventListener('pointermove', reveal);
    shell.addEventListener('pointerdown', event => {
        shell.dataset.controlsInput = event.pointerType === 'touch' ? 'touch' : 'pointer';
        reveal();
    });
    shell.addEventListener('focusin', reveal);
    shell.addEventListener('keydown', event => {
        shell.dataset.controlsInput = 'keyboard';
        reveal();
        // Leave native button/range keyboard actions intact, including volume arrows.
        if (event.target.matches('input, button') || event.altKey || event.ctrlKey || event.metaKey) return;
        if (event.key === ' ' || event.key.toLowerCase() === 'k') { event.preventDefault(); togglePlay(); }
        else if (event.key.toLowerCase() === 'm') toggleMute();
        else if (event.key.toLowerCase() === 'f') toggleFullscreen();
    });
    shell.tabIndex = 0;
    update();
})();
