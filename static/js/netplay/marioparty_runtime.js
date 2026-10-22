/* Native Mario Party host loop. The shared room supplies every controller frame. */
(() => {
    'use strict';
    window.startMarioPartyRuntime = (module, bridge, options = {}) => {
        const players = bridge.players;
        if (!Number.isInteger(players) || players < 1 || players > 4) throw new Error('Invalid Mario Party player count.');
        let frame = 1, stopped = false, request = 0, retryTimer = 0, due;
        const schedule = options.requestFrame || requestAnimationFrame;
        const cancel = options.cancelFrame || cancelAnimationFrame;
        // A row that arrives just after a display frame should not wait for the next one.
        const retry = options.retryFrame || (fn => setTimeout(() => fn(performance.now()), 4));
        const cancelRetry = options.cancelRetry || clearTimeout;
        const fail = error => {
            if (stopped) return;
            stopped = true;
            cancel(request); cancelRetry(retryTimer);
            bridge.failed(error?.message || String(error));
        };
        module._mp_prepare();
        for (let slot = 0; slot < 4; slot++) module._mp_pad(slot, 0, 0, 0, slot < players ? 1 : 0);
        module._mp_boot();
        bridge.loaded();
        // Runs every frame that is due and ready; returns true while a due frame awaits its row.
        const pump = now => {
            if (due === undefined) due = now;
            // Bound catch-up work after a hidden tab resumes or a long stall.
            due = Math.max(due, now - 3 * 1000 / 60);
            let count = 0, waiting = false;
            const replaying = bridge.replaying?.() === true;
            const began = performance.now();
            const previousPresentation = module.skipPresentation;
            if (replaying) module.skipPresentation = true;
            // Rebuild in short batches without monopolizing the browser UI.
            while ((replaying || now >= due) && count++ < (replaying ? 120 : 4)) {
                if (replaying && performance.now() - began > 12) break;
                // Keep the schedule while waiting, so a late row's time is made up afterwards.
                if (!bridge.ready(frame)) { if (replaying) due = now; else waiting = true; break; }
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
            return waiting;
        };
        // The retry timer only re-polls; the display loop below stays a single chain.
        const poll = now => {
            if (stopped) return;
            try { if (pump(now)) retryTimer = retry(poll); else retryTimer = 0; } catch (error) { fail(error); }
        };
        const advance = now => {
            if (stopped) return;
            try {
                cancelRetry(retryTimer);
                retryTimer = pump(now) ? retry(poll) : 0;
                request = schedule(advance);
            } catch (error) { fail(error); }
        };
        request = schedule(advance);
        const stop = () => { stopped = true; cancel(request); cancelRetry(retryTimer); };
        return {stop, get frame() { return frame; }};
    };
})();
