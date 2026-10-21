/* Perfect Dark's real-engine boundary. Components and typed pose restoration
 * are not a complete world snapshot or prediction/reconcile contract. */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root?.PeakNet) Object.assign(root.PeakNet, api);
})(typeof window !== 'undefined' ? window : null, () => {
    'use strict';
    const actions = {
        fire: {bit: 1, mouse: 0, button: 7}, aim: {bit: 2, mouse: 2, button: 6},
        reload: {bit: 4, key: 'KeyR', button: 2}, use: {bit: 8, key: 'KeyE', button: 0},
        crouch: {bit: 16, key: 'ControlLeft', button: 10}, nextWeapon: {bit: 32, key: 'KeyQ', button: 3},
        previousWeapon: {bit: 64, key: 'KeyZ', button: 4}, start: {bit: 128, key: 'Tab', button: 9},
        accept: {bit: 256, key: 'Enter', button: 0}, cancel: {bit: 512, key: 'Backspace', button: 1},
        secondary: {bit: 1024, key: 'KeyF', button: 5}
    };
    const int = (x, a, b) => Number.isInteger(x) && x >= a && x <= b;
    // Must match peakPdComponentVersion 2's explicit scalar layouts.
    const playerFields = ['yaw', 'pitch', 'health', 'dead', 'shield',
        'sideways', 'strafe', 'forwards', 'speedBoost', 'turnSpeed', 'pitchSpeed', 'maxSpeedTime',
        'ground', 'feetGround', 'groundSum', 'verticalDelta', 'crouch', 'autoCrouch',
        'crouchOffset', 'crouchSpeed', 'falling', 'fallStart', 'onLadder', 'inLift', 'liftGround',
        'moveMode', 'aiming', 'weapon', 'previousWeapon', 'switchWeapon', 'dualWield', 'ammoType0', 'ammoType1'];
    const playerIntegers = new Set(['dead', 'maxSpeedTime', 'crouch', 'autoCrouch', 'falling',
        'fallStart', 'onLadder', 'inLift', 'moveMode', 'aiming', 'weapon', 'previousWeapon',
        'switchWeapon', 'dualWield', 'ammoType0', 'ammoType1']);
    const handFields = ['weapon', 'function', 'inUse', 'firing', 'trigger', 'previousTrigger', 'released',
        'state', 'minorState', 'stateFrames', 'stateCycles', 'loaded0', 'loaded1', 'clip0', 'clip1',
        'mode', 'nextMode', 'count', 'count60', 'refireTime', 'allowShootFrame', 'lastShootFrame', 'burstBullets'];
    function readFields(names, read, integers) {
        return Object.fromEntries(names.map((name, index) => {
            const value = read(index);
            if (!Number.isFinite(value) || (integers.has(name) && !int(value, -0x80000000, 0xffffffff)))
                throw new Error(`Invalid Perfect Dark component field: ${name}.`);
            return [name, value];
        }));
    }
    const handIntegers = new Set(handFields);
    const objectFields = ['type', 'model', 'scale', 'flags', 'flags2', 'flags3', 'hidden', 'hidden2', 'damage', 'maxDamage'];
    const weaponFields = ['weapon', 'function', 'timer240', 'fadeTime', 'dualWeapon', 'dualEntity'];
    const objectIntegers = new Set(objectFields), weaponIntegers = new Set(weaponFields);
    const projectileFields = ['flags', 'speedX', 'speedY', 'speedZ', 'owner', 'target', 'pickupBy',
        'bounces', 'bounceFrame', 'flightTime240', 'pickupTime240', 'lostTime240', 'dropType', 'powerLimit240',
        'nextX', 'nextY', 'nextZ', 'smokeTime240'];
    const projectileIntegers = new Set(projectileFields.filter(name => !['speedX', 'speedY', 'speedZ', 'nextX', 'nextY', 'nextZ'].includes(name)));
    class PerfectDarkEngine {
        constructor(module, players = 1) {
            if (!int(players, 1, 4) || module._peakPdReady() !== 1) throw new Error('Perfect Dark controlled engine is not ready.');
            this.module = module; this.players = players; this.disposed = false;
        }
        // Read-only native session diagnostics, not a replicated world snapshot.
        observeFlow() {
            if (this.disposed) throw new Error('Perfect Dark engine is disposed.');
            const m = this.module;
            if (!m._peakPdFlow || !m._peakPdMenuText)
                throw new Error('Rebuild Perfect Dark for native-flow diagnostics.');
            const text = pointer => {
                const heap = m.HEAPU8 || globalThis.HEAPU8;
                if (!heap || !pointer) return '';
                let end = pointer;
                while (end < heap.length && end - pointer < 512 && heap[end]) end++;
                return new TextDecoder().decode(heap.subarray(pointer, end)).trim();
            };
            const read = (field, slot = 0) => m._peakPdFlow(slot, field);
            return {root: read(0), arena: read(4), timeLimit: read(5), scoreLimit: read(6),
                seats: read(7), multiplayer: !!read(8), saveSpaces: read(12),
                menus: Array.from({length: this.players}, (_, slot) => ({
                    depth: read(1, slot), focused: read(2, slot), dimmed: !!read(3, slot), pause: read(9, slot),
                    title: text(m._peakPdMenuText(slot, 1)), item: text(m._peakPdMenuText(slot, 0))
                }))};
        }
        step(commands, authorityContext = null) {
            if (this.disposed) throw new Error('Perfect Dark engine is disposed.');
            if (authorityContext !== null && typeof authorityContext.emitEvent !== 'function')
                throw new Error('Invalid Perfect Dark authority event context.');
            if (!Array.isArray(commands) || commands.length !== this.players || Array.from(commands).some(c =>
                !c || Object.keys(c).length !== 5 || !int(c.buttons, 0, 2047) ||
                !int(c.moveX, -127, 127) || !int(c.moveY, -127, 127) || !int(c.lookX, -32767, 32767) || !int(c.lookY, -32767, 32767)))
                throw new Error('Invalid Perfect Dark command row.');
            const m = this.module, previous = m._peakPdTick();
            for (let slot = 0; slot < this.players; slot++) {
                const c = commands[slot];
                if (m._peakPdCommand(slot, c.buttons, c.moveX, c.moveY, c.lookX, c.lookY) !== 1)
                    throw new Error('Perfect Dark rejected an input transaction.');
            }
            const result = m._peakPdStep(), completed = m._peakPdTick();
            if (result !== 1 || completed !== previous + 1)
                throw new Error(`Perfect Dark tick incomplete: result=${result}, before=${previous}, after=${completed}.`);
            if (authorityContext) for (const event of this.drainEvents())
                authorityContext.emitEvent(event.type, {...event.data, engineTick: event.tick, engineEventId: event.id});
            return this.observe();
        }
        startCombat(stage, weapons = null) {
            if (this.disposed) throw new Error('Perfect Dark engine is disposed.');
            // Pinned browser port: NUM_MPWEAPONS is 49, six original MP slots.
            if (weapons !== null && (!Array.isArray(weapons) || weapons.length !== 6 ||
                Array.from(weapons).some(value => !int(value, 0, 48))))
                throw new Error('Invalid Perfect Dark weapon slots.');
            if (!int(stage, 0, 255) || (weapons === null ? this.module._peakPdStartCombat(stage) :
                this.module._peakPdStartCombatWeapons(stage, ...weapons)) !== 1)
                throw new Error('Perfect Dark rejected the arena transition.');
        }
        setPresentation(enabled) {
            if (this.disposed || typeof enabled !== 'boolean' || this.module._peakPdSetPresentation?.(Number(enabled)) !== 1)
                throw new Error('Perfect Dark rejected presentation mode.');
        }
        present() {
            if (this.disposed) throw new Error('Perfect Dark engine is disposed.');
            return this.module._peakPdPresent() === 1;
        }
        capturePlayerPoses() {
            const state = this.captureEntities(), observed = this.observe();
            return {schema: 'pd-player-poses-v1', epoch: state.meta.epoch, stage: state.meta.stage,
                players: state.meta.players.flatMap((entity, slot) => entity ? [{slot, entity,
                    position: [...state[`prop:${state.meta.epoch}:${entity}`].position],
                    rooms: [...state[`prop:${state.meta.epoch}:${entity}`].rooms],
                    yaw: observed.players[slot].yaw, pitch: observed.players[slot].pitch}] : [])};
        }
        // Narrow replica primitive. This does not restore velocities, inventory,
        // animation or world entities and must not implement restoreLocal.
        restorePlayerPoses(snapshot) { return this._restorePlayers(snapshot, false); }
        captureWalkingState() {
            const snapshot = this.capturePlayerPoses(), m = this.module;
            if (m._peakPdWalkVersion() !== 2 || m._peakPdWalkCount() !== 181)
                throw new Error('Unsupported Perfect Dark walking state version.');
            return {...snapshot, schema: 'pd-walking-v2', levelFrame: m._peakPdLevelFrame(),
                players: snapshot.players.map(p => {
                    const movement = Array.from({length: 181}, (_, field) => m._peakPdWalkField(p.slot, field));
                    if (movement.some(n => !Number.isFinite(n)))
                        throw new Error('Perfect Dark walking restore does not support this movement mode.');
                    return {...p, movement};
                })};
        }
        // Includes movement history and head animation, but not hand/weapon
        // animation, third-person body animation or world state.
        // Same-frame walking corrections only; not yet a prediction checkpoint.
        restoreWalkingState(snapshot) { return this._restorePlayers(snapshot, true); }
        captureInventoryState() {
            const snapshot = this.capturePlayerPoses(), m = this.module;
            return {...snapshot, schema: 'pd-inventory-v1', levelFrame: m._peakPdLevelFrame(),
                players: snapshot.players.map(p => {
                    const count = m._peakPdInventoryCount(p.slot);
                    if (!int(count, 0, 128)) throw new Error('Invalid Perfect Dark inventory list.');
                    const read = (index, length) => Array.from({length}, (_, field) => {
                        const n = m._peakPdInventoryField(p.slot, index, field);
                        if (!int(n, -0x80000000, 0xffffffff)) throw new Error('Invalid Perfect Dark inventory field.');
                        return n;
                    });
                    return {...p, inventory: {header: read(-1, 5), ammo: read(-2, 33),
                        items: Array.from({length: count}, (_, i) => read(i, 3))}};
                })};
        }
        // Preserves local weapon models and hand scripts; equipped weapons must
        // already match. World pickup visibility is a separate component.
        restoreInventoryState(snapshot) { return this._restorePlayers(snapshot, false, true); }
        captureWeaponState() {
            const snapshot = this.captureInventoryState(), m = this.module;
            if (m._peakPdWeaponVersion() !== 1 || m._peakPdWeaponCount() !== 123)
                throw new Error('Unsupported Perfect Dark weapon-state version.');
            return {...snapshot, schema: 'pd-weapons-v1', players: snapshot.players.map(p => ({...p,
                hands: [0, 1].map(hand => {
                    const read = field => {
                        const value = m._peakPdHandStateField(p.slot, hand, field);
                        if (!Number.isFinite(value)) throw new Error(`Perfect Dark weapon state is unavailable: slot ${p.slot}, hand ${hand}, field ${field}.`);
                        return value;
                    };
                    const header = Array.from({length: 6}, (_, i) => read(-i - 1));
                    if (header[4] < 0 || header[5] < 0) throw new Error('Unknown Perfect Dark weapon script.');
                    return {header, fields: header[1] ? Array.from({length: 123}, (_, i) => read(i)) : []};
                })}))};
        }
        restoreWeaponState(snapshot) { return this._restorePlayers(snapshot, false, true, true); }
        captureVitalsState() {
            const snapshot = this.capturePlayerPoses();
            return this._captureVitals({...snapshot, schema: 'pd-vitals-v1'});
        }
        _captureVitals(snapshot) {
            const m = this.module;
            if (m._peakPdVitalsVersion?.() !== 1) throw new Error('Rebuild Perfect Dark for health correction.');
            return {...snapshot, vitalsVersion: 1, tick: m._peakPdTick() >>> 0,
                players: snapshot.players.map(p => ({...p, vitals: Array.from({length:15}, (_,field)=>{
                    const value=m._peakPdVitalsField(p.slot,field);
                    if (!Number.isFinite(value)) throw new Error('Perfect Dark health correction requires living players.');
                    return value;
                })}))};
        }
        restoreVitalsState(snapshot) { return this._restorePlayers(snapshot, false, false, false, true); }
        capturePlayerState({vitals = false, random = false, smoke = false, grenades = false, grenadeRemovals = false, grenadeCreation = false} = {}) {
            if (grenadeCreation) grenadeRemovals = true;
            if (grenadeRemovals) grenades = true;
            if (grenades) smoke = true;
            if (smoke) random = true;
            const weapons = this.captureWeaponState(), walking = this.captureWalkingState();
            const snapshot = {...weapons, schema: 'pd-player-state-v1', players: weapons.players.map((p, i) =>
                ({...p, movement: walking.players[i].movement}))};
            if (random) {
                const m = this.module;
                if (typeof m._peakPdRandomWord !== 'function' || typeof m._peakPdSwayField !== 'function' ||
                    snapshot.players.length !== this.players)
                    throw new Error('Perfect Dark random correction requires all player seats and a current build.');
                snapshot.random = Array.from({length: 4}, (_, i) => m._peakPdRandomWord(i));
                if (snapshot.random.some(n => !int(n, 0, 0xffffffff))) throw new Error('Perfect Dark random state is unavailable.');
                snapshot.tick = m._peakPdTick() >>> 0;
                snapshot.players = snapshot.players.map(p => ({...p, sway: Array.from({length:145}, (_, i) => {
                    const value = m._peakPdSwayField(p.slot, i);
                    if (!Number.isFinite(value)) throw new Error('Perfect Dark sway state is unavailable.');
                    return value;
                })}));
                snapshot.schema = 'pd-player-random-v1';
            }
            if (smoke) {
                snapshot.smoke = this.captureSmokeState();
                snapshot.schema = 'pd-player-smoke-v2';
            }
            if (grenades) {
                snapshot.grenades = this.captureGrenadeState();
                snapshot.schema = grenadeRemovals ? 'pd-player-grenades-v2' : 'pd-player-grenades-v1';
            }
            if (grenadeCreation) {
                const m = this.module;
                if (typeof m._peakPdGrenadeBeginV3 !== 'function') throw new Error('Perfect Dark grenade creation requires a current build.');
                snapshot.schema = 'pd-player-grenades-v3';
                snapshot.allocation = Array.from({length:3}, (_,i)=>m._peakPdAllocationField(i));
                if (snapshot.allocation.some(n=>!int(n,0,0xfffffffe))) throw new Error('Perfect Dark allocation state is unavailable.');
                snapshot.grenades.sort((a,b)=>a.entity-b.entity);
                for (const g of snapshot.grenades) {
                    g.birth = Array.from({length:6},(_,i)=>m._peakPdGrenadeBirth(g.entity,i));
                    if (g.birth.some(n=>!Number.isFinite(n))) throw new Error('Perfect Dark grenade creation state is unavailable.');
                }
            }
            return vitals ? this._captureVitals(snapshot) : snapshot;
        }
        captureGrenadeState() {
            if (this.disposed) throw new Error('Perfect Dark engine is disposed.');
            const m = this.module, count = m._peakPdGrenadeCount?.();
            if (!int(count, 0, 32)) throw new Error('Perfect Dark grenade correction requires supported airborne grenades.');
            return Array.from({length: count}, (_, index) => {
                const entity = m._peakPdGrenadeId(index);
                const fields = Array.from({length:102}, (_, field) => m._peakPdGrenadeField(entity, field));
                if (!int(entity, 1, 0xfffffffe) || fields.some(n => !Number.isFinite(n))) throw new Error('Perfect Dark grenade state is unavailable.');
                return {entity, fields};
            });
        }
        // Read-only effect diagnostics remain available during death/weapon transitions.
        // Restoration still requires the validated combined player transaction.
        captureSmokeState() {
            if (this.disposed) throw new Error('Perfect Dark engine is disposed.');
            const m = this.module;
            if (typeof m._peakPdSmokeCapacity !== 'function' || typeof m._peakPdSmokeSource !== 'function') throw new Error('Perfect Dark smoke correction requires a current build.');
            const capacity = m._peakPdSmokeCapacity(), player = m._peakPdSmokePlayer();
            if (!int(capacity, 0, 32) || !int(player, 0, this.players - 1))
                throw new Error('Perfect Dark smoke correction requires active effects with supported sources.');
            const slots = Array.from({length: capacity}, (_, slot) => {
                if (m._peakPdSmokePresent(slot) === 0) return null;
                const fields = Array.from({length: 126}, (_, i) => m._peakPdSmokeField(slot, i));
                if (fields.some(n => !Number.isFinite(n))) throw new Error('Perfect Dark smoke state is unavailable.');
                return fields;
            });
            const order = [];
            for (let index = 0; index < 4096; index++) {
                const key = m._peakPdSmokeOrder(index);
                if (key === 0) break;
                if (!int(key, -capacity, 0xffffffff) || index === 4095) throw new Error('Perfect Dark smoke order is unavailable.');
                order.push(key);
            }
            const sources = slots.map((fields, slot) => fields === null ? 0 : m._peakPdSmokeSource(slot));
            if (sources.some(id => !int(id, 0, 0xfffffffe))) throw new Error('Perfect Dark smoke source is unavailable.');
            return {capacity, player, slots, order, sources};
        }
        // Optional player/RNG/effect checkpoints, not complete world/body restoration.
        restorePlayerState(snapshot) { return this._restorePlayers(snapshot, true, true, true); }
        _restorePlayers(snapshot, walking, inventory = false, weapons = false, vitalsOnly = false) {
            if (this.disposed) throw new Error('Perfect Dark engine is disposed.');
            const vitals = vitalsOnly || snapshot?.vitalsVersion !== undefined;
            if (vitals && (snapshot?.vitalsVersion !== 1 || this.module._peakPdVitalsVersion?.() !== 1 ||
                    !int(snapshot.tick,0,0xffffffff) || snapshot.tick !== (this.module._peakPdTick() >>> 0) ||
                    !Array.isArray(snapshot.players) || Array.from(snapshot.players).some(p=>
                        !p || !Array.isArray(p.vitals) || p.vitals.length!==15 || Array.from(p.vitals).some(n=>!Number.isFinite(n)))))
                throw new Error('Invalid Perfect Dark health correction.');
            const ids = new Set(), slots = new Set();
            const row = (a, length, low, high) => Array.isArray(a) && a.length === length &&
                Array.from(a).every(n => int(n, low, high));
            const grenadeCreation = weapons && walking && snapshot?.schema === 'pd-player-grenades-v3';
            const grenadeRemovals = grenadeCreation || (weapons && walking && snapshot?.schema === 'pd-player-grenades-v2');
            if (grenadeCreation && (!row(snapshot.allocation,3,0,0xfffffffe) ||
                ['_peakPdGrenadeBeginV3','_peakPdGrenadeBirthStage'].some(name=>typeof this.module[name]!=='function')))
                throw new Error('Invalid Perfect Dark allocation correction.');
            const grenades = grenadeRemovals || (weapons && walking && snapshot?.schema === 'pd-player-grenades-v1');
            const smokeV2 = grenades || (weapons && walking && snapshot?.schema === 'pd-player-smoke-v2');
            if (grenades && ((grenadeRemovals && typeof this.module._peakPdGrenadeBeginV2 !== 'function') || !Array.isArray(snapshot.grenades) || snapshot.grenades.length > 32 ||
                Array.from(snapshot.grenades).some(g => !g || (grenadeCreation && (!Array.isArray(g.birth) || g.birth.length!==6 || Array.from(g.birth).some(n=>!Number.isFinite(n)))) || !int(g.entity, 1, 0xfffffffe) || !Array.isArray(g.fields) ||
                    g.fields.length !== 102 || Array.from(g.fields).some(n => !Number.isFinite(n))) ||
                new Set(snapshot.grenades.map(g => g.entity)).size !== snapshot.grenades.length ||
                ['_peakPdGrenadeBegin', '_peakPdGrenadeStage'].some(name => typeof this.module[name] !== 'function')))
                throw new Error('Invalid Perfect Dark grenade correction.');
            const smoke = smokeV2 || (weapons && walking && snapshot?.schema === 'pd-player-smoke-v1');
            const random = smoke || (weapons && walking && snapshot?.schema === 'pd-player-random-v1');
            const effect = snapshot?.smoke;
            if (smoke && (!effect || (smokeV2 && (!row(effect.sources, effect.capacity, 0, 0xfffffffe) ||
                typeof this.module._peakPdSmokeBeginV2 !== 'function' || typeof this.module._peakPdSmokeSourceStage !== 'function')) || !int(effect.capacity, 0, 32) || !int(effect.player, 0, this.players - 1) ||
                !Array.isArray(effect.slots) || effect.slots.length !== effect.capacity ||
                Array.from(effect.slots).some(f => f !== null && (!Array.isArray(f) || f.length !== 126 || Array.from(f).some(n => !Number.isFinite(n)))) ||
                (smokeV2 && effect.slots.some((fields, slot) => fields === null && effect.sources[slot] !== 0)) ||
                !Array.isArray(effect.order) || !int(effect.order.length, 1, 4095) ||
                !row(effect.order, effect.order.length, -effect.capacity, 0xffffffff) || effect.order.includes(0) ||
                new Set(effect.order).size !== effect.order.length ||
                ['_peakPdSmokeBegin', '_peakPdSmokeStage', '_peakPdSmokeOrderStage'].some(name => typeof this.module[name] !== 'function')))
                throw new Error('Invalid Perfect Dark smoke correction.');
            if (snapshot?.schema !== (grenadeCreation ? 'pd-player-grenades-v3' : grenadeRemovals ? 'pd-player-grenades-v2' : grenades ? 'pd-player-grenades-v1' : smokeV2 ? 'pd-player-smoke-v2' : smoke ? 'pd-player-smoke-v1' : random ? 'pd-player-random-v1' : weapons ? (walking ? 'pd-player-state-v1' : 'pd-weapons-v1') : inventory ? 'pd-inventory-v1' : walking ? 'pd-walking-v2' : vitalsOnly ? 'pd-vitals-v1' : 'pd-player-poses-v1') || !int(snapshot.epoch, 1, 0xffffffff) ||
                (random && (!int(snapshot.tick, 0, 0xffffffff) || !row(snapshot.random, 4, 0, 0xffffffff) ||
                    !(snapshot.random[0] || snapshot.random[1]) || !(snapshot.random[2] || snapshot.random[3]) ||
                    snapshot.players?.length !== this.players || typeof this.module._peakPdRandomStage !== 'function' ||
                    typeof this.module._peakPdSwayStage !== 'function')) ||
                (weapons && (this.module._peakPdWeaponVersion() !== 1 || this.module._peakPdWeaponCount() !== 123)) ||
                (inventory && !int(snapshot.levelFrame, 0, 0x7fffffff)) ||
                (walking && (!int(snapshot.levelFrame, 0, 0x7fffffff) ||
                    this.module._peakPdWalkVersion() !== 2 || this.module._peakPdWalkCount() !== 181)) ||
                !int(snapshot.stage, 0, 255) || !Array.isArray(snapshot.players) ||
                !int(snapshot.players.length, 1, this.players) || Array.from(snapshot.players).some(p => {
                    if (!p || (random && (!Array.isArray(p.sway) || p.sway.length !== 145 || Array.from(p.sway).some(n=>!Number.isFinite(n)))) ||
                        (weapons && (!Array.isArray(p.hands) || p.hands.length !== 2 ||
                        Array.from(p.hands).some(h => !h || !row(h.header, 6, 0, 32767) ||
                            !int(h.header[0], 0, 93) || !int(h.header[1], 0, 1) ||
                            !int(h.header[4], 0, 2048) || !int(h.header[5], 0, 2048) ||
                            !Array.isArray(h.fields) || h.fields.length !== (h.header[1] ? 123 : 0) ||
                            Array.from(h.fields).some(n => !Number.isFinite(n))))) ||
                        (inventory && (!p.inventory || !row(p.inventory.header, 5, -1, 93) ||
                        !row(p.inventory.ammo, 33, 0, 1000000) || !Array.isArray(p.inventory.items) ||
                        !int(p.inventory.header[0], 0, 1) || !int(p.inventory.header[4], 0, 1) ||
                        p.inventory.items.length > 128 || Array.from(p.inventory.items).some(a =>
                            !row(a, 3, -32768, 0xffffffff) ||
                            !(a[0] === 1 ? int(a[1], 0, 93) && int(a[2], -32768, 32767) :
                              a[0] === 2 ? int(a[1], 1, 0xffffffff) && a[2] === 0 :
                              a[0] === 3 && int(a[1], 0, 93) && int(a[2], 0, 93))))) ||
                        (walking && (!Array.isArray(p.movement) || p.movement.length !== 181 ||
                        Array.from(p.movement).some(n => !Number.isFinite(n)))) ||
                        !int(p.slot, 0, this.players - 1) || !int(p.entity, 1, 0xffffffff) ||
                        ids.has(p.entity) || slots.has(p.slot) || !Array.isArray(p.position) || p.position.length !== 3 ||
                        Array.from(p.position).some(n => !Number.isFinite(n) || Math.abs(n) > 1e7) ||
                        !Number.isFinite(p.yaw) || p.yaw < 0 || Math.fround(p.yaw) >= 360 ||
                        !Number.isFinite(p.pitch) || p.pitch < -90 || p.pitch > 90 ||
                        !Array.isArray(p.rooms) || !int(p.rooms.length, 1, 7) ||
                        Array.from(p.rooms).some(n => !int(n, 0, 32767)) || new Set(p.rooms).size !== p.rooms.length) return true;
                    ids.add(p.entity); slots.add(p.slot); return false;
                })) throw new Error('Invalid Perfect Dark player poses.');
            const m = this.module;
            const begun = vitalsOnly ? m._peakPdVitalsBegin(snapshot.epoch,snapshot.stage,snapshot.players.length,snapshot.tick) : weapons && walking ? m._peakPdPlayerBegin(snapshot.epoch, snapshot.stage, snapshot.players.length, snapshot.levelFrame) :
                weapons ? m._peakPdWeaponBegin(snapshot.epoch, snapshot.stage, snapshot.players.length, snapshot.levelFrame) :
                inventory ? m._peakPdInventoryBegin(snapshot.epoch, snapshot.stage, snapshot.players.length, snapshot.levelFrame) :
                walking ? m._peakPdWalkBegin(snapshot.epoch, snapshot.stage, snapshot.players.length, snapshot.levelFrame) :
                m._peakPdPoseBegin(snapshot.epoch, snapshot.stage, snapshot.players.length);
            if (begun !== 1)
                throw new Error('Perfect Dark pose restore rejected its stage or transaction.');
            try {
                if (vitals && m._peakPdVitalsRequire(snapshot.tick) !== 1)
                    throw new Error('Perfect Dark health correction rejected its tick.');
                if (random && m._peakPdRandomStage(snapshot.tick, ...snapshot.random) !== 1)
                    throw new Error('Perfect Dark random correction rejected its tick or transaction.');
                if (smoke) {
                    if ((smokeV2 ? m._peakPdSmokeBeginV2 : m._peakPdSmokeBegin)(effect.capacity, effect.order.length, effect.player) !== 1)
                        throw new Error('Perfect Dark smoke correction rejected its pool or transaction.');
                    for (let slot = 0; slot < effect.capacity; slot++) if (effect.slots[slot] !== null)
                        for (let field = 0; field < 126; field++)
                            if (m._peakPdSmokeStage(slot, field, effect.slots[slot][field]) !== 1)
                                throw new Error(`Perfect Dark smoke correction rejected slot ${slot}, field ${field}, value ${effect.slots[slot][field]}.`);
                    if (smokeV2) for (let slot = 0; slot < effect.capacity; slot++)
                        if (effect.slots[slot] !== null && m._peakPdSmokeSourceStage(slot, effect.sources[slot]) !== 1)
                            throw new Error('Perfect Dark smoke correction rejected a source reference.');
                    for (let index = 0; index < effect.order.length; index++)
                        if (m._peakPdSmokeOrderStage(index, effect.order[index]) !== 1)
                            throw new Error('Perfect Dark smoke correction rejected its tick order.');
                }
                if (grenades) {
                    if ((grenadeCreation ? m._peakPdGrenadeBeginV3(snapshot.grenades.length,...snapshot.allocation) :
                        (grenadeRemovals ? m._peakPdGrenadeBeginV2 : m._peakPdGrenadeBegin)(snapshot.grenades.length)) !== 1) throw new Error('Perfect Dark grenade set changed.');
                    for (let index = 0; index < snapshot.grenades.length; index++) {
                        const g = snapshot.grenades[index];
                        if (grenadeCreation && m._peakPdGrenadeBirthStage(index,...g.birth)!==1) throw new Error('Perfect Dark grenade birth data rejected.');
                        for (let field = 0; field < g.fields.length; field++)
                            if (m._peakPdGrenadeStage(index, g.entity, field, g.fields[field]) !== 1)
                                throw new Error(`Perfect Dark grenade correction rejected entity ${g.entity}, field ${field}.`);
                    }
                }
                for (const p of snapshot.players) {
                    const rooms = [...p.rooms, ...Array(8 - p.rooms.length).fill(-1)];
                    if (m._peakPdPosePlayer(p.slot, p.entity, ...p.position, p.yaw, p.pitch, ...rooms) !== 1)
                        throw new Error('Perfect Dark pose restore rejected an entity or room.');
                    if (vitals) for (let field=0;field<15;field++)
                        if (m._peakPdVitalsStage(p.slot,field,p.vitals[field])!==1)
                            throw new Error(`Perfect Dark rejected health field ${field} for slot ${p.slot}.`);
                    if (random) for (let field=0;field<p.sway.length;field++)
                        if (m._peakPdSwayStage(p.slot, field, p.sway[field]) !== 1)
                            throw new Error('Perfect Dark random correction rejected weapon sway.');
                    if (walking) for (let field = 0; field < 181; ++field)
                        if (m._peakPdWalkStage(p.slot, field, p.movement[field]) !== 1)
                            throw new Error(`Perfect Dark rejected walking state: slot ${p.slot}, field ${field}, value ${p.movement[field]}.`);
                    if (inventory) {
                        const s = p.inventory;
                        if (m._peakPdInventoryHeader(p.slot, s.items.length, ...s.header) !== 1)
                            throw new Error('Perfect Dark inventory restore requires matching equipped weapons.');
                        for (let index = 0; index < s.items.length; ++index)
                            if (m._peakPdInventoryItem(p.slot, index, ...s.items[index]) !== 1)
                                throw new Error('Perfect Dark rejected an inventory item.');
                        for (let index = 0; index < 33; ++index)
                            if (m._peakPdInventoryAmmo(p.slot, index, s.ammo[index]) !== 1)
                                throw new Error('Perfect Dark rejected reserve ammunition.');
                    }
                    if (weapons) for (let hand = 0; hand < 2; ++hand) {
                        const h = p.hands[hand];
                        if (m._peakPdWeaponHeader(p.slot, hand, ...h.header) !== 1)
                            throw new Error('Perfect Dark rejected weapon assets or script identity.');
                        for (let field = 0; field < h.fields.length; ++field)
                            if (m._peakPdWeaponStage(p.slot, hand, field, h.fields[field]) !== 1)
                                throw new Error(`Perfect Dark rejected hand state: slot ${p.slot}, hand ${hand}, field ${field}, value ${h.fields[field]}.`);
                    }
                }
                if (m._peakPdPoseCommit() !== 1) throw new Error('Perfect Dark pose restore did not commit.');
            } finally { m._peakPdPoseCancel(); }
        }
        // Pointer-free base prop components for codec development. Deliberately
        // not named captureState: these do not include enough state to restore.
        captureEntities() {
            if (this.disposed) throw new Error('Perfect Dark engine is disposed.');
            const m = this.module, epoch = m._peakPdEntityEpoch() >>> 0;
            const capacity = m._peakPdEntityCapacity();
            if (!int(capacity, 0, 65536)) throw new Error('Invalid Perfect Dark entity capacity.');
            const state = {meta: {schema: 'pd-props-v1', epoch, stage: m._peakPdStage(),
                players: Array.from({length: this.players}, (_, slot) => m._peakPdPlayerEntity(slot) >>> 0)}};
            const ids = new Set();
            for (let index = 0; index < capacity; index++) {
                const id = m._peakPdEntityId(index) >>> 0;
                if (!id) continue;
                if (ids.has(id)) throw new Error('Duplicate Perfect Dark entity identity.');
                ids.add(id);
                const read = field => m._peakPdEntityField(index, field);
                const record = {type: read(0), enabled: read(1), position: [read(2), read(3), read(4)],
                    regen: read(5), active: read(6), rooms: []};
                for (let room = 0; room < 8; room++) {
                    const value = read(7 + room);
                    if (value === -1) break;
                    if (!int(value, 0, 32767)) throw new Error('Invalid Perfect Dark entity room.');
                    record.rooms.push(value);
                }
                if (!int(record.type, 0, 255) || !int(record.enabled, 0, 1) || !int(record.active, 0, 1) ||
                    !int(record.regen, -32768, 32767) || !record.position.every(Number.isFinite))
                    throw new Error('Invalid Perfect Dark entity component.');
                state[`prop:${epoch}:${id}`] = record;
            }
            if (state.meta.players.some(id => id && !ids.has(id))) throw new Error('Missing Perfect Dark player entity.');
            return state;
        }
        // Incremental component development; still NOT a complete captureState
        // or restoreLocal implementation for the authoritative backend.
        captureComponents() {
            if (this.disposed) throw new Error('Perfect Dark engine is disposed.');
            const m = this.module;
            if (m._peakPdComponentVersion() !== 2) throw new Error('Perfect Dark component version mismatch.');
            const state = this.captureEntities(), epoch = state.meta.epoch;
            state.meta.schema = 'pd-components-v2';
            const checkReference = id => {
                if (!int(id, 0, 0xffffffff) || (id && !Object.hasOwn(state, `prop:${epoch}:${id}`)))
                    throw new Error('Invalid Perfect Dark component entity reference.');
            };
            for (let index = 0; index < m._peakPdEntityCapacity(); index++) {
                const id = m._peakPdEntityId(index) >>> 0;
                if (!id) continue;
                const kind = m._peakPdObjectKind(index);
                if (!int(kind, 0, 7) || (kind && !(kind & 1))) throw new Error('Invalid Perfect Dark object kind.');
                if (!kind) continue;
                const object = readFields(objectFields, field => m._peakPdObjectField(index, field), objectIntegers);
                object.rotation = Array.from({length: 9}, (_, field) => m._peakPdObjectField(index, field + 10));
                if (!object.rotation.every(Number.isFinite)) throw new Error('Invalid Perfect Dark object rotation.');
                state[`object:${epoch}:${id}`] = object;
                if (kind & 2) {
                    const weapon = readFields(weaponFields, field => m._peakPdWeaponField(index, field), weaponIntegers);
                    checkReference(weapon.dualEntity);
                    state[`weapon:${epoch}:${id}`] = weapon;
                }
                if (kind & 4) {
                    const projectile = readFields(projectileFields, field => m._peakPdProjectileField(index, field), projectileIntegers);
                    for (const key of ['owner', 'target', 'pickupBy']) checkReference(projectile[key]);
                    state[`projectile:${epoch}:${id}`] = projectile;
                }
            }
            for (let slot = 0; slot < this.players; slot++) {
                const id = state.meta.players[slot];
                if (!id) continue;
                const player = readFields(playerFields, field => m._peakPdPlayerField(slot, field), playerIntegers);
                player.slot = slot;
                player.ammo = Array.from({length: 33}, (_, index) => m._peakPdPlayerField(slot, 100 + index));
                if (!player.ammo.every(value => int(value, -0x80000000, 0x7fffffff)))
                    throw new Error('Invalid Perfect Dark reserve ammo.');
                state[`player:${epoch}:${id}`] = player;
                for (let hand = 0; hand < 2; hand++)
                    state[`hand:${epoch}:${id}:${hand}`] = readFields(handFields,
                        field => m._peakPdHandField(slot, hand, field), handIntegers);
            }
            return state;
        }
        drainEvents() {
            if (this.disposed) throw new Error('Perfect Dark engine is disposed.');
            const m = this.module, epoch = m._peakPdEntityEpoch() >>> 0;
            const count = m._peakPdEventCount(), types = [null, 'shot', 'pickup', 'death', 'respawn', 'explosion', 'shot', 'shot'];
            if (!int(count, 0, 256)) throw new Error('Invalid Perfect Dark event outbox.');
            const events = [];
            for (let index = 0; index < count; index++) {
                const row = Array.from({length: 11}, (_, field) => m._peakPdEventField(index, field));
                const [id, tick, type, slot, entity, detail, hand, quantity, x, y, z] = row;
                if (!int(id, 1, 0xffffffff) || (index && id !== events[index - 1].id + 1) ||
                    !int(tick, 0, 0xffffffff) || !int(type, 1, 7) || !int(slot, -1, 255) ||
                    !int(entity, 1, 0xffffffff) || !int(detail, -1, 0xffffffff) ||
                    !int(hand, -1, 1) || !int(quantity, 1, 65535) || ![x, y, z].every(Number.isFinite))
                    throw new Error('Invalid Perfect Dark gameplay event.');
                const data = {epoch, slot, entity, detail, hand, count: quantity, position: [x, y, z]};
                if (type === 1 || type === 6 || type === 7)
                    data.attack = type === 6 ? 'melee' : type === 7 ? 'throw' : 'firearm';
                events.push({id, tick, type: types[type], data});
            }
            // Only acknowledge after the complete batch is copied and validated.
            if (count && m._peakPdEventAck(epoch, events[count - 1].id) !== 1)
                throw new Error('Perfect Dark event acknowledgement rejected.');
            return events;
        }
        observe() {
            if (this.disposed) throw new Error('Perfect Dark engine is disposed.');
            const m = this.module;
            return {tick: m._peakPdTick(), stage: m._peakPdStage(), delta240: m._peakPdDelta240(),
                players: Array.from({length: this.players}, (_, slot) => {
                    const read = field => m._peakPdObserve(slot, field);
                    return {position: [read(0), read(1), read(2)], yaw: read(3), pitch: read(4), health: read(5), dead: !!read(6)};
                })};
        }
        destroy() { this.disposed = true; } // Frame/iframe owner releases the WASM heap.
    }
    return {PerfectDarkEngine, perfectDarkActions: actions};
});
