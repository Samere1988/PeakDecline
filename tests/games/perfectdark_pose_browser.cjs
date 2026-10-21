/* Typed pose restoration, not a complete replica/prediction acceptance test. */
const assert = require('node:assert/strict');
const {chromium} = require('C:/Users/Plex/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
(async () => {
    const browser = await chromium.launch({headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
    const errors = [], pages = [];
    try {
        for (let i = 0; i < 2; i++) {
            const page = await browser.newPage(); pages.push(page);
            page.on('pageerror', error => errors.push(error.message));
            await page.addInitScript(() => {window.peakPdLaunchOptions = {controlled: true, players: 2, seed: 12345};});
            await page.request.get('http://127.0.0.1:8066/test-login/pose-' + i);
            await page.goto('http://127.0.0.1:8066/games/retro/preview/perfectdark');
            await page.locator('#start').click();
            await page.waitForFunction(() => window.peakPdEngine || window.peakPdError, null, {timeout: 60000});
            assert.equal(await page.evaluate(() => window.peakPdError || null), null);
            await page.evaluate(() => {
                window.neutralPoseInput = {buttons: 0, moveX: 0, moveY: 0, lookX: 0, lookY: 0};
                const n = neutralPoseInput;
                for (let tick = 0; tick < 601; tick++) peakPdEngine.step([{...n, buttons: tick % 100 === 0 ? 128 : 0}, n]);
                peakPdEngine.startCombat(37, [1, 1, 1, 1, 1, 1]);
                for (let tick = 0; tick < 120; tick++) peakPdEngine.step([n, n]);
                peakPdEngine.drainEvents();
            });
        }
        const poses = await pages[0].evaluate(() => peakPdEngine.capturePlayerPoses());
        // An idempotent restore must preserve future simulation AND graphics.
        const walking = await pages[0].evaluate(() => peakPdEngine.captureWalkingState());
        await pages[1].evaluate(snapshot => peakPdEngine.restoreWalkingState(snapshot), walking);
        const inventory = await pages[0].evaluate(() => peakPdEngine.captureInventoryState());
        await pages[1].evaluate(snapshot => peakPdEngine.restoreInventoryState(snapshot), inventory);
        const states = [];
        for (const page of pages) states.push(await page.evaluate(() => {
            peakPdEngine.step([neutralPoseInput, neutralPoseInput]);
            peakPdEngine.present();
            const source = document.querySelector('#canvas'), canvas = document.createElement('canvas');
            canvas.width = source.width; canvas.height = source.height;
            const ctx = canvas.getContext('2d'); ctx.drawImage(source, 0, 0);
            const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
            let hash = 2166136261, colored = 0;
            for (let i = 0; i < data.length; i++) {
                hash = Math.imul(hash ^ data[i], 16777619) >>> 0;
                if (i % 4 !== 3 && data[i]) colored++;
            }
            return {state: peakPdEngine.captureComponents(), hash, colored};
        }));
        assert.deepEqual(states[0], states[1]);
        assert.ok(states[0].colored > 10000, 'Pixel comparison must contain rendered gameplay.');
        // Diverge movement at the same simulation frame, then restore all staged
        // scalar history without changing the clock or importing GPU resources.
        for (let i = 0; i < 2; ++i) await pages[i].evaluate(i => {
            const n = neutralPoseInput;
            for (let tick = 0; tick < 30; ++tick)
                peakPdEngine.step([{...n, moveY: i ? -60 : 70, moveX: i ? 50 : 0}, n]);
            peakPdEngine.drainEvents();
        }, i);
        const correction = await pages[0].evaluate(() => peakPdEngine.captureWalkingState());
        const corrected = await pages[1].evaluate(snapshot => {
            const before = peakPdEngine.captureWalkingState(), tick = Module._peakPdTick();
            const textures = GL.textures.slice();
            const badInputs = [
                {...snapshot, levelFrame: snapshot.levelFrame - 1},
                {...snapshot, players: snapshot.players.map((p, i) => i ? {...p, movement: p.movement.map((v, j) => j === 40 ? 3 : v)} : p)},
                {...snapshot, players: snapshot.players.map((p, i) => i ? {...p, movement: p.movement.map((v, j) => j === 124 ? 32767 : v)} : p)},
                {...snapshot, players: snapshot.players.map((p, i) => i ? {...p, movement: new Array(181)} : p)}
            ];
            for (const bad of badInputs) {
                let rejected = false;
                try { peakPdEngine.restoreWalkingState(bad); } catch { rejected = true; }
                if (!rejected || JSON.stringify(before) !== JSON.stringify(peakPdEngine.captureWalkingState()))
                    throw new Error('Invalid movement batch changed a player.');
            }
            peakPdEngine.restoreWalkingState(snapshot);
            if (tick !== Module._peakPdTick() || peakPdEngine.drainEvents().length ||
                textures.length !== GL.textures.length || textures.some((t, i) => t !== GL.textures[i]))
                throw new Error('Movement restore changed time, events or graphics resources.');
            return peakPdEngine.captureWalkingState();
        }, correction);
        assert.deepEqual(corrected, correction, 'All 181 movement fields and both poses must restore atomically.');
        await pages[1].evaluate(() => {
            const original = peakPdEngine.captureInventoryState();
            const desired = structuredClone(original);
            desired.players[0].inventory.ammo[1] = 50;
            if (!desired.players[0].inventory.items.some(a => a[0] === 1 && a[1] === 2))
                desired.players[0].inventory.items.push([1, 2, -1]);
            for (const mode of ['reference', 'duplicate', 'weapon']) {
                const bad = structuredClone(desired), s = bad.players[1].inventory;
                if (mode === 'reference') s.items.push([2, 0x7fffffff, 0]);
                if (mode === 'duplicate') s.items.push([...s.items[0]]);
                if (mode === 'weapon') s.header[1] = 24;
                let rejected = false;
                try { peakPdEngine.restoreInventoryState(bad); } catch { rejected = true; }
                if (!rejected || JSON.stringify(original) !== JSON.stringify(peakPdEngine.captureInventoryState()))
                    throw new Error('Rejected inventory batch changed a player.');
            }
            const textures = GL.textures.slice(), tick = Module._peakPdTick();
            peakPdEngine.restoreInventoryState(desired);
            if (JSON.stringify(desired) !== JSON.stringify(peakPdEngine.captureInventoryState()))
                throw new Error('Inventory list or ammunition failed to restore.');
            peakPdEngine.restoreInventoryState(original);
            if (JSON.stringify(original) !== JSON.stringify(peakPdEngine.captureInventoryState()) ||
                tick !== Module._peakPdTick() || peakPdEngine.drainEvents().length ||
                textures.length !== GL.textures.length || textures.some((t, i) => t !== GL.textures[i]))
                throw new Error('Inventory restore changed time, events or graphics resources.');
        });
        const replay = [];
        for (const page of pages) replay.push(await page.evaluate(() => {
            const trace = [], n = neutralPoseInput;
            for (let tick = 0; tick < 120; ++tick) {
                const input = tick < 60 ? n : {...n, moveY: 60, moveX: -40,
                    lookX: 128, buttons: tick >= 80 && tick < 90 ? 16 : 0};
                peakPdEngine.step([input, n]);
                trace.push(peakPdEngine.captureWalkingState());
            }
            peakPdEngine.drainEvents();
            return trace;
        }));
        assert.deepEqual(replay[0], replay[1], 'Corrected walking/head state must reproduce 120 neutral, moving, turning and crouching ticks.');
        const result = await pages[1].evaluate(poses => {
            const n = neutralPoseInput, m = Module;
            for (let tick = 0; tick < 30; tick++) peakPdEngine.step([{...n, moveY: 80, lookX: 512}, {...n, lookX: -256}]);
            peakPdEngine.drainEvents();
            const before = peakPdEngine.captureComponents(), tick = m._peakPdTick();
            const textures = GL.textures.slice(), programs = GL.programs.slice();
            function unchanged() {
                if (JSON.stringify(before) !== JSON.stringify(peakPdEngine.captureComponents()))
                    throw new Error('Rejected transaction changed native components.');
            }
            const row = p => [p.slot, p.entity, ...p.position, p.yaw, p.pitch, ...p.rooms, ...Array(8 - p.rooms.length).fill(-1)];
            if (m._peakPdPoseBegin(poses.epoch, poses.stage, 2) !== 1) throw new Error('Begin failed.');
            if (m._peakPdPosePlayer(...row(poses.players[0])) !== 1) throw new Error('Valid first row rejected.');
            unchanged();
            if (m._peakPdCommand(0, 0, 0, 0, 0, 0) !== 0 || m._peakPdStartCombat(32) !== 0)
                throw new Error('A pose transaction allowed an interleaved input or stage transition.');
            const invalid = row(poses.players[1]); invalid[7] = 32767;
            if (m._peakPdPosePlayer(...invalid) !== 0 || m._peakPdPoseCommit() !== 0)
                throw new Error('Invalid room did not reject the entire native batch.');
            unchanged(); m._peakPdPoseCancel();
            // A malformed extra call must poison even an otherwise complete
            // native transaction, rather than committing its valid prefix.
            m._peakPdPoseBegin(poses.epoch, poses.stage, 1);
            m._peakPdPosePlayer(...row(poses.players[0]));
            if (m._peakPdPosePlayer(...row(poses.players[0])) !== 0 || m._peakPdPoseCommit() !== 0)
                throw new Error('A rejected native row left a committable valid prefix.');
            unchanged(); m._peakPdPoseCancel();
            for (const bad of [ {...poses, epoch: poses.epoch + 1}, {...poses, stage: 32},
                {...poses, players: [poses.players[0], {...poses.players[1], entity: 1000000}]},
                {...poses, players: [poses.players[0], {...poses.players[1], entity: poses.players[0].entity}]} ]) {
                let rejected = false;
                try {peakPdEngine.restorePlayerPoses(bad);} catch {rejected = true;}
                if (!rejected) throw new Error('Invalid pose snapshot was accepted.');
                unchanged();
            }
            peakPdEngine.restorePlayerPoses(poses);
            const restored = peakPdEngine.capturePlayerPoses(), after = peakPdEngine.captureComponents();
            if (JSON.stringify(restored) !== JSON.stringify(poses)) throw new Error('Typed poses failed to restore.');
            if (m._peakPdTick() !== tick || peakPdEngine.drainEvents().length || peakPdEngine.present())
                throw new Error('Restore advanced time, emitted events, or presented stale commands.');
            if (textures.length !== GL.textures.length || programs.length !== GL.programs.length ||
                textures.some((value, index) => value !== GL.textures[index]) ||
                programs.some((value, index) => value !== GL.programs[index])) throw new Error('Restore replaced local graphics resources.');
            for (const p of poses.players) {
                const pk = `player:${poses.epoch}:${p.entity}`, propKey = `prop:${poses.epoch}:${p.entity}`;
                before[pk].yaw = after[pk].yaw; before[pk].pitch = after[pk].pitch;
                before[propKey].position = after[propKey].position; before[propKey].rooms = after[propKey].rooms;
            }
            if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Pose restore changed unrelated components.');
            const swapped = {...poses, players: poses.players.map((p, i) => ({...p,
                position: poses.players[1 - i].position, rooms: poses.players[1 - i].rooms}))};
            if (JSON.stringify(poses.players[0].rooms) === JSON.stringify(poses.players[1].rooms))
                throw new Error('Cross-room fixture needs different initial rooms.');
            for (let repeat = 0; repeat < 10; repeat++) {
                peakPdEngine.restorePlayerPoses(swapped);
                if (JSON.stringify(peakPdEngine.capturePlayerPoses()) !== JSON.stringify(swapped))
                    throw new Error('Cross-room pose restore failed.');
                peakPdEngine.restorePlayerPoses(poses);
            }
            peakPdEngine.step([n, n]);
            if (!peakPdEngine.present()) throw new Error('A fresh frame could not be presented.');
            peakPdEngine.startCombat(32);
            for (let tick = 0; tick < 30; tick++) peakPdEngine.step([n, n]);
            const newStage = peakPdEngine.captureComponents();
            let rejected = false;
            try {peakPdEngine.restorePlayerPoses(poses);} catch {rejected = true;}
            if (!rejected || JSON.stringify(newStage) !== JSON.stringify(peakPdEngine.captureComponents()))
                throw new Error('Old-stage pose state crossed a stage boundary.');
            return {restoredPlayers: restored.players.length, preservedTick: tick, nextStage: newStage.meta.stage,
                glError: GL.currentContext.GLctx.getError()};
        }, poses);
        assert.equal(result.glError, 0); assert.deepEqual(errors, []);
        console.log('Typed pose, walking/head replay, inventory transactions, resource preservation, pixel equality and stage rejection passed:', result);
    } finally {await browser.close();}
})().catch(error => {console.error(error); process.exitCode = 1;});
