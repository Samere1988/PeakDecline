/* Low-latency options must preserve correction, checksum and input ordering. */
const assert = require('node:assert/strict');
const {RollbackEngine, RollbackSession, RollbackInputBuffer} = require('../../static/js/netplay/rollback.js');
const pad = buttons => ({buttons, x: 0, y: 0});
function fixture(options = {}) {
 let state = 0, context;
 const adapter = {
  prepareFrame(value) { context = value; },
  saveState() { return state; },
  restoreState(value) { state = value; },
  simulateFrame(pads) { state = (Math.imul(state, 31) + pads.reduce((n, p) => n + p.buttons, 0)) >>> 0; },
  hashState() { return state; },
  sampleInput: () => pad(1),
  ...options
 };
 return {adapter, get state() { return state; }, get context() { return context; }};
}

// Correct a past checkpoint and compare sparse hashes with the complete oracle.
{
 const sparse = fixture(), full = fixture();
 const a = new RollbackEngine({players: 2, hashInterval: 3, adapter: sparse.adapter});
 const b = new RollbackEngine({players: 2, adapter: full.adapter});
 for (let frame = 1; frame <= 90; ++frame) {
  for (const engine of [a, b]) {
   engine.receive(0, frame, pad(frame));
   assert.equal(engine.advance(), true);
   if (frame > 2) engine.receive(1, frame - 2, pad(frame * 2));
  }
 }
 for (const engine of [a, b]) {
  engine.receive(1, 89, pad(182)); engine.receive(1, 90, pad(184)); engine.reconcile();
 }
 assert.equal(sparse.state, full.state);
 assert.ok(a.rollbacks > 0);
 for (const [frame, hash] of a.hashes) {
  assert.equal(frame % 3, 0); assert.equal(hash, b.hashes.get(frame));
 }
 assert.equal(a.hashes.size, 30); assert.equal(b.hashes.size, 90);
 assert.ok(a.metrics.hashCount < b.metrics.hashCount);
 assert.equal(a.metrics.replayCount, b.metrics.replayCount);
 for (const name of ['saveMs', 'restoreMs', 'replayMs', 'hashMs']) assert.ok(a.metrics[name] >= 0);
 a.dispose(); b.dispose();
}

// Snapshot skipping is explicit, and context still reaches confirmed frames.
{
 const f = fixture({skipConfirmedSnapshots: true});
 const engine = new RollbackEngine({players: 2, adapter: f.adapter});
 engine.receive(0, 1, pad(1)); engine.receive(1, 1, pad(2));
 assert.ok(engine.advance());
 assert.equal(engine.metrics.saveCount, 0);
 assert.equal(f.context.confirmed, 1);
 engine.receive(0, 2, pad(3));
 const pending = engine.beginAdvance();
 f.adapter.simulateFrame(pending.pads);
 engine.receive(1, 2, pad(4));
 engine.completeAdvance();
 assert.ok(engine.snapshots.has(2), 'Input received during a pending frame must keep its speculative snapshot');
 engine.reconcile();
 assert.equal(engine.dirty, null);
 assert.equal(engine.metrics.restoreCount, 1);
 assert.equal(engine.metrics.saveCount, 2, 'Replay captures even when its inputs are now confirmed');
 engine.dispose();
 const old = fixture({skipConfirmedSnapshots: true, prepareFrame: undefined});
 const fallback = new RollbackEngine({players: 1, adapter: old.adapter});
 fallback.receive(0, 1, pad(0)); fallback.advance();
 assert.equal(fallback.metrics.saveCount, 1, 'Old adapters keep their capture/context semantics');
 fallback.dispose();
}

// A checkpoint that became confirmed during a yielded update is published
// only after replay, regardless of snapshot skipping and sparse hashing.
{
 const f = fixture({skipConfirmedSnapshots: true}), emitted = [];
 const session = new RollbackSession({socket: {emit: (type, value) => emitted.push({type, value})},
  game: {inputSchema: 'n64-pad-v1', tickRate: 2, rollback: {inputDelay: 0, maxPrediction: 6, hashInterval: 2}},
  epoch: 1, players: 2, slot: 0, spectator: false, onFailure: assert.fail});
 session.bind(f.adapter); session.start();
 session.receiveInput({epoch: 1, slot: 1, frame: 1, pad: pad(2)}); session.advance();
 const pending = session.beginAdvance(); f.adapter.simulateFrame(pending.pads);
 session.receiveInput({epoch: 1, slot: 1, frame: 2, pad: pad(4)}); session.completeAdvance();
 assert.equal(emitted.filter(e => e.type === 'hash').length, 0);
 session.engine.reconcile(); session.publishHashes();
 assert.equal(emitted.find(e => e.type === 'hash').value.hash, f.state);
 session.dispose();
}

// FIFO edges retain separate taps and transitions, including associated axes.
{
 const input = new RollbackInputBuffer(4);
 assert.deepEqual(input.take(pad(0)), pad(0));
 const sequence = [pad(0x8000), pad(0), {buttons: 0x4000, x: -80, y: 0}, pad(0)];
 sequence.forEach(value => input.record(value));
 sequence.forEach(value => assert.deepEqual(input.take(pad(0)), value));
 assert.deepEqual(input.take(pad(0)), pad(0));
 for (const value of [1, 0, 2, 0, 4, 0]) input.record(pad(value));
 assert.equal(input.dropped, 2);
 for (const value of [1, 0, 2, 0]) assert.equal(input.take(pad(8)).buttons, value);
 assert.equal(input.take(pad(8)).buttons, 8, 'After bounded overflow, return to live state');
 input.record(pad(0)); input.reset(); assert.deepEqual(input.take(pad(0)), pad(0));
}

// The auxiliary transport cannot consume input edges while its relay safety
// limit is reached. It supplements the existing authoritative relay emission.
{
 let peer, samples = 0;
 class Transport {
  constructor(options) {
   this.options = options; this.allowed = true; this.sent = []; this.enabled = true; this.relayConfirmed = 0; peer = this;
  }
  start() { this.started = true; }
  canSend() { return this.allowed; }
  send(frame, value) { this.sent.push({frame, value}); }
  dispose() { this.disposed = true; }
  diagnostics() { return {sent: this.sent.length}; }
 }
 global.window = {PeakNet: {RollbackInputTransport: Transport}};
 const f = fixture({sampleInput() { ++samples; return pad(samples); }}), events = [];
 const session = new RollbackSession({socket: {emit: (type, value) => events.push({type, value})},
  game: {inputSchema: 'n64-pad-v1', tickRate: 2, rollback: {inputDelay: 1, maxPrediction: 6, hashInterval: 2, peerInputs: true}},
  epoch: 7, players: 2, slot: 0, spectator: false, onFailure: assert.fail});
 session.bind(f.adapter); session.start();
 assert.equal(peer.started, true); assert.equal(peer.sent.length, 1);
 peer.allowed = false;
 const buffered = session.beginAdvance();
 assert.ok(buffered, 'Already sent input may be consumed while future sends are blocked');
 f.adapter.simulateFrame(buffered.pads); session.completeAdvance();
 assert.equal(session.beginAdvance(), false);
 assert.equal(samples, 0); assert.equal(session.engine.lastStallReason, 'relay');
 peer.allowed = true; const pending = session.beginAdvance();
 assert.equal(samples, 2); assert.equal(peer.sent.length, 3);
 assert.equal(events.filter(e => e.type === 'input').length, 3);
 f.adapter.simulateFrame(pending.pads); session.completeAdvance();
 assert.equal(session.diagnostics().transport.sent, 3);
 for (let frame = 1; frame <= 2; ++frame) peer.options.receiveInput({epoch: 7, slot: 1, frame, pad: pad(0)});
 session.engine.reconcile(); session.publishHashes();
 assert.equal(session.engine.confirmed, 2);
 assert.equal(events.filter(e => e.type === 'hash').length, 0, 'P2P confirmation must not publish ahead of relay acceptance');
 peer.relayConfirmed = 2; session.publishHashes();
 assert.equal(events.find(e => e.type === 'hash').value.hash, f.state);
 session.dispose(); assert.equal(peer.disposed, true);
 delete global.window;
}
assert.throws(() => new RollbackEngine({players: 1, adapter: fixture().adapter, hashInterval: 0}), /configuration/);
assert.throws(() => new RollbackSession({game: {inputSchema: 'n64-pad-v1', tickRate: 60,
 rollback: {inputDelay: 1, maxPrediction: 6, hashInterval: 7}}, players: 1, slot: 0}), /checksum/);
console.log('Rollback latency options: sparse correction hashes, safe capture skipping, pending race, ordered edges and transport bounds passed.');
