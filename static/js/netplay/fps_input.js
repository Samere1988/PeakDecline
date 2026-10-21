/* Shared browser FPS input. Look values are angular units (32767 = 180 degrees)
 * per simulation tick; adapters convert to their engine's angle representation. */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root?.PeakNet) Object.assign(root.PeakNet, api);
})(typeof window !== 'undefined' ? window : null, () => {
    'use strict';
    const clamp = (x, n) => Math.max(-n, Math.min(n, x));
    const defaults = {
        fire: {bit: 1, mouse: 0, button: 7}, aim: {bit: 2, mouse: 2, button: 6},
        reload: {bit: 4, key: 'KeyR', button: 2}, use: {bit: 8, key: 'KeyE', button: 0},
        jump: {bit: 16, key: 'Space', button: 1}, crouch: {bit: 32, key: 'ControlLeft', button: 3},
        nextWeapon: {bit: 64, key: 'KeyQ', button: 5}
    };
    class FpsInput {
        constructor({element, tickRate = 60, sensitivity = 0.12, stickDegreesPerSecond = 180,
            deadzone = 0.18, invertY = false, actions = defaults,
            movement = {left: 'KeyA', right: 'KeyD', forward: 'KeyW', back: 'KeyS'},
            axes = {moveX: 0, moveY: 1, lookX: 2, lookY: 3}, gamepadIndex = 0,
            controllerInput = null, getGamepads = () => navigator.getGamepads(), document: doc = element.ownerDocument}) {
            if (!(tickRate >= 10 && tickRate <= 120) || !(deadzone >= 0 && deadzone < 1) ||
                !(sensitivity > 0 && sensitivity <= 10) || !(stickDegreesPerSecond > 0 && stickDegreesPerSecond <= 1440))
                throw new Error('Invalid FPS input settings.');
            const bits = new Set();
            for (const binding of Object.values(actions)) {
                if (!Number.isInteger(binding.bit) || binding.bit < 1 || binding.bit > 32768 ||
                    (binding.bit & (binding.bit - 1)) || bits.has(binding.bit)) throw new Error('Actions require unique 16-bit flags.');
                bits.add(binding.bit);
            }
            Object.assign(this, {element, doc, tickRate, sensitivity, stickDegreesPerSecond,
                deadzone, invertY, actions: structuredClone(actions), movement, axes, gamepadIndex, getGamepads, controllerInput});
            this.keys = new Set(); this.mouse = new Set(); this.dx = 0; this.dy = 0; this.listeners = [];
            const listen = (target, type, fn) => { target.addEventListener(type, fn); this.listeners.push(() => target.removeEventListener(type, fn)); };
            const active = () => doc.pointerLockElement === element;
            listen(element, 'click', () => { if (!active()) this.capture(); });
            listen(doc, 'pointerlockchange', () => this.reset());
            listen(doc.defaultView, 'blur', () => this.reset());
            listen(doc, 'visibilitychange', () => this.reset());
            listen(doc, 'keydown', event => {
                if (!active() || event.target?.closest?.('input,textarea,select,[contenteditable=true]')) return;
                if (Object.values(this.movement).includes(event.code) || Object.values(this.actions).some(a => a.key === event.code)) {
                    event.preventDefault(); this.keys.add(event.code);
                }
            });
            listen(doc, 'keyup', event => this.keys.delete(event.code));
            listen(doc, 'mousemove', event => { if (active()) { this.dx += event.movementX || 0; this.dy += event.movementY || 0; } });
            listen(doc, 'mousedown', event => { if (active()) this.mouse.add(event.button); });
            listen(doc, 'mouseup', event => this.mouse.delete(event.button));
            listen(element, 'contextmenu', event => { if (active()) event.preventDefault(); });
        }
        capture() { try { this.element.requestPointerLock()?.catch?.(() => {}); } catch (_) { /* User can click to retry. */ } }
        reset() { this.keys.clear(); this.mouse.clear(); this.dx = 0; this.dy = 0; }
        sampleInput() {
            if (this.doc.hidden || !this.doc.hasFocus()) { this.reset(); return {buttons: 0, moveX: 0, moveY: 0, lookX: 0, lookY: 0}; }
            const mapped = this.controllerInput?.();
            const pad = this.controllerInput ? null : this.getGamepads()?.[this.gamepadIndex];
            const axis = name => {
                if (mapped) return clamp(mapped[name] || 0, 1);
                const raw = pad?.axes?.[this.axes[name]];
                const v = Number.isFinite(raw) ? clamp(raw, 1) : 0;
                return Math.abs(v) <= this.deadzone ? 0 : Math.sign(v) * (Math.abs(v) - this.deadzone) / (1 - this.deadzone);
            };
            let buttons = mapped?.buttons || 0;
            for (const a of Object.values(this.actions))
                if (this.keys.has(a.key) || this.mouse.has(a.mouse) || pad?.buttons?.[a.button]?.pressed) buttons |= a.bit;
            const m = this.movement;
            const moveX = clamp(axis('moveX') + Number(this.keys.has(m.right)) - Number(this.keys.has(m.left)), 1);
            const moveY = clamp(-axis('moveY') + Number(this.keys.has(m.forward)) - Number(this.keys.has(m.back)), 1);
            const length = Math.max(1, Math.hypot(moveX, moveY));
            const lookX = this.dx * this.sensitivity + axis('lookX') * this.stickDegreesPerSecond / this.tickRate;
            const lookY = (this.dy * this.sensitivity + axis('lookY') * this.stickDegreesPerSecond / this.tickRate) * (this.invertY ? -1 : 1);
            this.dx = 0; this.dy = 0;
            return {buttons, moveX: Math.round(moveX / length * 127), moveY: Math.round(moveY / length * 127),
                lookX: Math.round(clamp(lookX / 180 * 32767, 32767)), lookY: Math.round(clamp(lookY / 180 * 32767, 32767))};
        }
        destroy() {
            this.listeners.forEach(remove => remove()); this.listeners = []; this.reset();
            if (this.doc.pointerLockElement === this.element) this.doc.exitPointerLock();
        }
    }
    return {FpsInput, fpsDefaultActions: defaults};
});
