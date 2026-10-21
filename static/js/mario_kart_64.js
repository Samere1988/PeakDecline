(() => {
    'use strict';
    const area = document.getElementById('mk64-game');
    const canvas = document.getElementById('mk64-canvas');
    // Spectators capture between native renders; keep the last displayed frame
    // available instead of letting WebGL clear it after the browser composites it.
    const getCanvasContext = canvas.getContext;
    canvas.getContext = function(kind, options) {
        if (kind === 'webgl' || kind === 'webgl2' || kind === 'experimental-webgl')
            options = {...options, preserveDrawingBuffer: true};
        return getCanvasContext.call(this, kind, options);
    };
    const start = document.getElementById('mk64-start');
    const restart = document.getElementById('mk64-restart');
    const fullscreen = document.getElementById('mk64-fullscreen');
    const message = document.getElementById('mk64-message');
    const status = document.getElementById('mk64-runtime-status');
    window.GameFullscreen.create({area, button: fullscreen, status,
        focusGame: () => { if (!canvas.hidden) canvas.focus(); }});
    let audioContext = null;
    let audioGain = null, audioMix = null;
    window.mk64SpectatorAudioSource = () => audioMix;
    let audioNextTime = 0;
    const volume = document.getElementById('mk64-volume');
    const volumeValue = document.getElementById('mk64-volume-value');
    const volumeKey = 'mk64-volume';
    let volumeLevel = 1;
    try {
        const stored = Number(localStorage.getItem(volumeKey));
        if (localStorage.getItem(volumeKey) !== null && Number.isFinite(stored)) volumeLevel = Math.min(1, Math.max(0, stored));
    } catch (_) { /* Storage may be unavailable. */ }
    if (volume) {
        volume.value = String(Math.round(volumeLevel * 100));
        volumeValue.textContent = `${volume.value}%`;
        volume.addEventListener('input', () => {
            volumeLevel = Number(volume.value) / 100;
            volumeValue.textContent = `${volume.value}%`;
            if (audioGain) audioGain.gain.setTargetAtTime(volumeLevel, audioContext.currentTime, 0.01);
            try { localStorage.setItem(volumeKey, String(volumeLevel)); } catch (_) { /* Storage may be unavailable. */ }
        });
    }
    function unlockAudio() {
        const Context = window.AudioContext || window.webkitAudioContext;
        if (!Context) return;
        if (!audioContext || audioContext.state === 'closed') {
            audioContext = new Context();
            audioGain = audioContext.createGain();
            audioGain.gain.value = volumeLevel;
            audioGain.connect(audioContext.destination);
            audioMix = audioContext.createGain(); audioMix.connect(audioGain);
        }
        if (audioContext.state === 'suspended')
            audioContext.resume().catch(error => console.warn('MK64 audio:', error));
    }
    const audioOutput = {
        queuedSamples(rate) {
            return audioContext?.state === 'running' ? Math.max(0, (audioNextTime - audioContext.currentTime) * rate) | 0 : 0;
        },
        enqueue(pcm, rate) {
            if (!audioContext || audioContext.state !== 'running' || !rate) return;
            const frames = pcm.length >> 1;
            if (!frames) return;
            const now = audioContext.currentTime;
            if (audioNextTime < now || audioNextTime > now + 0.25) audioNextTime = now + 0.05;
            const buffer = audioContext.createBuffer(2, frames, rate);
            const left = buffer.getChannelData(0), right = buffer.getChannelData(1);
            for (let i = 0; i < frames; ++i) {
                left[i] = pcm[i * 2] / 32768;
                right[i] = pcm[i * 2 + 1] / 32768;
            }
            const source = audioContext.createBufferSource();
            source.buffer = buffer;
            source.connect(audioMix);
            source.start(audioNextTime);
            audioNextTime += frames / rate;
        }
    };
    document.addEventListener('pointerdown', unlockAudio);
    document.addEventListener('keydown', unlockAudio);
    if (!start || !area.dataset.buildUrl) return;
    const controller = window.RetroControllers.create('mk64');
    const sampled = {buttons: 0, x: 0, y: 0};
    const input = {
        get buttons() { sampleInput(); return sampled.buttons; },
        get x() { return sampled.x; },
        get y() { return sampled.y; }
    };
    const keys = new Set();
    const controls = new Set(['Enter', 'KeyX', 'KeyC', 'KeyZ', 'KeyS', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
    let running = false;
    let currentModule = null, accountSaves = null, activeNetwork = null;
    let launchGeneration = 0, stopping = null;
    const terminalModules = new WeakSet();
    let spectating = false;
    const touchMenu = document.getElementById('mk64-touch-menu');
    const touchSettings = document.getElementById('mk64-touch-settings');
    const touchVisible = document.getElementById('mk64-touch-visible');
    const touchOpacity = document.getElementById('mk64-touch-opacity');
    const touchSize = document.getElementById('mk64-touch-size');
    const touchStorageKey = `mk64-touch-v1-${Math.min(screen.width, screen.height) >= 600 ? 'tablet' : 'phone'}`;
    let touchPreference = {visible: true, opacity: 75, size: 100};
    let touchSettingsOpen = false;
    try {
        const saved = JSON.parse(localStorage.getItem(touchStorageKey) || '{}');
        if (typeof saved.visible === 'boolean') touchPreference.visible = saved.visible;
        if (Number.isFinite(saved.opacity)) touchPreference.opacity = Math.max(25, Math.min(100, saved.opacity));
        if (Number.isFinite(saved.size)) touchPreference.size = Math.max(70, Math.min(150, saved.size));
    } catch (_) { /* Use defaults if storage is unavailable. */ }
    function applyTouchPreference() {
        touchVisible.checked = touchPreference.visible;
        touchOpacity.value = String(touchPreference.opacity);
        touchSize.value = String(touchPreference.size);
        document.getElementById('mk64-touch-opacity-value').textContent = `${touchPreference.opacity}%`;
        document.getElementById('mk64-touch-size-value').textContent = `${touchPreference.size}%`;
        area.style.setProperty('--mk64-touch-opacity', String(touchPreference.opacity / 100));
        area.style.setProperty('--mk64-touch-scale', String(touchPreference.size / 100));
    }
    function saveTouchPreference() {
        try { localStorage.setItem(touchStorageKey, JSON.stringify(touchPreference)); }
        catch (_) { /* Settings remain active for this session. */ }
    }
    applyTouchPreference();
    const touch = window.mk64Touch?.create({
        overlay: document.getElementById('mk64-touch-controls'),
        raceState: () => currentModule?._web_race_state?.() ?? -1
    });
    function updateTouchVisibility() {
        const available = running && touch?.mobile && !spectating;
        touchMenu.hidden = !available;
        if (!available) {
            touchSettingsOpen = false;
            touchSettings.hidden = true;
            touchMenu.setAttribute('aria-expanded', 'false');
        }
        area.classList.toggle('mk64-touch-layout', !!available);
        touch?.setEnabled(available && touchPreference.visible && !touchSettingsOpen && controller.availablePads().length === 0);
    }
    function setTouchSettingsOpen(open) {
        touchSettingsOpen = open;
        touchSettings.hidden = !open;
        touchMenu.setAttribute('aria-expanded', String(open));
        if (open) release();
        updateTouchVisibility();
    }
    touchMenu.addEventListener('click', () => setTouchSettingsOpen(!touchSettingsOpen));
    document.getElementById('mk64-touch-settings-close').addEventListener('click', () => setTouchSettingsOpen(false));
    touchVisible.addEventListener('change', () => {
        touchPreference.visible = touchVisible.checked;
        saveTouchPreference();
        updateTouchVisibility();
    });
    for (const [inputElement, key] of [[touchOpacity, 'opacity'], [touchSize, 'size']])
        inputElement.addEventListener('input', () => {
            touchPreference[key] = Number(inputElement.value);
            applyTouchPreference();
            saveTouchPreference();
        });
    function sampleInput() {
        sampled.buttons = (keys.has('Enter') ? 0x1000 : 0) | (keys.has('KeyX') ? 0x8000 : 0) |
            (keys.has('KeyC') ? 0x4000 : 0) | (keys.has('KeyZ') ? 0x2000 : 0) | (keys.has('KeyS') ? 0x10 : 0);
        sampled.x = (keys.has('ArrowRight') ? 80 : 0) - (keys.has('ArrowLeft') ? 80 : 0);
        sampled.y = (keys.has('ArrowUp') ? 80 : 0) - (keys.has('ArrowDown') ? 80 : 0);
        const touched = touch?.read();
        if (touched) {
            sampled.buttons |= touched.buttons;
            sampled.x = touched.x || sampled.x;
            sampled.y = touched.y || sampled.y;
        }
        updateTouchVisibility();
        const mapped = controller.read();
        sampled.buttons |= mapped.buttons;
        sampled.x = mapped.x || sampled.x;
        sampled.y = mapped.y || sampled.y;
    }
    function release() { keys.clear(); touch?.reset(); }
    canvas.addEventListener('keydown', event => {
        if (running && controls.has(event.code)) {
            event.preventDefault(); keys.add(event.code);
        }
    });
    window.addEventListener('keyup', event => { keys.delete(event.code); });
    canvas.addEventListener('blur', () => keys.clear());
    window.addEventListener('blur', release);
    window.addEventListener('orientationchange', release);
    document.addEventListener('visibilitychange', () => { if (document.hidden) release(); });
    document.addEventListener('fullscreenchange', () => touch?.reset());
    canvas.addEventListener('click', () => canvas.focus());
    function fail(error) {
        running = false; release();
        updateTouchVisibility();
        audioContext?.suspend().catch(() => {});
        console.error('MK64 development build:', error);
        status.textContent = 'This development build stopped. Reload to try again.';
        restart.hidden = false;
        activeNetwork?.fail?.(error?.message || 'Mario Kart 64 stopped unexpectedly.');
    }
    // Asyncify resumes the game after callMain has returned, so later WASM
    // exceptions arrive at the window rather than the startup try/catch.
    function runtimeFailure(error, filename = '') {
        if (running && /mk64\.(?:js|wasm)(?:[:?\s)]|$)/.test(filename + '\n' + (error?.stack || ''))) {
            if (currentModule) terminalModules.add(currentModule);
            fail(error);
        }
    }
    window.addEventListener('error', event => runtimeFailure(event.error, event.filename));
    window.addEventListener('unhandledrejection', event => runtimeFailure(event.reason));
    canvas.addEventListener('webglcontextlost', event => {
        event.preventDefault();
        if (running) fail(new Error('The browser lost its graphics context.'));
    });
    restart.addEventListener('click', () => {
        if (window.mk64RequestRestart && window.mk64RequestRestart()) {
            restart.disabled = true;
            status.textContent = 'Restarting the game for everyone…';
        } else window.location.reload();
    });
    async function stopCurrent() {
        ++launchGeneration;
        activeNetwork = null;
        if (stopping) return stopping;
        const module = currentModule, saves = accountSaves;
        stopping = (async () => {
            module?.mk64HD?.dispose();
            if (module && !terminalModules.has(module)) module._web_stop?.();
            if (module?._web_is_stopped && !terminalModules.has(module)) {
                const deadline = performance.now() + 2000;
                while (!module._web_is_stopped()) {
                    if (performance.now() >= deadline) throw new Error('Mario Kart 64 could not stop safely. Reload the page.');
                    await new Promise(resolve => setTimeout(resolve, 4));
                }
            }
            await saves?.stop();
            if (currentModule === module) currentModule = null;
            if (accountSaves === saves) accountSaves = null;
        })();
        try { await stopping; } finally { stopping = null; }
    }
    window.mk64StopOnline = async () => {
        controller.cancel();
        running = false;
        release();
        updateTouchVisibility();
        audioContext?.suspend().catch(() => {});
        restart.textContent = 'Return to rooms';
        restart.disabled = false;
        restart.hidden = false;
        await stopCurrent();
    };
    window.mk64RestartOnline = async online => {
        controller.cancel();
        running = false;
        release();
        updateTouchVisibility();
        const stopped = stopCurrent(), generation = launchGeneration;
        await stopped;
        if (generation !== launchGeneration) return;
        audioNextTime = 0;
        restart.disabled = false;
        canvas.hidden = true;
        return launch(online);
    };
    async function launch(online = null) {
        const generation = ++launchGeneration;
        activeNetwork = online?.network || null;
        let module, nativeStarted = false;
        unlockAudio();
        document.getElementById('mk64-room-browser').hidden = true;
        document.getElementById('mk64-lobby').hidden = true;
        document.getElementById('mk64-play-area').hidden = false;
        if (!online) document.getElementById('mk64-play-title').textContent = 'Mario Kart 64 · Solo';
        start.disabled = true;
        message.textContent = 'Loading Mario Kart 64…';
        try {
            if (!window.createMK64) await new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = area.dataset.buildUrl;
                script.onload = resolve;
                script.onerror = () => reject(new Error('Could not load the browser build.'));
                document.head.appendChild(script);
            });
            if (generation !== launchGeneration) return;
            canvas.hidden = false;
            module = await window.createMK64({
                canvas, noInitialRun: true,
                locateFile: name => new URL(name, new URL(area.dataset.buildUrl, location.href)).href,
                print: text => console.debug(text), printErr: text => console.warn(text),
                onAbort: error => {
                    if (module) terminalModules.add(module);
                    if (generation === launchGeneration) fail(error);
                }
            });
            if (generation !== launchGeneration) { module._web_stop?.(); return; }
            window.mk64 = module;
            currentModule = module;
            const response = await fetch(area.dataset.romUrl);
            if (generation !== launchGeneration) return;
            if (!response.ok) throw new Error('Game data is unavailable.');
            const rom = new Uint8Array(await response.arrayBuffer());
            if (generation !== launchGeneration) return;
            if (rom.length !== 0xC00000) throw new Error('Unexpected game data size.');
            module.FS.writeFile('/baserom.us.z64', rom);
            const saves=await PeakSaves.fs(module,{game:'mk64',paths:{'eeprom.bin':'/eeprom.bin'},bridge:online?.network});
            if (generation !== launchGeneration) { await saves.stop(); return; }
            accountSaves=saves;
            module.mk64Input = input;
            module.mk64Audio = audioOutput;
            if (online) {
                module.mk64Multiplayer = true;
                module.mk64NativeMenus = true;
                module.mk64LocalSlot = online.slot;
                module.mk64PlayerCount = online.players;
                module.mk64Network = online.network;
                online.network.bind(module, input);
            }
            running = true;
            spectating = !!online?.network?.spectator;
            updateTouchVisibility();
            message.hidden = true;
            start.hidden = true;
            restart.hidden = online ? !online.canRestart : false;
            status.textContent = spectating ? 'Spectating the live race. Players control the game.' : touch?.mobile ?
                'Touch controls ready. Landscape mode gives the game a larger view.' : online ?
                    '' :
                    'Development build running. Use your controller or click the game for keyboard input.';
            canvas.focus();
            nativeStarted = true;
            const result = module.callMain([]);
            if (online?.network?.externallyStepped) await online.network.initialized(module, input);
            if (Number.isInteger(result) && result !== 0) throw new Error('Mario Kart 64 could not initialize its game data.');
        } catch (error) {
            if (generation !== launchGeneration) return;
            if (nativeStarted && module) terminalModules.add(module);
            fail(error); message.textContent = 'Unable to start the game.';
            if (online) throw error;
        }
    }
    start.addEventListener('click', () => launch());
    window.mk64StartOnline = launch;
})();
