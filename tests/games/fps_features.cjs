const assert = require('node:assert/strict');
const {SnapshotCodec, GameplayEvents, ReplicationSchedule} = require('../../static/js/netplay/authoritative.js');
const {FpsInput} = require('../../static/js/netplay/fps_input.js');
const encoder = new SnapshotCodec(), decoder = new SnapshotCodec();
const world = Object.fromEntries(Array.from({length: 300}, (_, i) => [`entity${i}`, {x: i, health: 100, model: 'guard', animation: 1}]));
let total = 0, full = 0;
for (let tick = 0; tick < 180; tick++) {
    world.entity0.x++;
    if (tick === 25) delete world.entity299;
    const snapshot = {tick, acks: [tick], state: structuredClone(world)};
    const packet = encoder.encode(snapshot);
    total += JSON.stringify(packet).length; full += JSON.stringify(snapshot).length;
    assert.deepEqual(decoder.decode(packet).state, world);
}
assert.ok(total < full / 10, `${total}/${full}`);
assert.throws(() => new SnapshotCodec().decode({tick: 2, baseTick: 1, changed: {}, removed: []}), /baseline/);
assert.throws(() => encoder.encode({tick: 200, state: {large: 'x'.repeat(65536)}}), /64 KiB/);
const schedule = new ReplicationSchedule(key => key === 'cosmetic' ? 10 : 1);
assert.deepEqual(schedule.select({player: 0, cosmetic: 0}, 0), {player: 0, cosmetic: 0});
assert.deepEqual(schedule.select({player: 1, cosmetic: 1}, 1), {player: 1, cosmetic: 0});
assert.deepEqual(schedule.select({player: 10, cosmetic: 10}, 10), {player: 10, cosmetic: 10});
assert.deepEqual(schedule.select({player: 11}, 11), {player: 11});
const effects = [], events = new GameplayEvents((e, c) => effects.push([e, c]));
events.predict(0, 1, 'muzzle', 'shot', {}, false);
events.predict(0, 1, 'muzzle', 'shot', {}, true);
const confirmed = {id: 1, tick: 1, type: 'shot', data: {}, prediction: '0:1:muzzle'};
events.receive([confirmed]); events.receive([confirmed]);
assert.equal(effects.length, 2); assert.equal(effects[1][1].confirmedPrediction, true);
assert.throws(() => events.receive([{id: 3}]), /gap/);
class Target extends EventTarget {}
const doc = new Target(), element = new Target();
doc.defaultView = new Target(); doc.hasFocus = () => true; doc.hidden = false; doc.pointerLockElement = element;
element.ownerDocument = doc; doc.exitPointerLock = () => {doc.pointerLockElement = null;};
let pad = {axes: [-1, 0, 1, 0], buttons: []};
const input = new FpsInput({element, getGamepads: () => [pad]});
function emit(target, type, fields = {}) {const event = new Event(type); Object.assign(event, fields); target.dispatchEvent(event);}
emit(doc, 'mousemove', {movementX: 100, movementY: 50});
const first = input.sampleInput(), second = input.sampleInput();
assert.equal(first.moveX, -127); assert.ok(first.lookX > second.lookX); assert.equal(second.lookY, 0);
pad = null; emit(doc, 'keydown', {code: 'KeyW'}); assert.equal(input.sampleInput().moveY, 127);
emit(doc.defaultView, 'blur'); assert.equal(input.sampleInput().moveY, 0);
input.destroy(); emit(doc, 'keydown', {code: 'KeyW'}); assert.equal(input.sampleInput().moveY, 0);
console.log(`FPS input, prediction events, priorities and 300-entity deltas passed (${Math.round(100 * total / full)}% of full snapshot bytes).`);

// A busy world still round-trips when every entity changes; deltas must not
// inflate it beyond the full packet or silently discard authoritative records.
for (const entity of Object.values(world)) { entity.x += 100; entity.health = 50; }
const dense = {tick: 180, acks: [180], state: world};
const densePacket = encoder.encode(dense);
assert.ok(JSON.stringify(densePacket).length <= JSON.stringify(dense).length);
assert.deepEqual(decoder.decode(densePacket).state, world);
const dangerous = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"x":1}}');
const safeEncoder = new SnapshotCodec(), safeDecoder = new SnapshotCodec();
assert.deepEqual(safeDecoder.decode(safeEncoder.encode({tick: 0, state: dangerous})).state, dangerous);
assert.equal({}.polluted, undefined);
