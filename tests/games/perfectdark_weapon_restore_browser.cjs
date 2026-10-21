/* Real-WASM same-weapon correction. This is not a full world-replica test. */
const assert = require('node:assert/strict');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const mpWeapon = Number(process.argv.find(a => a.startsWith('--weapon='))?.split('=')[1] || 1);
const withVitals = process.argv.includes('--vitals');
const withSmoke = process.argv.includes('--smoke');
const createSmoke = process.argv.includes('--smoke-create');
if (createSmoke && !withSmoke) throw new Error('--smoke-create requires --smoke');
const withRandom = process.argv.includes('--random') || withSmoke;
const randomControl = process.argv.includes('--random-control');
if (randomControl && !withRandom) throw new Error('--random-control requires --random');
const activeEffects = process.argv.includes('--active-effects') || withSmoke;
if (activeEffects && (!withRandom || randomControl)) throw new Error('--active-effects requires --random without --random-control');
const clientAhead = process.argv.includes('--client-ahead');
(async () => {
    const browser = await chromium.launch({headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? {executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH} : {})});
    const pages = [], errors = [];
    try {
        for (let i = 0; i < 2; ++i) {
            const page = await browser.newPage(); pages.push(page);
            page.on('pageerror', error => errors.push(error.message));
            await page.addInitScript(({random,vitals}) => { window.weaponVitalsCorrection = vitals; window.weaponRandomCorrection = random; window.peakPdLaunchOptions = {controlled: true, players: 2, seed: 12345}; }, {random:withRandom,vitals:withVitals});
            await page.request.get('http://127.0.0.1:8066/test-login/weapon-restore-' + i);
            await page.goto('http://127.0.0.1:8066/games/retro/preview/perfectdark');
            await page.locator('#start').click();
            await page.waitForFunction(() => window.peakPdEngine || window.peakPdError, null, {timeout: 60000});
            assert.equal(await page.evaluate(() => window.peakPdError || null), null);
            await page.evaluate(mpWeapon => {
                const n = window.weaponNeutral = {buttons: 0, moveX: 0, moveY: 0, lookX: 0, lookY: 0};
                for (let tick = 0; tick < 601; ++tick) peakPdEngine.step([{...n, buttons: tick % 100 === 0 ? 128 : 0}, n]);
                peakPdEngine.startCombat(37, Array(6).fill(mpWeapon));
                for (let tick = 0; tick < 120; ++tick) peakPdEngine.step([n, n]);
                const initial = peakPdEngine.captureComponents(), candidates = [];
                for (let slot = 0; slot < 2; ++slot) {
                    const id = initial.meta.players[slot], epoch = initial.meta.epoch;
                    const player = initial[`player:${epoch}:${id}`], prop = initial[`prop:${epoch}:${id}`];
                    for (const [key, item] of Object.entries(initial)) if (key.startsWith('prop:') && item.type === 4 && item.enabled &&
                        Math.abs(item.position[1] - player.feetGround) < 30)
                        candidates.push({slot, target: item.position, distance: Math.hypot(item.position[0] - prop.position[0], item.position[2] - prop.position[2])});
                }
                candidates.sort((a, b) => a.distance - b.distance);
                const target = candidates[0];
                if (!target || target.distance > 500) throw new Error('No nearby original weapon pickup.');
                window.weaponSlot = target.slot;
                window.weaponStep = command => {
                    const inputs = [{...n}, {...n}]; inputs[weaponSlot] = {...n, ...command};
                    peakPdEngine.step(inputs);
                    return peakPdEngine.drainEvents();
                };
                peakPdEngine.drainEvents();
                for (let tick = 0; tick < 220; ++tick) {
                    const p = peakPdEngine.observe().players[target.slot];
                    const dx = target.target[0] - p.position[0], dz = target.target[2] - p.position[2];
                    const angle = (Math.atan2(-dx, dz) * 180 / Math.PI - p.yaw + 540) % 360 - 180;
                    weaponStep({moveY: Math.hypot(dx, dz) > 20 ? 100 : 0,
                        lookX: Math.round(Math.max(-15, Math.min(15, angle)) * 32767 / 180)});
                }
                const s = peakPdEngine.captureComponents(), key = `player:${s.meta.epoch}:${s.meta.players[target.slot]}`;
                if (s[key].weapon === 1) weaponStep({buttons: 32});
                for (let tick = 0; tick < 90; ++tick) weaponStep({});
                // Collect an original multi-ammo crate. A loose automatic
                // weapon alone can contain less than one full magazine.
                const ammoState = peakPdEngine.captureComponents(), crates = [];
                const id = ammoState.meta.players[weaponSlot], epoch = ammoState.meta.epoch;
                const feet = ammoState[`player:${epoch}:${id}`].feetGround;
                const position = ammoState[`prop:${epoch}:${id}`].position;
                for (const [key, item] of Object.entries(ammoState)) if (key.startsWith('prop:') &&
                    item.type === 1 && item.enabled && ammoState[key.replace('prop:', 'object:')]?.type === 20 &&
                    Math.abs(item.position[1] - feet) < 30)
                    crates.push({position: item.position, distance: Math.hypot(item.position[0] - position[0], item.position[2] - position[2])});
                crates.sort((a, b) => a.distance - b.distance);
                if (!crates.length || crates[0].distance > 600) throw new Error('No nearby original ammo crate.');
                for (let tick = 0; tick < 220; ++tick) {
                    const p = peakPdEngine.observe().players[weaponSlot];
                    const dx = crates[0].position[0] - p.position[0], dz = crates[0].position[2] - p.position[2];
                    const angle = (Math.atan2(-dx, dz) * 180 / Math.PI - p.yaw + 540) % 360 - 180;
                    weaponStep({moveY: Math.hypot(dx, dz) > 20 ? 100 : 0,
                        lookX: Math.round(Math.max(-15, Math.min(15, angle)) * 32767 / 180)});
                }
                for (let tick = 0; tick < 90; ++tick) weaponStep({});
            }, mpWeapon);
        }
        const capture = page => page.evaluate(() => peakPdEngine.capturePlayerState({vitals: window.weaponVitalsCorrection, random: window.weaponRandomCorrection, smoke: !!window.weaponSmokeCorrection}));
        const initial = await capture(pages[0]);
        await pages[1].evaluate(s => peakPdEngine.restorePlayerState(s), initial);
        assert.deepEqual(await capture(pages[1]), initial);
        const hashes = [];
        for (const page of pages) hashes.push(await page.evaluate(() => {
            weaponStep({}); peakPdEngine.present();
            const source = document.querySelector('#canvas'), canvas = document.createElement('canvas');
            canvas.width = source.width; canvas.height = source.height;
            const ctx = canvas.getContext('2d'); ctx.drawImage(source, 0, 0);
            const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
            let hash = 2166136261, colored = 0;
            for (let i = 0; i < pixels.length; ++i) {
                hash = Math.imul(hash ^ pixels[i], 16777619) >>> 0;
                if (i % 4 !== 3 && pixels[i]) colored++;
            }
            return {hash, colored};
        }));
        assert.deepEqual(hashes[0], hashes[1], 'Idempotent correction must preserve the next rendered frame.');
        assert.ok(hashes[0].colored > 10000);
        // Exercise idle animation restore before gameplay consumes different
        // global random streams; world/RNG restoration is a separate contract.
        const meleeTraces = [];
        for (const page of pages) meleeTraces.push(await page.evaluate(() => {
            const result = [], slot = 1 - weaponSlot;
            for (let tick = 0; tick < 150; ++tick) {
                const inputs = [{...weaponNeutral}, {...weaponNeutral}];
                inputs[slot].buttons = tick < 90 ? 1 : 0;
                peakPdEngine.step(inputs);
                const s = peakPdEngine.captureComponents();
                result.push({hand: s[`hand:${s.meta.epoch}:${s.meta.players[slot]}:0`],
                    events: peakPdEngine.drainEvents().map(e => ({type: e.type, tick: e.tick, data: e.data}))});
            }
            return result;
        }));
        assert.deepEqual(meleeTraces[0], meleeTraces[1], 'Restoring an idle unarmed hand must preserve its next melee animation.');
        assert.ok(meleeTraces[0].some(t => t.events.some(e => e.data.attack === 'melee')));

        // Diverge in either direction, but advance to the same level frame.
        for (let i = 0; i < 2; ++i) await pages[i].evaluate(active => {
            for (let tick = 0; tick < 30; ++tick) weaponStep({buttons: active ? 1 : 0, moveY: active ? 20 : 0, lookX: active ? 128 : 0});
        }, clientAhead ? i === 1 : i === 0);
        const correction = await capture(pages[0]);
        const before = await capture(pages[1]);
        assert.notDeepEqual(before, correction, 'The fixture must actually diverge.');
        if (withRandom) assert.notDeepEqual(before.random, correction.random, 'Shooting must consume a different random stream.');
        await pages[1].evaluate(s => {
            const original = peakPdEngine.capturePlayerState({vitals: window.weaponVitalsCorrection, random: window.weaponRandomCorrection}), textures = GL.textures.slice();
            const tick = Module._peakPdTick();
            if (window.weaponRandomCorrection) {
                for (const value of [NaN, -1, 0.5, 4294967296]) {
                    if (Module._peakPdPlayerBegin(s.epoch, s.stage, s.players.length, s.levelFrame) !== 1)
                        throw new Error('Native RNG rejection fixture could not begin.');
                    const words = [...s.random]; words[0] = value;
                    if (Module._peakPdRandomStage(s.tick, ...words) !== 0 || Module._peakPdPoseCommit() !== 0)
                        throw new Error('Native RNG validation accepted malformed words.');
                    Module._peakPdPoseCancel();
                    if (JSON.stringify(original) !== JSON.stringify(peakPdEngine.capturePlayerState({vitals: window.weaponVitalsCorrection, random:true})))
                        throw new Error('Rejected native RNG transaction changed state.');
                }
            }
            for (const fault of ['script', 'ammo', 'frame', 'weapon', ...(window.weaponRandomCorrection ? ['random', 'tick', 'subset', 'epoch', 'sway'] : [])]) {
                const bad = structuredClone(s), h = bad.players[1].hands[0];
                if (fault === 'script') h.header[4] = 2048;
                if (fault === 'ammo') h.fields[42] = 32767;
                if (fault === 'frame') h.fields[92] = 32767;
                if (fault === 'weapon') h.header[0] = 24;
                if (fault === 'random') bad.random[1] = 4294967296;
                if (fault === 'tick') bad.tick--;
                if (fault === 'subset') bad.players.pop();
                if (fault === 'epoch') bad.epoch++;
                if (fault === 'sway') bad.players[1].sway[7] = 4; // Invalid blend array index.
                let rejected = false;
                try { peakPdEngine.restorePlayerState(bad); } catch { rejected = true; }
                if (!rejected || JSON.stringify(original) !== JSON.stringify(peakPdEngine.capturePlayerState({vitals: window.weaponVitalsCorrection, random: window.weaponRandomCorrection})))
                    throw new Error('Invalid weapon batch partially changed a player: ' + fault);
            }
            peakPdEngine.restorePlayerState(s);
            if (tick !== Module._peakPdTick() || peakPdEngine.drainEvents().length || peakPdEngine.present() ||
                textures.length !== GL.textures.length || textures.some((t, i) => t !== GL.textures[i]))
                throw new Error('Weapon correction changed time, effects or graphics resources.');
        }, correction);
        assert.deepEqual(await capture(pages[1]), correction, 'Loaded ammo, script and animation state must restore.');
        // Ensure both directions leave a partially depleted magazine before
        // asking the original engine to reload.
        for (const page of pages) await page.evaluate(() => {
            for (let tick = 0; tick < 30; ++tick) weaponStep({buttons: 1});
        });
        // Correct halfway through an original reload, while the client remains idle.
        const reloadTicks = await pages[0].evaluate(() => {
            for (let tick = 0; tick < 30; ++tick) weaponStep({});
            let ticks = 30, reloading = false;
            for (let tick = 0; tick < 240; ++tick) {
                weaponStep({buttons: tick % 20 === 0 ? 4 : 0}); ++ticks;
                const s = peakPdEngine.captureComponents();
                if (s[`hand:${s.meta.epoch}:${s.meta.players[weaponSlot]}:0`].state === 1) { reloading = true; break; }
            }
            if (!reloading) throw new Error('Original reload did not start.');
            for (let tick = 0; tick < 12; ++tick) weaponStep({});
            return ticks + 12;
        });
        await pages[1].evaluate(ticks => { for (let tick = 0; tick < ticks; ++tick) weaponStep({}); }, reloadTicks);
        const reload = await capture(pages[0]);
        assert.ok(reload.players.some(p => p.hands.some(h => h.fields[44] === 1)), 'The correction must land inside an actual reload: ' +
            JSON.stringify(reload.players.map(p => ({slot: p.slot, ammo: p.inventory.ammo,
                hands: p.hands.map(h => ({header: h.header, state: h.fields[44], loaded: h.fields[42]}))}))));
        assert.notDeepEqual(await capture(pages[1]), reload);
        await pages[1].evaluate(s => peakPdEngine.restorePlayerState(s), reload);
        assert.deepEqual(await capture(pages[1]), reload);
        const traces = [];
        for (const page of pages) traces.push(await page.evaluate(() => {
            const trace = [];
            for (let tick = 0; tick < 180; ++tick) {
                const events = weaponStep({buttons: tick >= 120 && tick < 150 ? 1 : 0});
                const state = peakPdEngine.captureComponents();
                const id = state.meta.players[weaponSlot], key = `${state.meta.epoch}:${id}`;
                trace.push({hand: state[`hand:${key}:0`], reserve: state[`player:${key}`].ammo,
                    events: events.map(e => ({type: e.type, tick: e.tick, data: e.data}))});
            }
            return trace;
        }));
        assert.deepEqual(traces[0], traces[1], 'Corrected reload, subsequent shots and ammo must agree for 180 ticks.');
        if (withRandom) {
            const smokeCount = page => page.evaluate(() => Object.entries(peakPdEngine.captureComponents())
                .filter(([key, prop]) => key.startsWith('prop:') && prop.type === 8).length);
            // This checkpoint does not restore world effects. Let the original
            // smoke simulation expire naturally for the component acceptance
            // case; retain the active-effects case as a world-restore regression.
            if (!activeEffects) {
                let settled = false;
                for (let batch = 0; batch < 20; batch++) {
                    const counts = await Promise.all(pages.map(smokeCount));
                    if (counts.every(count => count === 0)) { settled = true; break; }
                    for (const page of pages) await page.evaluate(() => {
                        for (let tick = 0; tick < 60; tick++) {
                            peakPdEngine.step([weaponNeutral, weaponNeutral]);
                            peakPdEngine.drainEvents();
                        }
                    });
                }
                assert.ok(settled, 'Original smoke effects must expire before testing a player-only checkpoint');
            }
            // Real air punches consume random animation choices without adding
            // bullets/projectiles to the world. Both engines reach the same tick.
            for (let i=0;i<2;i++) await pages[i].evaluate(active=>{
                for(let tick=0;tick<180;tick++){
                    const row=[{...weaponNeutral},{...weaponNeutral}];
                    row[1-weaponSlot].buttons=active&&tick<60?1:0;
                    peakPdEngine.step(row);peakPdEngine.drainEvents();
                }
            },clientAhead?i===1:i===0);
            const smokeCounts = await Promise.all(pages.map(smokeCount));
            if (activeEffects) {
                assert.notDeepEqual(smokeCounts[0], smokeCounts[1], 'World regression needs different live smoke histories');
            } else assert.deepEqual(smokeCounts, [0, 0], 'Melee acceptance must have no outstanding smoke effects');
            if (withSmoke) for (const page of pages) await page.evaluate(() => { window.weaponSmokeCorrection = true; });
            const host=await capture(pages[0]),client=await capture(pages[1]);
            assert.notDeepEqual(host.random,client.random,'Different melee histories must exercise random correction');
            const authority = createSmoke ? client : host, recipient = pages[createSmoke ? 0 : 1];
            const correction=structuredClone(authority);
            if (withSmoke) {
                const smoke = correction.smoke.slots.find(row => row !== null) || (createSmoke ? host : client).smoke.slots.find(row => row !== null);
                assert.ok(smoke, 'Smoke regression must include a live particle allocation');
                await recipient.evaluate(({snapshot, smoke}) => {
                    const capture = () => peakPdEngine.capturePlayerState({smoke: true});
                    const before = capture(), textures = GL.textures.slice();
                    for (const fault of ['age', 'room', 'stateindex', 'order', 'duplicate', 'capacity', 'partial', 'weapon']) {
                        const bad = structuredClone(snapshot);
                        let slot = bad.smoke.slots.findIndex(row => row !== null);
                        if (slot < 0) { slot = 0; bad.smoke.slots[slot] = [...smoke]; bad.smoke.order.push(-slot - 1); }
                        if (fault === 'age') bad.smoke.slots[slot][0] = -1;
                        if (fault === 'room') bad.smoke.slots[slot][10] = 32767;
                        if (fault === 'stateindex') bad.smoke.slots[slot][21] = 255;
                        if (fault === 'order') bad.smoke.order[0] = 0xffffffff;
                        if (fault === 'duplicate') bad.smoke.order.push(bad.smoke.order[0]);
                        if (fault === 'capacity') bad.smoke.capacity++;
                        if (fault === 'partial') bad.smoke.slots[slot].pop();
                        if (fault === 'weapon') bad.players[1].hands[0].fields[42] = 32767;
                        let rejected = false;
                        try { peakPdEngine.restorePlayerState(bad); } catch { rejected = true; }
                        if (!rejected || JSON.stringify(capture()) !== JSON.stringify(before))
                            throw new Error('Invalid smoke correction partially changed engine state: ' + fault);
                        if (textures.length !== GL.textures.length || textures.some((t,i) => t !== GL.textures[i]))
                            throw new Error('Rejected smoke correction changed GPU resources');
                    }
                }, {snapshot: correction, smoke});
            }
            if(randomControl)correction.random=[...client.random];
            if (withSmoke) require('node:fs').writeFileSync('.tmp/perfectdark/smoke-checkpoint-'+(createSmoke?'create':'remove')+'.json', JSON.stringify({correction, before:await capture(recipient)}));
            await recipient.evaluate(snapshot=>peakPdEngine.restorePlayerState(snapshot),correction);
            if(!randomControl)assert.deepEqual(await capture(recipient),authority);
            if (withSmoke) await recipient.evaluate(snapshot => {
                const before = peakPdEngine.captureComponents(), tick = Module._peakPdTick();
                const textures = GL.textures.slice();
                // Stored independent-effect v1 checkpoints remain restorable.
                const legacy = structuredClone(snapshot);
                legacy.schema = 'pd-player-smoke-v1'; delete legacy.smoke.sources;
                peakPdEngine.restorePlayerState(legacy);
                peakPdEngine.restorePlayerState(snapshot);
                if (JSON.stringify(peakPdEngine.captureComponents()) !== JSON.stringify(before) || Module._peakPdTick() !== tick ||
                    peakPdEngine.drainEvents().length || textures.length !== GL.textures.length || textures.some((t,i) => t !== GL.textures[i]))
                    throw new Error('Idempotent smoke correction changed identities, time, events or graphics resources');
            }, correction);
            const melee=[];
            for(const page of pages)melee.push(await page.evaluate(()=>{
                const trace=[];
                for(let tick=0;tick<150;tick++){
                    const row=[{...weaponNeutral},{...weaponNeutral}];row[1-weaponSlot].buttons=tick<90?1:0;
                    peakPdEngine.step(row);
                    const s=peakPdEngine.captureComponents(),id=s.meta.players[1-weaponSlot];
                    trace.push({smoke:window.weaponSmokeCorrection ? peakPdEngine.capturePlayerState({smoke:true}).smoke : null,hand:s[`hand:${s.meta.epoch}:${id}:0`],
                        animation:peakPdEngine.captureWeaponState().players.find(p=>p.slot===1-weaponSlot).hands,
                        random:Array.from({length:4},(_,i)=>Module._peakPdRandomWord(i)),
                        events:peakPdEngine.drainEvents().map(e=>({type:e.type,tick:e.tick,data:e.data}))});
                }
                return trace;
            }));
            assert.ok(melee[0].some(t=>t.events.some(e=>e.data.attack==='melee')));
            require('node:fs').writeFileSync('.tmp/perfectdark/random-trace-'+(clientAhead?'client':'host')+(withSmoke?(createSmoke?'-smoke-create':'-smoke'):randomControl?'-control':activeEffects?'-effects':'')+'.json',JSON.stringify(melee));
            if(activeEffects && !withSmoke)assert.notDeepEqual(melee[0].map(({random,...rest})=>rest),melee[1].map(({random,...rest})=>rest),
                'Player/RNG correction cannot reconcile different live smoke worlds yet');
            else if(randomControl)assert.notDeepEqual(melee[0].map(({random,...rest})=>rest),melee[1].map(({random,...rest})=>rest),
                'Control without RNG correction must reproduce gameplay/animation divergence');
            else assert.deepEqual(melee[0],melee[1],'Randomized melee must match after different attack histories');
            console.log(withSmoke?'Atomic player/RNG/smoke correction replay passed.':activeEffects?'World regression reproduced: active smoke still requires world restoration.':randomControl?'Negative control reproduced melee divergence without RNG correction.':
                'Atomic random/player correction and divergent-history melee replay passed.');
        }
        assert.deepEqual(errors, []);
        console.log('Weapon/script restore, atomic rejection, reload/fire and melee checks passed:',
            {mpWeapon, clientAhead, withRandom, randomControl, activeEffects, withSmoke, createSmoke});
    } finally { await browser.close(); }
})().catch(error => {console.error(error); process.exitCode = 1;});
