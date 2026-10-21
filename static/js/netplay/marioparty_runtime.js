/* Native Mario Party host loop. The shared room supplies every controller frame. */
(() => {
    'use strict';
    window.startMarioPartyRuntime = (module, bridge, options = {}) => {
        const players = bridge.players;
        if (!Number.isInteger(players) || players < 1 || players > 4) throw new Error('Invalid Mario Party player count.');
        let frame = 1, stopped = false, request = 0, due;
        const schedule = options.requestFrame || requestAnimationFrame;
        const cancel = options.cancelFrame || cancelAnimationFrame;
        const fail = error => {
            if (stopped) return;
            stopped = true;
            cancel(request);
            bridge.failed(error?.message || String(error));
        };
        module._mp_prepare();
        for (let slot = 0; slot < 4; slot++) module._mp_pad(slot, 0, 0, 0, slot < players ? 1 : 0);
        module._mp_boot();
        bridge.loaded();
        const advance = now => {
            if (stopped) return;
            try {
                if (due === undefined) due = now;
                // Bound catch-up work after a hidden tab resumes.
                due = Math.max(due, now - 3 * 1000 / 60);
                let count = 0;
                const replaying = bridge.replaying?.() === true;
                const began = performance.now();
                const previousPresentation = module.skipPresentation;
                if (replaying) module.skipPresentation = true;
                // Rebuild in short batches without monopolizing the browser UI.
                while ((replaying || now >= due) && count++ < (replaying ? 120 : 4)) {
                    if (replaying && performance.now() - began > 12) break;
                    if (!bridge.ready(frame)) { due = now; break; }
                    const pads = bridge.pads(frame);
                    if (!Array.isArray(pads) || pads.length !== players) throw new Error('Invalid Mario Party controller frame.');
                    pads.forEach((pad, slot) => {
                        if (!pad || !Number.isInteger(pad.buttons) || pad.buttons < 0 || pad.buttons > 65535 ||
                            !Number.isInteger(pad.x) || !Number.isInteger(pad.y) || Math.abs(pad.x) > 80 || Math.abs(pad.y) > 80)
                            throw new Error('Invalid Mario Party controller input.');
                        module._mp_pad(slot, pad.buttons, pad.x, pad.y, 1);
                    });
                    module._mp_tick();
                    // The shared lockstep session requests the preceding frame at each second.
                    bridge.completed(frame, frame % 60 === 59 ? module._mp_hash() >>> 0 : 0);
                    frame++;
                    due = replaying ? now : due + 1000 / 60;
                }
                module.skipPresentation = previousPresentation;
                request = schedule(advance);
            } catch (error) { fail(error); }
        };
        request = schedule(advance);
        const stop = () => { stopped = true; cancel(request); };
        return {stop, get frame() { return frame; }};
    };
})();
