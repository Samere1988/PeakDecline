/* Shared controller setup, selection and saved mappings for every Retro game. */
(() => {
    'use strict';
    const stores = new Map(), controllers = new Map();
    window.RetroControllers = {create(id, gamepads = window.mk64Gamepad, storageKey = 'mk64-gamepad-profiles-v1') {
        if (controllers.has(id)) return controllers.get(id);
        const controllerStatus = document.getElementById(id + '-controller-status');
        const controllerSelect = document.getElementById(id + '-controller-select');
        const controllerSetup = document.getElementById(id + '-controller-setup');
        const controllerStep = document.getElementById(id + '-controller-step');
        const controllerBack = document.getElementById(id + '-controller-back');
        const controllerTest = document.getElementById(id + '-controller-test');
        const controllerDeadzone = document.getElementById(id + '-controller-deadzone');
        const controllerDeadzoneValue = document.getElementById(id + '-controller-deadzone-value');
        const controllerLabel = document.getElementById(id + '-controller-label');
        const controllerCancel = document.getElementById(id + '-controller-cancel');
        const controllerReset = document.getElementById(id + '-controller-reset');
        const profiles = stores.get(storageKey) || new Map();
        stores.set(storageKey, profiles);
        try {
            const stored = JSON.parse(localStorage.getItem(storageKey) || '{}');
            if (stored && typeof stored === 'object' && !Array.isArray(stored))
                for (const [key, value] of Object.entries(stored)) profiles.set(key, value);
        } catch (_error) { /* Controller settings remain available for this session. */ }
        let selectedIndex = null;
        let selectedSignature = null;
        let setup = null;
        let deviceListKey = '';
        function availablePads() {
            try { return Array.from(navigator.getGamepads?.() || []).filter(pad => pad?.connected); }
            catch (_error) { return []; }
        }
        function selectedPad() {
            const pads = availablePads();
            const selected = pads.find(pad => pad.index === selectedIndex &&
                (!selectedSignature || gamepads.signature(pad) === selectedSignature));
            if (selected) return selected;
            if (selectedIndex !== null) return null;
            const active = pads.filter(pad => pad.buttons.some(button => button?.pressed || button?.value > 0.5) ||
                pad.axes.some(value => Math.abs(value) > 0.55));
            if (active.length !== 1) return null;
            selectedIndex = active[0].index;
            selectedSignature = gamepads.signature(active[0]);
            return active[0];
        }
        function profileFor(pad) {
            if (!pad || !gamepads) return null;
            const saved = gamepads.restoreProfile(profiles.get(gamepads.signature(pad)), pad, true);
            if (saved) return saved;
            return gamepads.isStandard(pad) && !gamepads.isN64(pad)
                ? gamepads.standardProfile() : null;
        }
        function saveProfile(pad, profile) {
            profiles.set(gamepads.signature(pad), profile);
            try { localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(profiles))); }
            catch (_error) { controllerStep.textContent = 'Controls work for this session, but this browser could not save them.'; }
        }
        function padName(pad) {
            if (/xinput/i.test(pad.id) && /xbox 360/i.test(pad.id)) return 'Xbox-compatible gamepad';
            return pad.id || 'Gamepad';
        }
        function refreshControllers() {
            if (!controllerStatus || !gamepads) return;
            const pads = availablePads();
            if (!pads.some(pad => pad.index === selectedIndex &&
                (!selectedSignature || gamepads.signature(pad) === selectedSignature))) {
                const reconnect = pads.length === 1
                    ? pads.find(pad => gamepads.signature(pad) === selectedSignature) : null;
                const replacement = reconnect || (pads.length === 1 ? pads[0] : null);
                selectedIndex = replacement?.index ?? null;
                if (replacement) selectedSignature = gamepads.signature(replacement);
                if (setup) cancelSetup();
            }
            const pad = selectedPad();
            if (pad) selectedSignature = gamepads.signature(pad);
            const nextListKey = pads.map(candidate => `${candidate.index}:${gamepads.signature(candidate)}`).join('\n');
            if (nextListKey !== deviceListKey) {
                deviceListKey = nextListKey;
                controllerSelect.replaceChildren(new Option('Select a controller', ''));
                pads.forEach(candidate => controllerSelect.add(new Option(
                    `${padName(candidate)} · ${candidate.mapping === 'standard' ? 'standard' : 'raw'} · #${candidate.index + 1}`,
                    String(candidate.index))));
            }
            if (controllerSelect.value !== (pad ? String(pad.index) : ''))
                controllerSelect.value = pad ? String(pad.index) : '';
            controllerSelect.hidden = pads.length < 2;
            controllerLabel.hidden = pads.length < 2;
            controllerSetup.hidden = !pad || !!setup;
            controllerDeadzone.disabled = !pad || !profileFor(pad);
            controllerReset.disabled = !pad || !profiles.has(gamepads.signature(pad));
            if (pad && !setup) controllerDeadzone.value = String(Math.round((profileFor(pad)?.deadzone ?? 0.18) * 100));
            controllerDeadzoneValue.textContent = `${controllerDeadzone.value}%`;
            const nextStatus = !('getGamepads' in navigator)
                ? 'This browser does not provide gamepad input. Keyboard controls are available.'
                : !pads.length ? 'Connect a controller, then press a button while this page is open.'
                    : !pad ? 'Multiple controllers found. Select the one for this player.'
                        : `${padName(pad)} connected. ${profileFor(pad) ? 'Controls ready.' : `Set up its ${gamepads.layoutName || "N64"} controls to play.`}`;
            if (controllerStatus.textContent !== nextStatus) controllerStatus.textContent = nextStatus;
            renderBindings();
            if (!setup) updateTest();
        }
        function updateTest() {
            if (!controllerTest || !gamepads || setup) return;
            const pad = selectedPad();
            const profile = profileFor(pad);
            if (!pad || !profile) { controllerTest.textContent = ''; return; }
            const state = gamepads.read(pad, profile);
            const pressed = gamepads.actions.filter(([, , bit]) => state.buttons & bit).map(([, label]) => label);
            controllerTest.textContent = `${gamepads.layoutName || "N64"} test: ${pressed.join(', ') || 'no buttons'} · stick ${state.x}, ${state.y}${state.lookX === undefined ? "" : ` · aim ${state.lookX}, ${state.lookY}`}`;
        }
        function cancelSetup() {
            if (!setup) return;
            clearInterval(setup.interval);
            setup = null;
            controllerCancel.hidden = true;
            controllerBack.hidden = true;
            controllerStep.textContent = 'Controller setup cancelled.';
        }
        function stepInstruction() {
            const step = gamepads.stepNames[setup.step];
            return step.key.startsWith('stick')
                ? `${step.label}, then let it return to center.`
                : `Press ${step.label} once.`;
        }
        function startStep(previousInput = null) {
            const pad = selectedPad();
            if (!pad || !setup) return cancelSetup();
            setup.phase = previousInput ? 'release' : 'settle';
            setup.stableSince = performance.now();
            setup.previous = gamepads.snapshot(pad);
            setup.baseline = null;
            setup.previousInput = previousInput;
            setup.pendingAxis = null;
            controllerBack.hidden = setup.single || setup.step === 0;
            controllerStep.textContent = previousInput
                ? `Detected ${gamepads.stepNames[setup.step - 1].label}. Release it for the next control.`
                : `Step ${setup.step + 1}/${gamepads.stepNames.length}: release the controller. ${stepInstruction()}`;
        }
        function choiceLabel(choice) {
            if (choice.type === 'button') return `Button ${choice.indices.join(' / ')}`;
            return `Axis ${choice.index + 1} ${choice.direction > 0 ? '+' : '−'}${choice.target === undefined ? '' : ` (${choice.target.toFixed(2)})`}`;
        }
        function chooseInput(choice) {
            if (!setup) return;
            const step = gamepads.stepNames[setup.step];
            if (choice.type === 'stick') {
                setup.profile[step.key] = {index: choice.index, direction: choice.direction, neutral: choice.neutral};
            } else {
                const duplicate = Object.entries(setup.profile.bindings).find(([key, binding]) => key !== step.key &&
                    binding.type === choice.type && binding.index === choice.index &&
                    binding.indices?.[0] === choice.indices?.[0] &&
                    binding.direction === choice.direction && binding.target === choice.target);
                if (duplicate) {
                    startStep(choice.type === 'button' ? choice : null);
                    controllerStep.textContent = `${choiceLabel(choice)} was already assigned to ${duplicate[0]}. Release it, then try ${step.label} again.`;
                    return;
                }
                setup.profile.bindings[step.key] = choice;
            }
            if (setup.single) {
                const pad = selectedPad(), finished = setup.profile;
                cancelSetup();
                saveProfile(pad, finished);
                controllerStep.textContent = `${step.label} saved. Select any control to change it.`;
                refreshControllers();
                return;
            }
            setup.step++;
            if (setup.step < gamepads.stepNames.length) {
                startStep(choice.type === 'button' ? choice : null);
                return;
            }
            const pad = selectedPad();
            if (!pad || !gamepads.complete(setup.profile)) return cancelSetup();
            const finished = setup.profile;
            clearInterval(setup.interval);
            setup = null;
            controllerCancel.hidden = true;
            controllerBack.hidden = true;
            saveProfile(pad, finished);
            controllerStep.textContent = `${gamepads.layoutName || "N64"} controls saved. Try every button and the joystick in the live test below.`;
            refreshControllers();
        }
        function captureTick() {
            if (!setup) return;
            const pad = selectedPad();
            if (!pad || pad.index !== setup.padIndex) return cancelSetup();
            const now = performance.now();
            const current = gamepads.snapshot(pad);
            if (setup.phase === 'release') {
                const previous = setup.previousInput;
                const released = previous.type === 'button'
                    ? (current.buttons[previous.indices[0]] || 0) < 0.2
                    : Math.abs((current.axes[previous.index] || 0) - previous.neutral) < 0.2;
                if (released) {
                    setup.phase = 'settle';
                    setup.stableSince = now;
                    controllerStep.textContent = `Step ${setup.step + 1}/${gamepads.stepNames.length}: ${stepInstruction()}`;
                }
            } else if (setup.phase === 'settle') {
                const moving = current.buttons.some((value, index) => Math.abs(value - (setup.previous.buttons[index] || 0)) > 0.1) ||
                    current.axes.some((value, index) => Math.abs(value - (setup.previous.axes[index] || 0)) > 0.08);
                if (moving) setup.stableSince = now;
                if (now - setup.stableSince >= 150) {
                    setup.phase = 'listen';
                    setup.baseline = current;
                    controllerStep.textContent = `Ready. ${stepInstruction()}`;
                }
            } else if (setup.phase === 'listen') {
                const key = gamepads.stepNames[setup.step].key;
                const choices = gamepads.candidates(pad, setup.baseline, key);
                const pressedButton = key.startsWith('stick') ? null : choices.find(choice => choice.type === 'button');
                if (pressedButton) chooseInput(pressedButton);
                else if (choices.some(choice => choice.type !== 'button')) {
                    setup.phase = 'axisGesture';
                    setup.pendingAxis = choices.filter(choice => choice.type !== 'button')
                        .sort((a, b) => Math.abs((current.axes[b.index] || 0) - b.neutral) -
                            Math.abs((current.axes[a.index] || 0) - a.neutral))[0];
                    controllerStep.textContent = 'Input detected. Release it to continue.';
                }
            } else if (setup.phase === 'axisGesture') {
                const choice = setup.pendingAxis;
                const value = current.axes[choice.index] || 0;
                if (Math.abs(value - choice.neutral) < 0.2) chooseInput(choice);
                else if (choice.target !== undefined && Math.abs(value - choice.neutral) > Math.abs(choice.target - choice.neutral))
                    choice.target = value;
            }
            if (setup) setup.previous = current;
        }
        function renderBindings() {
            const list = document.getElementById(id + '-controller-bindings');
            if (!list || !gamepads) return;
            const pad = selectedPad(), profile = setup?.profile || profileFor(pad);
            if (!list.children.length) for (const step of gamepads.stepNames) {
                const row = document.createElement('button');
                row.type = 'button'; row.dataset.control = step.key;
                row.addEventListener('click', () => startSetup(step.key));
                list.append(row);
            }
            for (const row of list.children) {
                const step = gamepads.stepNames.find(step => step.key === row.dataset.control);
                const binding = step.key.startsWith('stick') ? profile?.[step.key] : profile?.bindings[step.key];
                const listening = setup && gamepads.stepNames[setup.step].key === step.key;
                const label = `${step.label}: ${listening ? 'Listening…' : binding ? choiceLabel(binding) : 'Not mapped'}`;
                if (row.textContent !== label) row.textContent = label;
                row.disabled = !pad;
                row.setAttribute('aria-pressed', String(!!listening));
            }
        }
        function startSetup(key) {
            const pad = selectedPad();
            if (!pad || !gamepads) return;
            const draft = setup?.profile;
            cancelSetup();
            const single = typeof key === 'string';
            setup = {padIndex: pad.index, single, profile: single ? structuredClone(draft || profileFor(pad) || gamepads.emptyProfile()) : gamepads.emptyProfile(),
                step: single ? gamepads.stepNames.findIndex(step => step.key === key) : 0};
            controllerCancel.hidden = false;
            controllerSetup.hidden = true;
            startStep();
            setup.interval = setInterval(captureTick, 16);
            renderBindings();
        }
        if (gamepads && controllerStatus) {
            controllerSelect.addEventListener('change', () => {
                cancelSetup();
                selectedIndex = controllerSelect.value === '' ? null : Number(controllerSelect.value);
                selectedSignature = availablePads().find(pad => pad.index === selectedIndex);
                selectedSignature = selectedSignature ? gamepads.signature(selectedSignature) : null;
                refreshControllers();
            });
            controllerSetup.addEventListener('click', () => startSetup());
            document.getElementById(id + '-controller-panel')?.addEventListener('toggle', event => {
                if (!event.target.open) { cancelSetup(); refreshControllers(); }
            });
            controllerBack.addEventListener('click', () => {
                if (!setup || setup.step === 0) return;
                setup.step--;
                const key = gamepads.stepNames[setup.step].key;
                if (key.startsWith('stick')) setup.profile[key] = null;
                else delete setup.profile.bindings[key];
                startStep();
            });
            controllerCancel.addEventListener('click', () => { cancelSetup(); refreshControllers(); });
            controllerReset.addEventListener('click', () => {
                const pad = selectedPad();
                if (!pad) return;
                cancelSetup();
                profiles.delete(gamepads.signature(pad));
                try { localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(profiles))); }
                catch (_error) { /* The current session still resets. */ }
                controllerStep.textContent = 'Saved mapping removed.';
                refreshControllers();
            });
            controllerDeadzone.addEventListener('input', () => {
                const pad = selectedPad();
                const profile = profileFor(pad);
                if (!pad || !profile) return;
                profile.deadzone = Number(controllerDeadzone.value) / 100;
                controllerDeadzoneValue.textContent = `${controllerDeadzone.value}%`;
                saveProfile(pad, profile);
                updateTest();
            });
            window.addEventListener('gamepadconnected', refreshControllers);
            window.addEventListener('gamepaddisconnected', refreshControllers);
            setInterval(refreshControllers, 500);
            refreshControllers();
        }

        const api = {
            availablePads,
            cancel: cancelSetup,
            read() {
                if (document.hidden || setup) return {buttons: 0, x: 0, y: 0, lookX: 0, lookY: 0};
                const pad = selectedPad();
                return gamepads.read(pad, profileFor(pad));
            }
        };
        controllers.set(id, api);
        return api;
    }};
})();
