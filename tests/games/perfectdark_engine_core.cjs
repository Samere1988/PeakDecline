const assert = require('node:assert/strict');
const {PerfectDarkEngine, perfectDarkActions} = require('../../static/js/netplay/perfectdark_engine.js');
let tick = 0, commands = [], calls = 0;
const moduleMock = {
    _peakPdReady: () => 1, _peakPdTick: () => tick, _peakPdStage: () => 90,
    _peakPdStartCombat: stage => stage === 37 ? 1 : 0,
    _peakPdDelta240: () => 4, _peakPdObserve: () => 0,
    _peakPdCommand: (...args) => { commands.push(args); return 1; },
    _peakPdStep: () => { tick++; calls++; return 1; }
};
const engine = new PerfectDarkEngine(moduleMock, 2);
let ids = [11, 0, 12], epoch = 3;
Object.assign(moduleMock, {
    _peakPdEntityEpoch: () => epoch, _peakPdEntityCapacity: () => ids.length,
    _peakPdEntityId: index => ids[index], _peakPdPlayerEntity: slot => slot ? 0 : ids[0],
    _peakPdEntityField: (index, field) => [1, 1, index * 10, 0, 0, 0, 1, 4, -1][field] ?? -1
});
const first = engine.captureEntities();
assert.deepEqual(Object.keys(first), ['meta', 'prop:3:11', 'prop:3:12']);
assert.deepEqual(first['prop:3:11'].rooms, [4]);
ids[0] = 13; // Same native slot, different lifetime.
assert.equal(engine.captureEntities()['prop:3:11'], undefined);
assert.ok(engine.captureEntities()['prop:3:13']);
assert.ok(first['prop:3:11'], 'Captures must not mutate earlier baselines.');
epoch = 4;
assert.ok(engine.captureEntities()['prop:4:13']);
ids[2] = 13;
assert.throws(() => engine.captureEntities(), /Duplicate/);
ids[2] = 14;
Object.assign(moduleMock, {
    _peakPdComponentVersion: () => 2,
    _peakPdObjectKind: index => index === 2 ? 7 : 0,
    _peakPdObjectField: () => 0,
    _peakPdWeaponField: () => 0,
    _peakPdProjectileField: (index, field) => field === 4 ? ids[0] : 0,
    _peakPdPlayerField: (slot, field) => field >= 100 ? field - 100 : 0,
    _peakPdHandField: (slot, hand, field) => field === 11 ? 6 - hand : 0
});
const components = engine.captureComponents();
assert.equal(components.meta.schema, 'pd-components-v2');
assert.equal(components['projectile:4:14'].owner, 13);
assert.equal(components['object:4:14'].rotation.length, 9);
assert.ok(components['weapon:4:14']);
moduleMock._peakPdProjectileField = (index, field) => field === 4 ? 999 : 0;
assert.throws(() => engine.captureComponents(), /entity reference/);
moduleMock._peakPdProjectileField = (index, field) => field === 4 ? ids[0] : 0;
assert.equal(components['player:4:13'].ammo.length, 33);
assert.equal(components['player:4:13'].ammo[32], 32);
assert.equal(components['hand:4:13:0'].loaded0, 6);
assert.equal(components['hand:4:13:1'].loaded0, 5);
assert.equal(Object.keys(components).filter(key => key.startsWith('player:')).length, 1,
    'Unallocated seats must not become phantom players.');
moduleMock._peakPdComponentVersion = () => 3;
assert.throws(() => engine.captureComponents(), /version mismatch/);
moduleMock._peakPdComponentVersion = () => 2;
moduleMock._peakPdObjectField = () => NaN;
assert.throws(() => engine.captureComponents(), /component field/);
moduleMock._peakPdObjectField = () => 0;
moduleMock._peakPdHandField = () => Infinity;
assert.throws(() => engine.captureComponents(), /component field/);
moduleMock._peakPdHandField = () => 0;
moduleMock._peakPdPlayerField = (slot, field) => field >= 100 ? 0.5 : 0;
assert.throws(() => engine.captureComponents(), /reserve ammo/);
moduleMock._peakPdEntityField = () => NaN;
assert.throws(() => engine.captureEntities(), /Invalid/);
assert.throws(() => engine.startCombat(90), /rejected/);
engine.startCombat(37);
let weaponLaunches = 0;
moduleMock._peakPdStartCombatWeapons = (stage, ...weapons) => {
    weaponLaunches++;
    assert.equal(stage, 37); assert.deepEqual(weapons, [1, 1, 1, 1, 1, 1]); return 1;
};
assert.throws(() => engine.startCombat(37, [1, 1, 1, 1, 1, 49]), /weapon slots/);
assert.throws(() => engine.startCombat(37, new Array(6)), /weapon slots/);
assert.throws(() => engine.startCombat(37, [1]), /weapon slots/);
assert.equal(weaponLaunches, 0, 'Validate all six weapon slots before native mutation.');
engine.startCombat(37, [1, 1, 1, 1, 1, 1]);
assert.equal(weaponLaunches, 1);
const neutral = {buttons: 0, moveX: 0, moveY: 0, lookX: 0, lookY: 0};
assert.throws(() => engine.step([neutral, {...neutral, lookX: NaN}]), /Invalid/);
assert.throws(() => engine.step([neutral, {...neutral, buttons: 2048}]), /Invalid/);
assert.throws(() => engine.step([neutral, ,]), /Invalid/);
assert.equal(commands.length, 0, 'Validate the entire row before any native input mutation.');
assert.throws(() => engine.step([neutral]), /Invalid/);
const result = engine.step([neutral, {...neutral, buttons: perfectDarkActions.fire.bit, moveY: 127}]);
assert.equal(result.tick, 1); assert.equal(calls, 1);
assert.deepEqual(commands, [[0, 0, 0, 0, 0, 0], [1, 1, 0, 127, 0, 0]]);
moduleMock._peakPdStep = () => 0;
assert.throws(() => engine.step([neutral, neutral]), /tick incomplete/);
let eventRows = [[1, 30, 1, 0, 13, 2, 0, 1, 10, 20, 30]], acknowledged = 0;
Object.assign(moduleMock, {
    _peakPdEventCount: () => eventRows.length,
    _peakPdEventField: (index, field) => eventRows[index][field],
    _peakPdEventAck: (receivedEpoch, id) => {
        assert.equal(receivedEpoch, epoch); assert.equal(id, 1);
        acknowledged++; eventRows = []; return 1;
    }
});
const badRows = structuredClone(eventRows); badRows[0][8] = NaN;
const validRows = eventRows; eventRows = badRows;
assert.throws(() => engine.drainEvents(), /gameplay event/);
assert.equal(acknowledged, 0, 'Invalid batches must remain unacknowledged.');
eventRows = validRows;
assert.equal(engine.drainEvents()[0].type, 'shot');
assert.equal(acknowledged, 1);
assert.deepEqual(engine.drainEvents(), []);
for (const [nativeType, attack] of [[1, 'firearm'], [6, 'melee'], [7, 'throw']]) {
    eventRows = [[1, 31, nativeType, 0, 13, 1, 0, 1, 10, 20, 30]];
    const event = engine.drainEvents()[0];
    assert.equal(event.type, 'shot'); assert.equal(event.data.attack, attack);
}
moduleMock._peakPdPresent = () => 1;
assert.equal(engine.present(), true);
moduleMock._peakPdPresent = () => 0;
assert.equal(engine.present(), false);
let poseBegins = 0, poseCommits = 0, poseCancels = 0, poseRows = [];
Object.assign(moduleMock, {
    _peakPdPoseBegin: () => {poseBegins++; return 1;},
    _peakPdPosePlayer: (...row) => {poseRows.push(row); return row[0] === 0 ? 1 : 0;},
    _peakPdPoseCommit: () => {poseCommits++; return 1;},
    _peakPdPoseCancel: () => {poseCancels++;}
});
const pose = {slot: 0, entity: 13, position: [1, 2, 3], yaw: 90, pitch: -15, rooms: [4]};
const poseSnapshot = {schema: 'pd-player-poses-v1', epoch: 4, stage: 37, players: [pose]};
for (const bad of [undefined, {...poseSnapshot, players: new Array(1)},
    {...poseSnapshot, players: [{...pose, position: [1, , 3]}]},
    {...poseSnapshot, players: [{...pose, yaw: 359.9999999}]},
    {...poseSnapshot, players: [{...pose, rooms: [4, 4]}]},
    {...poseSnapshot, players: [pose, pose]}]) assert.throws(() => engine.restorePlayerPoses(bad), /Invalid/);
assert.equal(poseBegins, 0, 'Malformed pose batches must not begin a native transaction.');
engine.restorePlayerPoses(poseSnapshot);
assert.deepEqual(poseRows[0], [0, 13, 1, 2, 3, 90, -15, 4, -1, -1, -1, -1, -1, -1, -1]);
assert.equal(poseCommits, 1); assert.equal(poseCancels, 1);
assert.throws(() => engine.restorePlayerPoses({...poseSnapshot, players: [pose, {...pose, slot: 1, entity: 14}]}), /entity or room/);
assert.equal(poseCommits, 1, 'A failed second row must not commit the first row.');
assert.equal(poseCancels, 2, 'Native rejection must release transaction state.');
let walkBegins = 0, inventoryBegins = 0, walkFields = 0, ammoFields = 0;
Object.assign(moduleMock, {
    _peakPdWalkVersion: () => 2, _peakPdWalkCount: () => 181,
    _peakPdWalkBegin: () => {walkBegins++; return 1;},
    _peakPdWalkStage: () => {walkFields++; return 1;},
    _peakPdInventoryBegin: () => {inventoryBegins++; return 1;},
    _peakPdInventoryHeader: () => 1, _peakPdInventoryItem: () => 1,
    _peakPdInventoryAmmo: () => {ammoFields++; return 1;}
});
const walking = {...poseSnapshot, schema: 'pd-walking-v2', levelFrame: 10,
    players: [{...pose, movement: Array(181).fill(0)}]};
assert.throws(() => engine.restoreWalkingState({...walking, players: [{...walking.players[0], movement: new Array(181)}]}), /Invalid/);
assert.equal(walkBegins, 0);
engine.restoreWalkingState(walking); assert.equal(walkFields, 181);
const inventory = {...poseSnapshot, schema: 'pd-inventory-v1', levelFrame: 10,
    players: [{...pose, inventory: {header: [0, 1, 1, -1, 0], ammo: Array(33).fill(0), items: [[1, 1, -1]]}}]};
for (const items of [new Array(1), [[1, 1, 0xffffffff]], [[3, 1, -1]], [[2, 0, 0]], [[4, 1, 0]]])
    assert.throws(() => engine.restoreInventoryState({...inventory, players: [{...pose, inventory: {...inventory.players[0].inventory, items}}]}), /Invalid/);
assert.equal(inventoryBegins, 0);
engine.restoreInventoryState(inventory); assert.equal(ammoFields, 33);
const committed = poseCommits, cancelled = poseCancels;
moduleMock._peakPdInventoryAmmo = () => 0;
assert.throws(() => engine.restoreInventoryState(inventory), /reserve ammunition/);
assert.equal(poseCommits, committed); assert.equal(poseCancels, cancelled + 1);
let weaponBegins = 0, weaponFields = 0;
Object.assign(moduleMock, {
    _peakPdWeaponVersion: () => 1, _peakPdWeaponCount: () => 123,
    _peakPdWeaponBegin: () => {weaponBegins++; return 1;},
    _peakPdPlayerBegin: () => {weaponBegins++; return 1;},
    _peakPdWeaponHeader: () => 1, _peakPdWeaponStage: () => {weaponFields++; return 1;},
    _peakPdInventoryAmmo: () => 1
});
const hand = {header: [1, 1, 0, 0, 1, 1], fields: Array(123).fill(0)};
const weapons = {...inventory, schema: 'pd-weapons-v1', players: [{...inventory.players[0],
    hands: [hand, {header: [0, 0, 0, 0, 0, 0], fields: []}]}]};
for (const hands of [new Array(2), [{...hand, fields: new Array(123)}, hand],
    [{...hand, header: [1, 1, 0, 0, -1, 1]}, hand]])
    assert.throws(() => engine.restoreWeaponState({...weapons, players: [{...weapons.players[0], hands}]}), /Invalid/);
assert.equal(weaponBegins, 0);
engine.restoreWeaponState(weapons); assert.equal(weaponFields, 123);
const combined = {...weapons, schema: 'pd-player-state-v1', players: [{...weapons.players[0], movement: Array(181).fill(0)}]};
engine.restorePlayerState(combined); assert.equal(weaponFields, 246); assert.equal(walkFields, 362);
const beforeWeaponCommit = poseCommits, beforeWeaponCancel = poseCancels;
moduleMock._peakPdWeaponStage = () => 0;
assert.throws(() => engine.restorePlayerState(combined), /hand state/);
assert.equal(poseCommits, beforeWeaponCommit); assert.equal(poseCancels, beforeWeaponCancel + 1);
const randomSnapshot = {...combined, schema:'pd-player-random-v1', tick:10,
    random:[0xffffffff,0xabcdef01,0x81280783,0xab8d9f77],
    players:[{...combined.players[0],sway:Array(145).fill(0)}, {...combined.players[0],slot:1,entity:1234,sway:Array(145).fill(0)}]};
let randomCalls=[];
moduleMock._peakPdRandomStage=(...words)=>{randomCalls.push(words);return 1;};
moduleMock._peakPdWeaponStage=()=>1;
moduleMock._peakPdPosePlayer=()=>1;
moduleMock._peakPdSwayStage=()=>1;
const beginsBeforeRandom=weaponBegins;
for(const random of [new Array(4),[0,0,1,1],[1,1,0,0],[NaN,1,1,1],[-1,1,1,1],[1,4294967296,1,1],[0.5,1,1,1]])
    assert.throws(()=>engine.restorePlayerState({...randomSnapshot,random}),/Invalid/);
assert.throws(()=>engine.restorePlayerState({...randomSnapshot,players:[randomSnapshot.players[0]]}),/Invalid/);
for (const sway of [new Array(145), Array(144).fill(0), [...Array(144).fill(0), NaN]])
    assert.throws(() => engine.restorePlayerState({...randomSnapshot,
        players: [{...randomSnapshot.players[0], sway}, randomSnapshot.players[1]]}), /Invalid/);
const stageSway = moduleMock._peakPdSwayStage;
delete moduleMock._peakPdSwayStage;
assert.throws(() => engine.restorePlayerState(randomSnapshot), /Invalid/);
moduleMock._peakPdSwayStage = stageSway;
assert.equal(weaponBegins,beginsBeforeRandom,'Malformed RNG payloads must fail before native mutation');
engine.restorePlayerState(randomSnapshot);
assert.deepEqual(randomCalls,[[10,...randomSnapshot.random]],'64-bit streams must retain both unsigned words');
const rngCommits=poseCommits,rngCancels=poseCancels;
moduleMock._peakPdRandomStage=()=>0;
assert.throws(()=>engine.restorePlayerState(randomSnapshot),/random correction/);
assert.equal(poseCommits,rngCommits);assert.equal(poseCancels,rngCancels+1);
const smokeSnapshot = {...randomSnapshot, schema: 'pd-player-smoke-v1',
    smoke: {capacity: 2, player: 0, slots: [Array(126).fill(0), null], order: [1234, -1]}};
moduleMock._peakPdRandomStage = () => 1;
let smokeFields = 0, smokeOrders = [];
moduleMock._peakPdSmokeBegin = () => 1;
moduleMock._peakPdSmokeStage = () => { smokeFields++; return 1; };
moduleMock._peakPdSmokeOrderStage = (index, key) => { smokeOrders.push([index, key]); return 1; };
for (const smoke of [null, {...smokeSnapshot.smoke, slots: new Array(2)},
    {...smokeSnapshot.smoke, order: [1234, 1234]}, {...smokeSnapshot.smoke, order: [-3]},
    {...smokeSnapshot.smoke, player: 2}, {...smokeSnapshot.smoke, slots: [Array(125).fill(0), null]}])
    assert.throws(() => engine.restorePlayerState({...smokeSnapshot, smoke}), /Invalid/);
assert.equal(smokeFields, 0);
engine.restorePlayerState(smokeSnapshot);
assert.equal(smokeFields, 126);
assert.deepEqual(smokeOrders, [[0, 1234], [1, -1]]);
const smokeCommits = poseCommits, smokeCancels = poseCancels;
moduleMock._peakPdSmokeOrderStage = () => 0;
assert.throws(() => engine.restorePlayerState(smokeSnapshot), /smoke correction/);
assert.equal(poseCommits, smokeCommits); assert.equal(poseCancels, smokeCancels + 1);
const linkedSmoke = {...smokeSnapshot, schema: 'pd-player-smoke-v2',
    smoke: {...smokeSnapshot.smoke, sources: [1234, 0]}};
let sourceCalls = [];
moduleMock._peakPdSmokeBeginV2 = () => 1;
moduleMock._peakPdSmokeSourceStage = (...args) => { sourceCalls.push(args); return 1; };
moduleMock._peakPdSmokeOrderStage = () => 1;
for (const sources of [new Array(2), [1234], [-1, 0], [1.5, 0], [0xffffffff, 0], [1234, 2]])
    assert.throws(() => engine.restorePlayerState({...linkedSmoke, smoke: {...linkedSmoke.smoke, sources}}), /Invalid/);
assert.deepEqual(sourceCalls, []);
engine.restorePlayerState(linkedSmoke);
assert.deepEqual(sourceCalls, [[0, 1234]]);
const sourceCommits = poseCommits, sourceCancels = poseCancels;
moduleMock._peakPdSmokeSourceStage = () => 0;
assert.throws(() => engine.restorePlayerState(linkedSmoke), /source reference/);
assert.equal(poseCommits, sourceCommits); assert.equal(poseCancels, sourceCancels + 1);
moduleMock._peakPdSmokeSourceStage = () => 1;
const grenadeSnapshot = {...linkedSmoke, schema: 'pd-player-grenades-v1', grenades: [{entity:14, fields:Array(102).fill(0)}]};
let grenadeCalls=0;
moduleMock._peakPdGrenadeBegin = () => 1;
moduleMock._peakPdGrenadeStage = () => { grenadeCalls++; return 1; };
for (const grenades of [null, new Array(1), [null], [{entity:0,fields:Array(102).fill(0)}],
    [grenadeSnapshot.grenades[0],grenadeSnapshot.grenades[0]], [{entity:14,fields:new Array(102)}],
    [{entity:14,fields:Array(101).fill(0)}], [{entity:14,fields:Array(102).fill(NaN)}]])
    assert.throws(()=>engine.restorePlayerState({...grenadeSnapshot,grenades}),/Invalid/);
assert.equal(grenadeCalls,0);
engine.restorePlayerState(grenadeSnapshot);assert.equal(grenadeCalls,102);
const grenadeCommits=poseCommits,grenadeCancels=poseCancels;
moduleMock._peakPdGrenadeStage = () => 0;
assert.throws(()=>engine.restorePlayerState(grenadeSnapshot),/grenade correction/);
assert.equal(poseCommits,grenadeCommits);assert.equal(poseCancels,grenadeCancels+1);
const removalSnapshot = {...grenadeSnapshot, schema: 'pd-player-grenades-v2', grenades: []};
assert.throws(()=>engine.restorePlayerState(removalSnapshot),/Invalid/);
let removalBegins=[];
moduleMock._peakPdGrenadeBeginV2 = count => { removalBegins.push(count); return 1; };
moduleMock._peakPdGrenadeStage = () => 1;
engine.restorePlayerState(removalSnapshot);
assert.deepEqual(removalBegins,[0]);
moduleMock._peakPdGrenadeBeginV2 = () => 0;
const removalCommits=poseCommits,removalCancels=poseCancels;
assert.throws(()=>engine.restorePlayerState(removalSnapshot),/grenade set/);
assert.equal(poseCommits,removalCommits);assert.equal(poseCancels,removalCancels+1);
const creationSnapshot = {...grenadeSnapshot, schema:'pd-player-grenades-v3', allocation:[31,3,2],
    grenades:[{...grenadeSnapshot.grenades[0],birth:[12,0,-1,0.1,1,-1]}]};
assert.throws(()=>engine.restorePlayerState(creationSnapshot),/Invalid/);
let creationBegins=[],birthCalls=[];
moduleMock._peakPdGrenadeBeginV3 = (...args)=>{creationBegins.push(args);return 1;};
moduleMock._peakPdGrenadeBirthStage = (...args)=>{birthCalls.push(args);return 1;};
for(const allocation of [undefined,[],new Array(3),[-1,0,0],[0xffffffff,0,0],[31,0.5,0]])
    assert.throws(()=>engine.restorePlayerState({...creationSnapshot,allocation}),/Invalid/);
for(const birth of [undefined,new Array(6),[0],Array(6).fill(Infinity)])
    assert.throws(()=>engine.restorePlayerState({...creationSnapshot,grenades:[{...creationSnapshot.grenades[0],birth}]}),/Invalid/);
assert.deepEqual(creationBegins,[]);
engine.restorePlayerState(creationSnapshot);
assert.deepEqual(creationBegins,[[1,31,3,2]]);
assert.deepEqual(birthCalls,[[0,12,0,-1,0.1,1,-1]]);
const creationCommits=poseCommits,creationCancels=poseCancels;
moduleMock._peakPdGrenadeBirthStage=()=>0;
assert.throws(()=>engine.restorePlayerState(creationSnapshot),/birth data/);
assert.equal(poseCommits,creationCommits);assert.equal(poseCancels,creationCancels+1);
moduleMock._peakPdGrenadeCount = () => -1;
assert.throws(()=>engine.captureGrenadeState(),/supported airborne/);
engine.destroy(); assert.throws(() => engine.step([neutral, neutral]), /disposed/);
assert.throws(() => engine.captureSmokeState(), /disposed/);
assert.throws(() => engine.captureGrenadeState(), /disposed/);
assert.throws(() => engine.present(), /disposed/);
assert.throws(() => engine.restorePlayerPoses(poseSnapshot), /disposed/);
assert.throws(() => engine.restoreWalkingState(walking), /disposed/);
assert.throws(() => engine.restoreInventoryState(inventory), /disposed/);
assert.throws(() => engine.restoreWeaponState(weapons), /disposed/);
assert.throws(() => engine.restorePlayerState(combined), /disposed/);
console.log('Perfect Dark command transactions, action bits, completion checks and lifecycle passed.');
