/* Controlled real Perfect Dark engine: two separate WASM instances. */
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
(async () => {
    const browser = await chromium.launch({headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? {executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH} : {})});
    const errors = [];
    try {
        const pages = [];
        for (let i = 0; i < 2; i++) {
            const page = await browser.newPage(); pages.push(page);
            page.on('pageerror', error => errors.push(error.message));
            await page.addInitScript(() => { window.peakPdLaunchOptions = {controlled: true, players: 2, seed: 12345}; });
            await page.request.get('http://127.0.0.1:8066/test-login/pd-controlled-' + i);
            await page.goto('http://127.0.0.1:8066/games/retro/preview/perfectdark');
            await page.locator('#start').click();
            await page.waitForFunction(() => window.peakPdError || window.peakPdEngine, null, {timeout: 60000});
            assert.equal(await page.evaluate(() => window.peakPdError || null), null);
            assert.equal(await page.evaluate(() => peakPdEngine.observe().tick), 0);
            assert.equal(await page.evaluate(() => peakPdEngine.observe().stage), 0x5a);
            assert.equal(await page.evaluate(() => peakPdEngine.present()), false, 'No completed frame exists before the first tick.');
        }
        await pages[0].waitForTimeout(100);
        assert.equal(await pages[0].evaluate(() => peakPdEngine.observe().tick), 0, 'No uncontrolled game loop.');
        const advance = (page, count, buttons = 0, moveY = 0, lookX = 0) => page.evaluate(({count, buttons, moveY, lookX}) => {
            let state;
            for (let i = 0; i < count; i++) state = peakPdEngine.step([{buttons, moveX: 0, moveY, lookX, lookY: 0}, {buttons: 0, moveX: 0, moveY: 0, lookX: 0, lookY: 0}]);
            return state;
        }, {count, buttons, moveY, lookX});
        const one = await advance(pages[0], 1);
        assert.equal(one.tick, 1); assert.equal(one.delta240, 4);
        assert.equal(await pages[1].evaluate(() => peakPdEngine.observe().tick), 0, 'Authority and client cannot share a heap.');
        await advance(pages[1], 1);
        for (let batch = 0; batch < 30; batch++) {
            const buttons = [5, 10, 15, 20, 25].includes(batch) ? 128 : 0;
            const a = await advance(pages[0], 20, buttons);
            const b = await advance(pages[1], 20, buttons);
            assert.deepEqual(a, b, `Independent engine state diverged at batch ${batch}`);
        }
        const state = await pages[0].evaluate(() => peakPdEngine.observe());
        console.log('After controlled startup', JSON.stringify(state));
        // Commands are transactional and one-shot; no missing row can replay fire.
        assert.equal(await pages[0].evaluate(() => Module._peakPdStep()), 0);
        const before = await pages[0].evaluate(() => peakPdEngine.observe().tick);
        const rejected = await pages[0].evaluate(() => {
            try { peakPdEngine.step([{buttons: 0, moveX: 128, moveY: 0, lookX: 0, lookY: 0}]); return false; }
            catch { return true; }
        });
        assert.equal(rejected, true);
        assert.equal(await pages[0].evaluate(() => peakPdEngine.observe().tick), before);
        await pages[0].locator('#canvas').screenshot({path: '.tmp/perfectdark/controlled.png'});
        // Enter Combat Simulator through the original match-start routine.
        for (const page of pages) {
            await page.evaluate(() => peakPdEngine.startCombat(37));
            await advance(page, 120);
        }
        const startState = await pages[0].evaluate(() => peakPdEngine.observe());
        console.log('Arena initial', JSON.stringify(startState));
        const movedA = await advance(pages[0], 60, 0, 100, 128);
        const movedB = await advance(pages[1], 60, 0, 100, 128);
        assert.deepEqual(movedA, movedB);
        assert.equal(movedA.players[0].dead, false);
        assert.equal(movedA.players[1].dead, false);
        assert.equal(movedA.players[1].yaw, startState.players[1].yaw, 'Aim must not leak into the other seat.');
        assert.notDeepEqual(movedA.players[0].position, startState.players[0].position, 'Movement must reach real game physics.');
        assert.notEqual(movedA.players[0].yaw, startState.players[0].yaw, 'Angular input must reach real aiming.');
        console.log('Arena after movement/aim', JSON.stringify(movedA));
        // Local keyboard state must never bypass externally supplied commands.
        await pages[0].keyboard.down('w');
        const neutralA = await advance(pages[0], 30), neutralB = await advance(pages[1], 30);
        await pages[0].keyboard.up('w');
        assert.deepEqual(neutralA, neutralB);
        assert.equal(await pages[0].evaluate(() => Module._peakPdStartCombat(90)), 0, 'Only multiplayer arenas may be selected.');
        await pages[0].locator('#canvas').screenshot({path: '.tmp/perfectdark/controlled-arena.png'});
        const seatStates = [];
        for (const page of pages) {
            await page.bringToFront();
            seatStates.push(await page.evaluate(() => {
                const collector = new PeakNet.FpsInput({element: document.getElementById('canvas'),
                    actions: PeakNet.perfectDarkActions,
                    getGamepads: () => [{axes: [1, 0, 0.5, 0], buttons: []}]});
                const command = collector.sampleInput(); collector.destroy();
                let state;
                for (let i = 0; i < 20; i++) state = peakPdEngine.step([
                    {buttons: 0, moveX: 0, moveY: 0, lookX: 0, lookY: 0}, command]);
                return {command, state};
            }));
        }
        assert.deepEqual(seatStates[0], seatStates[1]);
        assert.equal(seatStates[0].command.moveX, 127);
        assert.notEqual(seatStates[0].state.players[1].yaw, neutralA.players[1].yaw);
        assert.equal(seatStates[0].state.players[0].yaw, neutralA.players[0].yaw);
        assert.deepEqual(await pages[0].evaluate(() => peakPdEngine.captureComponents()),
            await pages[1].evaluate(() => peakPdEngine.captureComponents()),
            'Player, hand and prop components must match across independent heaps.');
        const redraw = await pages[0].evaluate(() => {
            const before = peakPdEngine.captureComponents(), tick = peakPdEngine.observe().tick;
            const eventCount = Module._peakPdEventCount();
            for (let i = 0; i < 120; i++) if (!peakPdEngine.present()) throw new Error('Completed frame was not available.');
            return {before, after: peakPdEngine.captureComponents(), tick, afterTick: peakPdEngine.observe().tick,
                eventCount, afterEvents: Module._peakPdEventCount()};
        });
        assert.deepEqual(redraw.before, redraw.after);
        assert.equal(redraw.tick, redraw.afterTick); assert.equal(redraw.eventCount, redraw.afterEvents);
        assert.deepEqual(await advance(pages[0], 1), await advance(pages[1], 1),
            'Extra display refreshes must not change the next simulation step.');
        assert.deepEqual(await pages[0].evaluate(() => peakPdEngine.captureComponents()),
            await pages[1].evaluate(() => peakPdEngine.captureComponents()));
        // Exercise the shared authority driver against actual engine steps.
        // observe() is a test diagnostic only, NOT a usable world snapshot codec.
        await pages[0].evaluate(() => { PeakNet.backends = new Map(); });
        await pages[0].addScriptTag({url: 'http://127.0.0.1:8066/static/js/netplay/authoritative.js'});
        const driven = await pages[0].evaluate(() => {
            const before = peakPdEngine.observe().tick;
            const driver = new PeakNet.AuthoritativeHost({players: 2, tickRate: 60,
                adapter: {step: commands => peakPdEngine.step(commands), captureState: () => peakPdEngine.observe()}});
            for (let slot = 0; slot < 2; slot++) driver.receive(slot, {seq: 1, viewTick: 0,
                command: {buttons: 0, moveX: 0, moveY: 0, lookX: 0, lookY: 0}});
            const snapshot = driver.advance();
            return {before, after: snapshot.state.tick, acknowledgements: snapshot.acks, tick: snapshot.tick};
        });
        assert.equal(driven.after, driven.before + 1);
        assert.deepEqual(driven.acknowledgements, [1, 1]); assert.equal(driven.tick, 1);
        // Real prop components exercise the existing delta codec. This is not
        // a world restore test: weapons, AI and movement internals are pending.
        const replication = await pages[0].evaluate(() => {
            const encoder = new PeakNet.SnapshotCodec(), decoder = new PeakNet.SnapshotCodec();
            const neutral = {buttons: 0, moveX: 0, moveY: 0, lookX: 0, lookY: 0};
            let bytes = 0, fullBytes = 0, fullPackets = 0, deltas = 0, peakEntities = 0;
            const triggerValues = new Set(), handStates = new Set();
            const check = tick => {
                const state = peakPdEngine.captureComponents();
                const [firstId, secondId] = state.meta.players;
                const hand = state[`hand:${state.meta.epoch}:${firstId}:0`];
                if (hand) { triggerValues.add(hand.trigger); handStates.add(hand.state); }
                const otherHand = state[`hand:${state.meta.epoch}:${secondId}:0`];
                if (otherHand?.trigger) throw new Error('Fire command leaked into the other player.');
                const snapshot = {tick, acks: [tick, tick], state};
                const packet = encoder.encode(snapshot);
                const reconstructed = decoder.decode(packet).state;
                // Object insertion order can differ after entity changes.
                const keys = Object.keys(state).sort();
                if (JSON.stringify(keys) !== JSON.stringify(Object.keys(reconstructed).sort()) ||
                    keys.some(key => JSON.stringify(state[key]) !== JSON.stringify(reconstructed[key])))
                    throw new Error('Real entity delta round trip failed.');
                bytes += JSON.stringify(packet).length; fullBytes += JSON.stringify(snapshot).length;
                if (packet.state) fullPackets++; else deltas++;
                peakEntities = Math.max(peakEntities, keys.length - 1);
                return state;
            };
            const initial = check(0);
            if (!initial.meta.players.every(id => id && initial[`prop:${initial.meta.epoch}:${id}`]))
                throw new Error('Player entity references missing.');
            for (let tick = 1; tick <= 120; tick++) {
                peakPdEngine.step([{...neutral, moveY: 100, lookX: 128, buttons: tick % 15 === 0 ? 1 : 0}, neutral]);
                check(tick);
            }
            const previous = peakPdEngine.captureEntities();
            peakPdEngine.startCombat(37); // Same arena, new epoch.
            for (let tick = 121; tick <= 140; tick++) { peakPdEngine.step([neutral, neutral]); check(tick); }
            const restarted = peakPdEngine.captureEntities();
            if (restarted.meta.epoch <= previous.meta.epoch ||
                Object.keys(restarted).some(key => key !== 'meta' && Object.hasOwn(previous, key)))
                throw new Error('Arena restart retained stale entity identities.');
            return {bytes, fullBytes, fullPackets, deltas, peakEntities,
                triggerValues: [...triggerValues], handStates: [...handStates],
                previousEpoch: previous.meta.epoch, restartedEpoch: restarted.meta.epoch};
        });
        assert.ok(replication.peakEntities > 2);
        assert.ok(replication.deltas > 0);
        assert.ok(replication.bytes < replication.fullBytes);
        assert.ok(replication.triggerValues.includes(0) && replication.triggerValues.includes(1));
        assert.ok(replication.handStates.length > 1, 'Real attack state must change.');
        console.log('Real player/weapon/prop delta measurements', JSON.stringify(replication));
        assert.deepEqual(errors, []);
        console.log('Controlled ticks, fixed timing, independent heaps, identical input traces and input rejection passed.');
    } finally { await browser.close(); }
})().catch(error => {console.error(error); process.exitCode = 1;});
