/* Reusable isolated browser runtime host. A game supplies a frame page and
 * the ready/pads/completed/loaded hooks; lobby and synchronization stay shared. */
(() => {
    'use strict';
    PeakNet.registerFrameGame = ({id, title, elementId, lobbyController = false}) => {
        const area = document.getElementById(elementId);
        const lobbyControls = lobbyController ? area.querySelector('[data-lobby-controller]') : null;
        const controllerInput = window.RetroControllers.create(id);
        let frame, bridge, keys, touch, removeInput, cancelLoad, rollbackAdapter, inputBuffer;
        const volume = area.querySelector('[data-game-volume]');
        const volumeValue = area.querySelector('[data-game-volume-value]');
        const volumeKey = `${id}-volume`;
        let volumeLevel = 1;
        try {
            const stored = localStorage.getItem(volumeKey);
            if (stored !== null && Number.isFinite(Number(stored))) volumeLevel = Math.max(0, Math.min(1, Number(stored)));
        } catch {}
        if (volume) {
            volume.value = String(Math.round(volumeLevel * 100));
            volumeValue.textContent = `${volume.value}%`;
            volume.addEventListener('input', () => {
                volumeLevel = Number(volume.value) / 100;
                volumeValue.textContent = `${volume.value}%`;
                frame?.contentWindow.setPeakGameVolume?.(volumeLevel);
                resumeAudio();
                try { localStorage.setItem(volumeKey, String(volumeLevel)); } catch {}
            });
        }
        const fullscreen = window.GameFullscreen.create({
            area: area.querySelector('.retro-frame-shell'),
            button: area.querySelector('[data-game-fullscreen]'),
            status: area.querySelector('[data-fullscreen-status]'),
            focusGame: () => frame?.contentDocument?.querySelector('canvas')?.focus()
        });
        const bits = {KeyX: 0x8000, KeyC: 0x4000, KeyZ: 0x2000, Enter: 0x1000,
            KeyA: 0x0020, KeyS: 0x0010, KeyI: 8, KeyK: 4, KeyJ: 2, KeyL: 1};
        const resumeAudio = () => frame?.contentWindow.resumePeakGameAudio?.();
        function liveInput() {
            let buttons = 0;
            const pressed = keys;
            for (const key of pressed) buttons |= bits[key] || 0;
            let x = (pressed.has('ArrowRight') - pressed.has('ArrowLeft')) * 80;
            let y = (pressed.has('ArrowUp') - pressed.has('ArrowDown')) * 80;
            const mapped = controllerInput.read();
            buttons |= mapped.buttons;
            if (Math.abs(mapped.x) > Math.abs(x)) x = mapped.x;
            if (Math.abs(mapped.y) > Math.abs(y)) y = mapped.y;
            const input = touch?.read() || {buttons: 0, x: 0, y: 0};
            buttons |= input.buttons;
            if (Math.abs(input.x) > Math.abs(x)) x = input.x;
            if (Math.abs(input.y) > Math.abs(y)) y = input.y;
            return {buttons, x, y};
        }
        function sample() {
            const pad = liveInput();
            return inputBuffer ? inputBuffer.take(pad) : pad;
        }
        function stop() {
            let failure;
            const clean = action => { try { action(); } catch (error) { failure ??= error; } };
            clean(() => controllerInput.cancel());
            clean(() => cancelLoad?.()); cancelLoad = null;
            clean(() => removeInput?.()); removeInput = null;
            clean(() => touch?.destroy()); touch = null;
            inputBuffer = null;
            clean(() => rollbackAdapter?.destroy()); rollbackAdapter = null;
            area.querySelector('.retro-frame-shell').classList.remove('mk64-touch-layout');
            bridge = null;
            const ending=frame; frame=null;
            // Defer invocation too: peakShutdown itself can throw synchronously.
            const saving = Promise.resolve().then(() => ending?.contentWindow?.peakShutdown?.())
                .finally(() => ending?.remove()).then(() => { if (failure) throw failure; });
            area.hidden = true;
            return saving;
        }
        PeakNet.adapters.set(id, {
            spectatorSurface: () => frame?.contentDocument?.querySelector('canvas'),
            spectatorAudioSource: () => frame?.contentWindow.peakSpectatorAudioSource?.(),
            lobby: lobbyControls ? ({role}) => {
                const destination = document.getElementById('retro-controller-setup');
                destination?.replaceChildren(lobbyControls);
                lobbyControls.hidden = role === 'spectator';
            } : undefined,
            present({name, spectator, requestRestart}) {
                area.querySelector('[data-game-title]').textContent = `${name} · ${spectator ? 'Spectating' : title}`;
                area.querySelector('[data-game-restart]').onclick = requestRestart;
            },
            hostChanged(isHost) { area.querySelector('[data-game-restart]').hidden = !isHost; },
            async launch({session, canRestart, initialSave, slot, settings = {}}) {
                await stop();
                if (lobbyControls) { area.append(lobbyControls); lobbyControls.hidden = session.spectator; }
                area.hidden = false;
                const result = area.querySelector('[data-game-result]');
                if (result) result.hidden = true;
                area.querySelector('[data-game-restart]').hidden = !canRestart;
                keys = new Set();
                inputBuffer = id === 'smash64' && session.game.backend === 'rollback-v1' ?
                    new PeakNet.RollbackInputBuffer() : null;
                touch = window.N64Touch.create({overlay: area.querySelector('.n64-touch-controls'), onInteract: resumeAudio});
                touch.setEnabled(!session.spectator);
                area.querySelector('.retro-frame-shell').classList.toggle('mk64-touch-layout', touch.mobile && !session.spectator);
                const hashes = new Map();
                const controller = new AbortController();
                const retainInput = (buttonsOnly = false) => {
                    if (inputBuffer && session.running && !session.spectator &&
                        (session.engine?.lastStallReason || inputBuffer.pending.length || inputBuffer.overflowed)) {
                        const pad = liveInput();
                        if (buttonsOnly !== true || pad.buttons !== inputBuffer.observed.buttons) inputBuffer.record(pad);
                    }
                };
                // These bubble after the touch control has updated its state.
                // Do not queue every analog motion: retain press/release edges
                // and the stick position at that event, without growing a debt
                // of old pointermove samples after a stall.
                const touchOverlay = area.querySelector('.n64-touch-controls');
                for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'lostpointercapture'])
                    touchOverlay.addEventListener(type, retainInput, {signal: controller.signal});
                const listen = target => {
                    const handle = down => event => {
                        if (!(event.code in bits) && !event.code.startsWith('Arrow')) return;
                        if (/^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName)) return;
                        event.preventDefault();
                        if (down) resumeAudio();
                        if (down) keys.add(event.code); else keys.delete(event.code);
                        retainInput();
                    };
                    target.addEventListener('keydown', handle(true), {signal: controller.signal});
                    target.addEventListener('keyup', handle(false), {signal: controller.signal});
                    target.addEventListener('blur', () => { keys.clear(); touch?.reset(); inputBuffer?.reset(); }, {signal: controller.signal});
                };
                listen(window);
                removeInput = () => controller.abort();
                await new Promise((resolve, reject) => {
                    const timer = setTimeout(() => reject(new Error(`${title} took too long to load.`)), 120000);
                    let loaded = false;
                    const finish = error => {
                        if (loaded) return;
                        loaded = true; clearTimeout(timer); cancelLoad = null;
                        if (error) reject(error); else resolve();
                    };
                    cancelLoad = () => finish(new Error('Game launch cancelled.'));
                    bridge = {
                        players: session.players,
                        restoreSave: !!session.rebuilding,
                        initialSave, saveOwner:!session.spectator && slot===0,
                        settings,
                        // Authoritative games own their fixed-step/render hooks
                        // and supply FPS input (including mouse/second-stick aim).
                        advance: () => session.advance(),
                        render: () => session.render?.(),
                        begin() {
                            // Gamepads have no button events. Native stalled
                            // attempts poll their edges without queueing stick
                            // motion or adding a delay to ordinary live input.
                            retainInput(true);
                            const next = session.beginAdvance();
                            if (!next) return false;
                            rollbackAdapter.queueFrame(next);
                            return true;
                        },
                        complete() {
                            const advanced = session.completeAdvance();
                            if (result && rollbackAdapter?.isFinished && session.engine.confirmed >= session.frame - 1)
                                result.hidden = !rollbackAdapter.isFinished();
                            return advanced;
                        },
                        replaying: () => !!session.rebuilding,
                        ready: number => session.frameReady(number) === 1,
                        pads: number => session.getFrame(number),
                        completed(number, hash) {
                            hashes.set(number, hash);
                            hashes.delete(number - 120);
                        },
                        loaded(createRollbackAdapter) {
                            if (session.game.backend === 'authoritative-host-v1') {
                                if (typeof createRollbackAdapter !== 'function') throw new Error('Missing FPS runtime adapter.');
                                session.bind(createRollbackAdapter({slot: session.slot, players: session.players,
                                    spectator: session.spectator, isAuthority: session.isAuthority}));
                            } else if (session.game.backend === 'rollback-v1') {
                                if (typeof createRollbackAdapter !== 'function') throw new Error('Missing rollback runtime adapter.');
                                rollbackAdapter = createRollbackAdapter({sampleInput: sample, maxPrediction: session.maxPrediction});
                                session.bind(rollbackAdapter);
                            } else session.bind({sampleInput: sample, hashForFrame: number => {
                                if (!hashes.has(number)) throw new Error('Missing game state checksum.');
                                return hashes.get(number);
                            }});
                            finish();
                        },
                        failed(message) {
                            const error = new Error(message || `${title} stopped unexpectedly.`);
                            if (loaded) session.fail(error.message); else finish(error);
                        }
                    };
                    frame = document.createElement('iframe');
                    const launchedFrame = frame;
                    frame.title = title;
                    frame.allow = 'gamepad; autoplay; fullscreen';
                    frame.src = area.dataset.runtimeUrl;
                    frame.addEventListener('load', () => {
                        if (frame !== launchedFrame || session.failed) return;
                        listen(frame.contentWindow);
                        fullscreen.bindSurface(frame.contentDocument, controller.signal);
                        frame.contentWindow.peakGameBridge = bridge;
                        frame.contentWindow.setPeakGameVolume?.(volumeLevel);
                        frame.contentWindow.startPeakGame?.();
                    }, {once: true});
                    area.querySelector('[data-game-frame]').replaceChildren(frame);
                });
            },
            stop
        });
    };
})();
