// Shared browser N64 touch input. Artwork is credited separately.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.N64Touch = api;
})(typeof window !== 'undefined' ? window : null, () => {
    'use strict';
    const bits = {a: 0x8000, b: 0x4000, z: 0x2000, start: 0x1000,
        l: 0x0020, r: 0x0010, cUp: 0x0008, cDown: 0x0004, cLeft: 0x0002, cRight: 0x0001};
    function isMobile(navigatorObject = navigator) {
        return navigatorObject.userAgentData?.mobile === true ||
            /Android|iPhone|iPad|iPod/i.test(navigatorObject.userAgent || '') ||
            (navigatorObject.platform === 'MacIntel' && navigatorObject.maxTouchPoints > 1);
    }
    function create({overlay, canLatchA = () => false, onInteract = () => {}}) {
        const active = isMobile();
        const pressed = new Map();
        const events = new AbortController();
        const listen = (target, type, fn) => target.addEventListener(type, fn, {signal: events.signal});
        const stick = overlay.querySelector('[data-n64-stick]');
        const knob = stick.querySelector('.mk64-touch-knob');
        const aButton = overlay.querySelector('.mk64-touch-a');
        let enabled = false, stickPointer = null, x = 0, y = 0, aLatched = false, aTimer = null;
        const clearTimer = () => { if (aTimer !== null) clearTimeout(aTimer); aTimer = null; };
        function setLatch(value) {
            aLatched = value;
            aButton.classList.toggle('is-latched', value);
            aButton.setAttribute('aria-label', value ? 'A acceleration locked; tap to release' : 'A accelerate button');
        }
        function reset() {
            clearTimer();
            pressed.clear();
            overlay.querySelectorAll('.is-pressed').forEach(button => button.classList.remove('is-pressed'));
            stickPointer = null;
            x = y = 0;
            knob.style.transform = '';
            setLatch(false);
        }
        function setEnabled(value) {
            const next = active && !!value;
            if (!next) reset();
            enabled = next;
            overlay.hidden = !next;
        }
        function updateStick(event) {
            const rect = stick.getBoundingClientRect();
            const radius = Math.min(rect.width, rect.height) * 0.36;
            const dx = (event.clientX - rect.left - rect.width / 2) / radius;
            const dy = (event.clientY - rect.top - rect.height / 2) / radius;
            const scale = Math.max(1, Math.hypot(dx, dy));
            const nx = dx / scale, ny = dy / scale;
            x = Math.round(nx * 80);
            y = Math.round(-ny * 80);
            const knobRadius = Math.min(stick.offsetWidth, stick.offsetHeight) * 0.36;
            knob.style.transform = `translate(${Math.round(nx * knobRadius * 0.48)}px, ${Math.round(ny * knobRadius * 0.48)}px)`;
        }
        listen(stick, 'pointerdown', event => {
            if (!enabled || stickPointer !== null) return;
            event.preventDefault();
            onInteract();
            stickPointer = event.pointerId;
            stick.setPointerCapture(event.pointerId);
            updateStick(event);
        });
        listen(stick, 'pointermove', event => {
            if (enabled && event.pointerId === stickPointer) updateStick(event);
        });
        function releaseStick(event) {
            if (event.pointerId !== stickPointer) return;
            stickPointer = null;
            x = y = 0;
            knob.style.transform = '';
        }
        for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) listen(stick, type, releaseStick);
        for (const button of overlay.querySelectorAll('[data-n64-button]')) {
            const bit = bits[button.dataset.n64Button];
            listen(button, 'pointerdown', event => {
                if (!enabled) return;
                event.preventDefault();
            onInteract();
                button.setPointerCapture(event.pointerId);
                if (button === aButton && aLatched) {
                    setLatch(false);
                    pressed.set(event.pointerId, 0);
                    return;
                }
                pressed.set(event.pointerId, bit);
                button.classList.add('is-pressed');
                if (button === aButton && canLatchA()) {
                    clearTimer();
                    aTimer = setTimeout(() => {
                        if (enabled && pressed.get(event.pointerId) === bits.a && canLatchA()) {
                            setLatch(true);
                            navigator.vibrate?.(20);
                        }
                        aTimer = null;
                    }, 650);
                }
            });
            function releaseButton(event) {
                if (!pressed.has(event.pointerId)) return;
                pressed.delete(event.pointerId);
                if (![...pressed.values()].includes(bit)) button.classList.remove('is-pressed');
                if (button === aButton) clearTimer();
            }
            for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) listen(button, type, releaseButton);
        }
        function read() {
            if (!enabled) return {buttons: 0, x: 0, y: 0};
            if (aLatched && !canLatchA()) setLatch(false);
            let buttons = aLatched ? bits.a : 0;
            for (const bit of pressed.values()) buttons |= bit;
            return {buttons, x, y};
        }
        listen(window, 'blur', reset);
        listen(window, 'resize', reset);
        listen(document, 'visibilitychange', () => { if (document.hidden) reset(); });
        setEnabled(false);
        return {mobile: active, read, reset, setEnabled, destroy() { setEnabled(false); events.abort(); }};
    }
    return {isMobile, create};
});
