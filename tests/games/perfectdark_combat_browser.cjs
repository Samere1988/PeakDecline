/* Real pickup, firearm ammo and reload acceptance. No memory edits or grants. */
const {chromium} = require('C:/Users/Plex/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert = require('node:assert/strict');
const {GameplayEvents} = require('../../static/js/netplay/authoritative.js');
const explosive = process.argv.includes('--explosive');
const driverMode = process.argv.includes('--driver');
const melee = process.argv.includes('--melee');
const throwing = process.argv.includes('--throw');
(async () => {
    const browser = await chromium.launch({headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
    const errors = [], results = [];
    try {
        for (let instance = 0; instance < 2; instance++) {
            const page = await browser.newPage();
            page.on('pageerror', error => errors.push(error.message));
            await page.addInitScript(() => { window.peakPdLaunchOptions = {controlled: true, players: 2, seed: 12345}; });
            await page.request.get('http://127.0.0.1:8066/test-login/combat-' + instance);
            await page.goto('http://127.0.0.1:8066/games/retro/preview/perfectdark');
            await page.locator('#start').click();
            await page.waitForFunction(() => window.peakPdEngine || window.peakPdError, null, {timeout: 60000});
            assert.equal(await page.evaluate(() => window.peakPdError || null), null);
            if (driverMode) {
                await page.evaluate(() => { PeakNet.backends = new Map(); });
                await page.addScriptTag({url: 'http://127.0.0.1:8066/static/js/netplay/authoritative.js'});
            }
            results.push(await page.evaluate(({explosive, driverMode, instance, melee, throwing}) => {
                const neutral = {buttons: 0, moveX: 0, moveY: 0, lookX: 0, lookY: 0};
                for (let tick = 0; tick < 601; tick++)
                    peakPdEngine.step([{...neutral, buttons: tick % 100 === 0 ? 128 : 0}, neutral]);
                if (Module._peakPdStartCombatWeapons(37, 1, 1, 1, 1, 1, 999) !== 0)
                    throw new Error('Native match setup accepted invalid weapon.');
                peakPdEngine.startCombat(37, Array(6).fill(throwing ? 28 : explosive ? 23 : 1));
                for (let tick = 0; tick < 120; tick++) peakPdEngine.step([neutral, neutral]);
                const initial = peakPdEngine.captureComponents();
                const events = peakPdEngine.drainEvents();
                // Components are diagnostic capture only; this drives real host
                // commands/events but is not a complete client state adapter.
                const driver = driverMode ? new PeakNet.AuthoritativeHost({players: 2, tickRate: 60,
                    adapter: {step: (commands, dt, context) => peakPdEngine.step(commands, context),
                        captureState: () => peakPdEngine.captureComponents()}}) : null;
                const read = (state, slot) => {
                    const id = state.meta.players[slot], epoch = state.meta.epoch;
                    return {player: state[`player:${epoch}:${id}`], hand: state[`hand:${epoch}:${id}:0`],
                        prop: state[`prop:${epoch}:${id}`]};
                };
                if (melee) {
                    for (let tick = 0; tick < 150; tick++) {
                        peakPdEngine.step([{...neutral, buttons: tick < 90 ? 1 : 0}, neutral]);
                        events.push(...peakPdEngine.drainEvents());
                        if (instance === 0) {
                            const state = peakPdEngine.captureComponents();
                            peakPdEngine.present(); peakPdEngine.present();
                            if (JSON.stringify(state) !== JSON.stringify(peakPdEngine.captureComponents()) ||
                                peakPdEngine.drainEvents().length) throw new Error('Presentation repeated a melee attack.');
                        }
                    }
                    return {events, initial, final: peakPdEngine.captureComponents()};
                }
                const candidates = [];
                for (let slot = 0; slot < 2; slot++) {
                    const player = read(initial, slot);
                    for (const [key, prop] of Object.entries(initial)) {
                        // Grenades are supplied by the original multiplayer
                        // ammo crates, rather than a loose weapon model.
                        const pickup = throwing ? prop.type === 1 && initial[key.replace('prop:', 'object:')]?.type === 20 : prop.type === 4;
                        if (!key.startsWith('prop:') || !pickup || !prop.enabled ||
                            Math.abs(prop.position[1] - player.player.feetGround) > 30) continue;
                        candidates.push({slot, key, target: prop.position, distance: Math.hypot(
                            prop.position[0] - player.prop.position[0], prop.position[2] - player.prop.position[2])});
                    }
                }
                candidates.sort((a, b) => a.distance - b.distance);
                const target = candidates[0];
                if (!target || target.distance > 500) throw new Error('Fixture has no nearby same-floor pickup: ' +
                    JSON.stringify({candidates, props: Object.entries(initial).filter(([key]) => key.startsWith('prop:'))}));
                const step = command => {
                    const row = [neutral, neutral]; row[target.slot] = {...neutral, ...command};
                    if (driver) {
                        for (let slot = 0; slot < 2; slot++) driver.receive(slot,
                            {seq: driver.tick + 1, viewTick: driver.tick, command: row[slot]});
                        driver.advance();
                        events.push(...driver.events.splice(0));
                    } else peakPdEngine.step(row);
                    const pending = Module._peakPdEventCount();
                    if (pending) {
                        const id = Module._peakPdEventField(pending - 1, 0);
                        if (Module._peakPdEventAck(initial.meta.epoch + 1, id) !== 0 ||
                            Module._peakPdEventCount() !== pending) throw new Error('Stale epoch acknowledged events.');
                    }
                    events.push(...peakPdEngine.drainEvents());
                    if (peakPdEngine.drainEvents().length) throw new Error('An acknowledged native event was delivered twice.');
                    if (instance === 0) {
                        const before = peakPdEngine.captureComponents();
                        for (let refresh = 0; refresh < 2; refresh++)
                            if (!peakPdEngine.present()) throw new Error('Combat frame presentation failed.');
                        if (JSON.stringify(before) !== JSON.stringify(peakPdEngine.captureComponents()) ||
                            peakPdEngine.drainEvents().length) throw new Error('Display refresh mutated combat state.');
                    }
                };
                for (let tick = 0; tick < 220; tick++) {
                    const player = peakPdEngine.observe().players[target.slot];
                    const dx = target.target[0] - player.position[0], dz = target.target[2] - player.position[2];
                    const angle = (Math.atan2(-dx, dz) * 180 / Math.PI - player.yaw + 540) % 360 - 180;
                    step({moveY: Math.hypot(dx, dz) > 20 ? 100 : 0,
                        lookX: Math.round(Math.max(-15, Math.min(15, angle)) * 32767 / 180)});
                }
                const pickup = peakPdEngine.captureComponents();
                if (read(pickup, target.slot).player.weapon === 1) step({buttons: 32});
                for (let tick = 0; tick < 90; tick++) step({});
                const loaded = peakPdEngine.captureComponents();
                if (throwing) {
                    step({buttons: 1});
                    const projectiles = {}, flightTimes = {};
                    for (let tick = 0; tick < 180; tick++) {
                        step({});
                        const state = peakPdEngine.captureComponents();
                        for (const [key, value] of Object.entries(state))
                            if (key.startsWith('projectile:')) {
                                if (!(value.flags & 0x80) && (value.nextX !== 0 || value.nextY !== 0 || value.nextZ !== 0))
                                    throw new Error('Inactive projectile launch coordinates were not canonicalized.');
                                projectiles[key] ??= value;
                                flightTimes[key] = Math.max(flightTimes[key] || 0, value.flightTime240);
                            }
                    }
                    const thrown = peakPdEngine.captureComponents();
                    for (let tick = 0; tick < 240; tick++) step({});
                    return {target, events, projectiles, flightTimes, epoch: loaded.meta.epoch, owner: loaded.meta.players[target.slot],
                        loaded: read(loaded, target.slot), thrown: read(thrown, target.slot),
                        final: peakPdEngine.captureComponents()};
                }
                if (explosive) {
                    // Fire into nearby ground using normal aim/fire; let the
                    // original blast damage and death/respawn path run.
                    step({lookY: 14563});
                    let dead = null;
                    for (let tick = 0; tick < 600; tick++) {
                        step({buttons: tick < 60 ? 1 : 0});
                        const state = peakPdEngine.captureComponents();
                        if (read(state, target.slot).player.dead) { dead = state; break; }
                    }
                    if (!dead) throw new Error('Rocket fixture did not kill the firing player: ' +
                        JSON.stringify({player: read(peakPdEngine.captureComponents(), target.slot), events}));
                    for (let tick = 0; tick < 300; tick++) step({});
                    for (let tick = 0; tick < 900; tick++) {
                        step({buttons: 1});
                        if (!read(peakPdEngine.captureComponents(), target.slot).player.dead) break;
                    }
                    return {target, events, loaded, dead, respawned: peakPdEngine.captureComponents()};
                }
                for (let tick = 0; tick < 30; tick++) step({buttons: 1});
                const fired = peakPdEngine.captureComponents();
                for (let tick = 0; tick < 30; tick++) step({});
                step({buttons: 4});
                const states = new Set();
                for (let tick = 0; tick < 180; tick++) {
                    step({}); states.add(read(peakPdEngine.captureComponents(), target.slot).hand.state);
                }
                const reloaded = peakPdEngine.captureComponents();
                return {target, initial, pickup, loaded, fired, reloaded, events, states: [...states],
                    selected: [loaded, fired, reloaded].map(state => read(state, target.slot)),
                    other: [loaded, reloaded].map(state => read(state, 1 - target.slot))};
            }, {explosive, driverMode, instance, melee, throwing}));
            if (instance === 0) await page.locator('#canvas').screenshot({path: '.tmp/perfectdark/combat-firearm.png'});
            await page.close();
        }
        assert.deepEqual(results[0], results[1], 'Combat components must match across independent engines.');
        if (melee || throwing) {
            const result = results[0], attacks = result.events.filter(event => event.type === 'shot');
            assert.ok(attacks.length > 0, JSON.stringify(result));
            assert.ok(attacks.every(event => event.data.attack === (melee ? 'melee' : 'throw')));
            if (throwing) {
                const ammoType = result.loaded.player.ammoType0;
                assert.equal(attacks.reduce((sum, event) => sum + event.data.count, 0),
                    result.loaded.player.ammo[ammoType] + result.loaded.hand.loaded0 -
                    result.thrown.player.ammo[ammoType] - result.thrown.hand.loaded0);
                assert.equal(new Set(attacks.map(event => event.data.entity)).size, attacks.length);
                for (const event of attacks) {
                    const projectile = result.projectiles[`projectile:${result.epoch}:${event.data.entity}`];
                    assert.ok(projectile, 'A committed throw must expose a projectile component before exploding.');
                    assert.equal(projectile.owner, result.owner, 'Projectile owners use stable entity IDs.');
                    assert.ok(result.flightTimes[`projectile:${result.epoch}:${event.data.entity}`] > 0);
                }
                assert.ok(result.events.some(event => event.type === 'explosion'));
            } else {
                assert.ok(attacks.every(event => event.data.slot === 0 && event.data.detail === 1));
                assert.ok(attacks.length < 10, 'Held melee must follow attack timing, not emit every input tick.');
            }
            const delivered = [], consumer = new GameplayEvents(event => delivered.push(event));
            consumer.receive(result.events); consumer.receive(result.events);
            assert.equal(delivered.length, result.events.length);
            assert.deepEqual(errors, []);
            console.log(`${melee ? 'Melee' : 'Thrown grenade'} native events and independent-engine equality passed:`,
                result.events.map(event => [event.type, event.data.attack]));
            return;
        }
        if (explosive) {
            const result = results[0], events = result.events;
            assert.equal(events.filter(event => event.type === 'death').length, 1);
            assert.equal(events.filter(event => event.type === 'respawn').length, 1, JSON.stringify(events));
            assert.ok(events.some(event => event.type === 'explosion'));
            const id = result.respawned.meta.players[result.target.slot];
            assert.equal(result.respawned[`player:${result.respawned.meta.epoch}:${id}`].dead, 0);
            const delivered = [], consumer = new GameplayEvents(event => delivered.push(event));
            consumer.receive(events); consumer.receive(events);
            assert.equal(delivered.length, events.length);
            assert.deepEqual(errors, []);
            console.log('Real explosion, death, respawn and deduplicated events passed:', events.map(event => event.type));
            return;
        }
        const result = results[0], [loaded, fired, reloaded] = result.selected;
        assert.equal(loaded.player.weapon, 2, 'Actual picked-up Falcon 2 must be equipped.');
        assert.ok(loaded.hand.loaded0 > 0);
        assert.ok(fired.hand.loaded0 < loaded.hand.loaded0, 'Fire must consume actual loaded ammo.');
        assert.ok(result.states.includes(1), 'Native reload state must be reached.');
        assert.ok(reloaded.hand.loaded0 > fired.hand.loaded0, 'Reload must refill the clip.');
        const ammoType = loaded.player.ammoType0;
        assert.ok(ammoType >= 0 && ammoType < 33);
        assert.equal(reloaded.player.ammo[ammoType] + reloaded.hand.loaded0,
            fired.player.ammo[ammoType] + fired.hand.loaded0, 'Reload must conserve reserve plus loaded ammo.');
        assert.deepEqual(result.other[0].player.ammo, result.other[1].player.ammo, 'Other seat ammo must remain unchanged.');
        for (const state of [result.initial, result.pickup, result.loaded, result.fired, result.reloaded])
            for (const [key, record] of Object.entries(state))
                if (key.startsWith('player:') && !record.inLift) assert.equal(record.liftGround, 0);
        assert.deepEqual(errors, []);
        const shots = result.events.filter(event => event.type === 'shot');
        assert.equal(shots.reduce((sum, event) => sum + event.data.count, 0), loaded.hand.loaded0 - fired.hand.loaded0);
        assert.ok(shots.every(event => event.data.slot === result.target.slot && event.data.detail === 2));
        assert.ok(result.events.some(event => event.type === 'pickup' && event.data.slot === result.target.slot));
        assert.equal(result.events.filter(event => event.type === 'respawn').length, 0,
            'Initial stage allocation is not a respawn.');
        const delivered = [], consumer = new GameplayEvents(event => delivered.push(event));
        consumer.receive(result.events); consumer.receive(result.events);
        assert.equal(delivered.length, result.events.length, 'Repeated network delivery must not replay native effects.');
        console.log(JSON.stringify({slot: result.target.slot, weapon: loaded.player.weapon,
            loaded: loaded.hand.loaded0, afterFire: fired.hand.loaded0, afterReload: reloaded.hand.loaded0,
            reserveBeforeReload: fired.player.ammo[ammoType], reserveAfterReload: reloaded.player.ammo[ammoType],
            reloadStates: result.states, events: result.events.map(event => event.type)}));
        console.log('Real pickup, firearm consumption, reload conservation, seat isolation and independent-engine equality passed.');
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
