(() => {
    const cog = document.getElementById('live-quality-cog');
    const panel = document.getElementById('live-quality-panel');
    const select = document.getElementById('live-quality-select');
    const note = document.getElementById('live-quality-note');
    const status = document.getElementById('live-quality-status');
    if (!cog || !panel || !select) return;

    let levels = [];
    let selected = 'native';
    let hlsSupported = true;
    let observedPlayer = null;
    let pendingQuality = null;
    let qualityTimer = null;
    let automaticFallback = false;

    function updateStatus() {
        const height = Math.max(0, ...levels.map(level => Number(level.height) || 0));
        const resolution = height === 2160 ? '4K' : height === 4320 ? '8K' : `${height}p`;
        const nativeLabel = `Native resolution${height > 0 ? ` (${resolution})` : ''}`;
        for (const option of select.options) {
            if (option.value === 'native') option.textContent = nativeLabel;
        }
        if (status) status.textContent = `Quality: ${selected === 'auto' ? 'Auto (adaptive)' : selected === 'native' ? nativeLabel : `${selected}p`}`;
    }

    function qualityLabel(value) { return value === 'native' ? 'native resolution' : `${value}p`; }
    function finishQuality(player) {
        if (!pendingQuality || player !== observedPlayer || player.currentLevel !== pendingQuality.index) return;
        clearTimeout(qualityTimer);
        if (note) note.textContent = `Using ${qualityLabel(pendingQuality.value)}.`;
        pendingQuality = null;
    }

    function setPanel(open) {
        panel.style.display = open ? 'flex' : 'none';
        cog.classList.toggle('panel-open', open);
        cog.setAttribute('aria-expanded', String(open));
    }

    function updateOptions(detail) {
        levels = detail?.levels || [];
        const supported = detail?.supported !== false;
        hlsSupported = supported;
        const player = typeof hls === 'undefined' ? null : hls;
        if (player !== observedPlayer) {
            clearTimeout(qualityTimer);
            pendingQuality = null;
            observedPlayer = player;
            if (player?.on) player.on(Hls.Events.LEVEL_SWITCHED, () => finishQuality(player));
        }
        for (const option of select.options) {
            option.disabled = !supported && option.value !== 'auto';
        }
        if (note) note.textContent = supported
            ? automaticFallback ? 'Switched to Auto after buffering. Select Native to retry full quality.' : 'Quality changes keep you on the shared live timeline.'
            : 'Automatic quality selection is used by this browser.';
        if (!supported) {
            select.value = selected = 'auto';
        }
        if (supported) applyQuality(selected, false);
        updateStatus();
    }

    function applyQuality(value, announce = true) {
        selected = value;
        if (announce) {
            automaticFallback = false;
            if (typeof fallbackRequested !== 'undefined') fallbackRequested = false;
            if (typeof bufferingEvents !== 'undefined') bufferingEvents = [];
        }
        updateStatus();
        const player = (() => { try { return hls; } catch (_) { return null; } })();
        if (!player || !levels.length) {
            if (!hlsSupported) {
                select.value = 'auto';
                selected = 'auto';
                updateStatus();
            }
            return;
        }
        let index = -1;
        if (value !== 'auto') {
            const target = value === 'native' ? Infinity : Number(value);
            const candidates = levels.map((level, i) => ({i, height: Number(level.height) || 0}))
                .filter(level => target === Infinity || level.height <= target);
            index = candidates.length
                ? candidates.reduce((best, level) => level.height > best.height ? level : best).i
                : levels.reduce((best, level, i) => (Number(level.height) < Number(levels[best]?.height) ? i : best), 0);
        }
        if (index >= levels.length) {
            select.value = 'auto';
            selected = 'auto';
            updateStatus();
            if (note) note.textContent = `${value}p is unavailable for this channel.`;
            return;
        }
        const wasPlaying = typeof video !== 'undefined' && !video.paused;
        if (announce && note) {
            clearTimeout(qualityTimer);
            pendingQuality = index < 0 ? null : {index, value};
            note.textContent = index < 0 ? 'Automatic quality enabled.' : wasPlaying
                ? `Switching to ${qualityLabel(value)}…`
                : `${qualityLabel(value)} selected. Applies when playback resumes.`;
            if (wasPlaying && pendingQuality) qualityTimer = setTimeout(() => {
                if (observedPlayer === player && pendingQuality?.value === value) {
                    note.textContent = 'Quality change is taking longer than expected. Try another quality.';
                }
            }, 20000);
        }
        if (typeof needsAlignment !== 'undefined') needsAlignment = true;
        if (typeof lastCorrection !== 'undefined') lastCorrection = -Infinity;
        player.currentLevel = index;
        player.nextLevel = index;
        if (typeof enforceLiveSync === 'function') enforceLiveSync();
        if (wasPlaying && video.paused && typeof safePlay === 'function') safePlay();
        if (announce && wasPlaying) finishQuality(player);
    }

    cog.addEventListener('click', event => {
        event.stopPropagation();
        setPanel(panel.style.display !== 'flex');
    });
    select.addEventListener('change', () => applyQuality(select.value));
    document.addEventListener('pointerdown', event => {
        if (!panel.contains(event.target) && event.target !== cog) setPanel(false);
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') setPanel(false);
    });
    window.addEventListener('live-quality-fallback', () => {
        const player = typeof hls === 'undefined' ? null : hls;
        if (!player || !hlsSupported || selected === 'auto') return;
        select.value = 'auto';
        automaticFallback = true;
        applyQuality('auto', false);
        clearTimeout(qualityTimer);
        pendingQuality = null;
        if (note) note.textContent = 'Switched to Auto after buffering. Select Native to retry full quality.';
    });
    window.addEventListener('live-quality-levels', event => updateOptions(event.detail));
    cog.setAttribute('aria-expanded', 'false');
    updateOptions({levels: [], supported: true});
})();
