/* Deterministic repair/ACK/reconnection boundaries. No browser or timer sleeps. */
const assert = require('node:assert/strict');
const {RollbackInputTransport, encode, decode} = require('../../static/js/netplay/rollback_transport.js');
class Socket {
 constructor() { this.listeners = new Map(); this.sent = []; }
 on(name, callback) { const rows = this.listeners.get(name) || []; rows.push(callback); this.listeners.set(name, rows); }
 off(name, callback) { this.listeners.set(name, (this.listeners.get(name) || []).filter(fn => fn !== callback)); }
 emit(name, data) { this.sent.push({name, data}); }
 receive(name, data) { for (const callback of this.listeners.get(name) || []) callback(data); }
}
class Channel {
 constructor() {
  Object.assign(this, {label: 'rollback-input-v2', ordered: false, maxRetransmits: 0,
   readyState: 'open', bufferedAmount: 0, packets: [], closes: 0});
 }
 send(packet) { this.packets.push(packet.slice(0)); }
 close() { ++this.closes; this.readyState = 'closed'; this.onclose?.(); }
}
class PC {
 constructor() { this.connectionState = 'new'; this.closes = 0; this.calls = []; }
 createDataChannel() { this.calls.push('channel'); return this.channel = new Channel(); }
 async createOffer() { this.calls.push('offer'); return {type: 'offer', sdp: 'offer'}; }
 async createAnswer() { this.calls.push('answer'); return {type: 'answer', sdp: 'answer'}; }
 async setLocalDescription(value) { this.calls.push('local'); this.localDescription = value; }
 async setRemoteDescription(value) { this.calls.push('remote'); this.remoteDescription = value; }
 async addIceCandidate(value) { this.calls.push('candidate'); (this.candidates ??= []).push(value); }
 close() { ++this.closes; this.connectionState = 'closed'; this.onconnectionstatechange?.(); }
}
const pad = n => ({buttons: n, x: n % 80, y: -(n % 80)});
const packet = (bytes, frame = 128) => {
 const view = new DataView(bytes);
 return {inputs: decode(bytes, 9, frame), ack: view.getUint32(12), mask: view.getUint32(16)};
};
const waiting = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
let fixtures = [];
function fixture(slot = 0, options = {}, setup = {}) {
 const socket = new Socket(), received = []; let time = 0, frame = 1;
 const transport = new RollbackInputTransport({socket, epoch: 9, players: 2, slot, spectator: false,
  receiveInput: event => { received.push(event); return true; }, frame: () => frame, PeerConnection: PC, clock: () => time,
  ...options});
 fixtures.push(transport);
 transport.start();
 socket.receive('rollback_transport', {epoch: 9, slot, players: 2, peers: setup.peers ?? [0, 1], iceServers: []});
 const peer = () => transport.peers.get(1 - slot);
 if (peer() && setup.open !== false) {
  if (!peer().channel) transport.attachChannel(peer(), new Channel());
  peer().channel.onopen();
 } else if (peer()?.channel) peer().channel.readyState = 'connecting';
 return {socket, transport, received, peer, channel: () => peer().channel,
  setFrame: n => { frame = n; }, setTime: n => { time = n; },
  tick(n) {
   time = n;
   if (!transport.closed && transport.maintenanceTimer && transport.maintenanceAt <= n) {
    const timer = transport.maintenanceTimer, callback = timer._onTimeout;
    clearTimeout(timer); callback(); // Execute the real one-shot callback at the manual deadline.
   } else transport.maintain();
  },
  signal(type, value, generation = peer().generation) {
   socket.receive('rollback_signal', {epoch: 9, from: 1 - slot, to: slot, type, value, generation});
  }};
}
const tests = [];
function test(name, run) { tests.push({name, run}); }

test('lost final packet and lost ACK recover without new simulation frames', () => {
 const a = fixture(0), b = fixture(1);
 a.transport.send(1, pad(1));
 assert.equal(a.channel().packets.length, 1); // Drop it: no subsequent send().
 a.tick(49); assert.equal(a.channel().packets.length, 1);
 a.tick(50); assert.equal(a.channel().packets.length, 2);
 assert.deepEqual(packet(a.channel().packets.at(-1)).inputs, [{frame: 1, pad: pad(1)}]);
 assert.equal(a.transport.sentThrough, 1);
 b.channel().onmessage({data: a.channel().packets.at(-1)});
 b.tick(16);
 const firstAck = b.channel().packets.at(-1);
 assert.equal(firstAck.byteLength, 20);
 assert.deepEqual(packet(firstAck), {inputs: [], ack: 1, mask: 0}); // Drop ACK.
 a.tick(100); assert.equal(a.channel().packets.length, 3);
 b.channel().onmessage({data: a.channel().packets.at(-1)});
 assert.equal(b.received.length, 1, 'A duplicate repair must not resubmit input');
 assert.equal(b.transport.metrics.duplicates, 1);
 b.tick(100); assert.equal(b.channel().packets.length, 2, 'Duplicate input solicits replacement ACK');
 a.channel().onmessage({data: b.channel().packets.at(-1)});
 assert.equal(a.peer().ackThrough, 1);
 const counts = [a.channel().packets.length, b.channel().packets.length];
 for (const at of [150, 200, 1000]) { a.tick(at); b.tick(at); }
 assert.deepEqual([a.channel().packets.length, b.channel().packets.length], counts, 'ACK-only must not ping-pong');
 assert.equal(a.transport.metrics.ackPackets, 0);
 assert.equal(a.transport.sentThrough, 1); assert.equal(a.transport.history.size, 1);
 assert.equal(b.transport.sentThrough, 0);
});

test('selective ACK including bit 31 leaves the oldest gap repairable', () => {
 const a = fixture(0), b = fixture(1);
 for (let frame = 1; frame <= 32; ++frame) a.transport.send(frame, pad(frame));
 b.channel().onmessage({data: encode(9, [{frame: 2, pad: pad(2)}, {frame: 32, pad: pad(32)}])});
 b.tick(16);
 const ack = b.channel().packets.at(-1);
 assert.deepEqual(packet(ack), {inputs: [], ack: 0, mask: 0x80000002});
 a.channel().onmessage({data: ack});
 assert.equal(a.transport.acknowledged(a.peer(), 2), true);
 assert.equal(a.transport.acknowledged(a.peer(), 32), true);
 assert.equal(a.transport.acknowledged(a.peer(), 1), false);
 a.tick(50);
 assert.deepEqual(packet(a.channel().packets.at(-1)).inputs.map(row => row.frame), [1, 3, 4, 5, 6, 7, 8, 9]);
 a.channel().onmessage({data: encode(9, [], 32)});
 assert.equal(a.peer().acked.size, 0, 'Cumulative ACK removes superseded selective entries');
 a.channel().onmessage({data: encode(9, [], 1)});
 assert.equal(a.peer().ackThrough, 32, 'Reordered stale ACK cannot regress progress');
});

test('invalid ACK and malformed input reject the entire packet before any mutation', () => {
 const a = fixture();
 a.transport.send(1, pad(1)); a.transport.send(2, pad(2));
 const validInput = [{frame: 1, pad: pad(9)}];
 const invalid = [
  encode(9, validInput, 3), // Future cumulative ACK.
  encode(9, validInput, 1, 2), // Selective bit claims unsent frame3.
  encode(9, validInput, 0, 0x80000000), // Unsigned high bit claims unsent frame32.
  encode(9, [{frame: 1, pad: pad(9)}, {frame: 2, pad: {buttons: 1, x: 100, y: 0}}], 2),
  encode(9, [{frame: 1, pad: pad(9)}, {frame: 130, pad: pad(1)}], 2),
  encode(9, [{frame: 2, pad: pad(9)}, {frame: 1, pad: pad(1)}], 2),
  encode(8, validInput, 2),
 ];
 const reserved = encode(9, validInput, 2); new DataView(reserved).setUint8(6, 1); invalid.push(reserved);
 const oldVersion = encode(9, validInput, 2); new DataView(oldVersion).setUint8(4, 1); invalid.push(oldVersion);
 for (const bytes of invalid) {
  a.channel().onmessage({data: bytes});
  assert.equal(a.received.length, 0); assert.equal(a.peer().received.size, 0);
  assert.equal(a.peer().ackThrough, 0); assert.equal(a.peer().acked.size, 0); assert.equal(a.peer().ackPending, false);
 }
 assert.equal(a.transport.metrics.invalidPackets, invalid.length);
 assert.equal(a.transport.metrics.receivedPackets, 0);
 a.channel().onmessage({data: encode(9, validInput, 1, 1)});
 assert.equal(a.received.length, 1); assert.equal(a.peer().ackThrough, 1); assert.deepEqual([...a.peer().acked], [2]);
});

test('engine rejection is never acknowledged', () => {
 const a = fixture(0, {receiveInput: () => false});
 a.transport.send(1, pad(1));
 a.channel().onmessage({data: encode(9, [{frame: 1, pad: pad(2)}], 1)});
 assert.equal(a.peer().receiveThrough, 0); assert.equal(a.peer().received.size, 0);
 assert.equal(a.peer().ackThrough, 0); assert.equal(a.peer().ackPending, false);
});

test('history is immutable and limited to 128 already-submitted frames', () => {
 const a = fixture(), mutable = pad(1);
 a.transport.send(1, mutable); mutable.buttons = 999;
 assert.deepEqual(a.transport.history.get(1), pad(1));
 assert.equal(a.transport.send(1, pad(999)), false);
 for (let frame = 2; frame <= 120; ++frame) a.transport.send(frame, pad(frame));
 assert.equal(a.transport.send(121, pad(121)), false, 'Relay confirmation still bounds journal lead');
 a.socket.receive('frameset', {epoch: 9, frame: 120});
 for (let frame = 121; frame <= 200; ++frame) a.transport.send(frame, pad(frame));
 assert.equal(a.transport.history.size, 128); assert.equal([...a.transport.history.keys()][0], 73);
 const packets = a.channel().packets.length;
 assert.equal(a.transport.send(1, pad(999)), false, 'An evicted frame is still immutable');
 assert.equal(a.transport.send(200, pad(999)), false);
 assert.equal(a.channel().packets.length, packets);
 a.tick(50);
 assert.deepEqual(packet(a.channel().packets.at(-1)).inputs.map(row => row.frame), [73, 74, 75, 76, 77, 78, 79, 80]);
 assert.equal(a.transport.sentThrough, 200);
 assert.ok(a.channel().packets.every(bytes => bytes.byteLength <= 84));
});

test('backpressure recovery resends immutable history when the queue drains', () => {
 const a = fixture(); a.channel().bufferedAmount = 337;
 const mutable = pad(3); assert.equal(a.transport.send(1, mutable), false); mutable.buttons = 4;
 assert.equal(a.channel().packets.length, 0); assert.equal(a.peer().blocked, true);
 a.channel().bufferedAmount = 0; a.channel().onbufferedamountlow();
 assert.deepEqual(packet(a.channel().packets.at(-1)).inputs, [{frame: 1, pad: pad(3)}]);
 assert.equal(a.transport.sentThrough, 1); assert.equal(a.transport.metrics.repairPackets, 1);
});

test('lower seat recreates failed peers through generation4 then stops', async () => {
 const a = fixture(); await a.peer().queue;
 for (let generation = 0; generation < 4; ++generation) {
  const previous = a.peer();
  previous.pc.connectionState = 'failed'; previous.pc.onconnectionstatechange();
  const retryAt = previous.retryAt;
  a.tick(retryAt - 1); assert.equal(a.peer(), previous);
  a.tick(retryAt); assert.equal(a.peer().generation, generation + 1);
  assert.notEqual(a.peer().pc, previous.pc); assert.ok(previous.pc.closes >= 1);
  a.channel().onopen(); await a.peer().queue;
 }
 assert.equal(a.transport.metrics.reconnectAttempts, 4); assert.equal(a.transport.metrics.recoveredPeers, 4);
 const final = a.peer(); final.pc.connectionState = 'failed'; final.pc.onconnectionstatechange();
 assert.equal(final.retryAt, null);
 a.tick(1000000); assert.equal(a.peer(), final); assert.equal(a.transport.metrics.reconnectAttempts, 4);
 const offers = a.socket.sent.filter(row => row.name === 'rollback_signal' && row.data.type === 'offer');
 assert.deepEqual(offers.map(row => row.data.generation), [0, 1, 2, 3, 4]);
});

test('higher seat requests bounded restarts and cannot originate a new offer', async () => {
 const b = fixture(1); b.transport.failPeer(b.peer());
 for (let request = 0; request < 4; ++request) b.tick(b.peer().retryAt);
 b.tick(1000000);
 const restarts = b.socket.sent.filter(row => row.name === 'rollback_signal');
 assert.equal(restarts.length, 4);
 assert.ok(restarts.every(row => row.data.type === 'restart' && row.data.generation === 0 && row.data.value === null));
 assert.equal(b.peer().generation, 0); assert.equal(b.peer().retryAt, null);
 const a = fixture(); await a.peer().queue;
 a.signal('restart', null, 1); assert.equal(a.peer().failed, false, 'Future-generation request is ignored');
 a.signal('restart', null, 0); assert.equal(a.peer().failed, true);
 a.tick(a.peer().retryAt); await a.peer().queue; assert.equal(a.peer().generation, 1);
});

test('future candidates wait for the matching offer and stale generations stay inert', async () => {
 const b = fixture(1), original = b.peer(), candidate = {candidate: 'generation1'};
 b.signal('candidate', candidate, 1);
 assert.equal(b.peer(), original); assert.equal(original.futureCandidates.get(1).length, 1);
 b.signal('offer', 'offer1', 1); const current = b.peer(); await current.queue;
 assert.equal(current.generation, 1); assert.deepEqual(current.pc.candidates, [candidate]);
 assert.equal(current.pc.remoteDescription.sdp, 'offer1');
 assert.ok(original.pc.closes >= 1);
 const calls = current.pc.calls.length, signals = b.socket.sent.length;
 for (const [type, value] of [['offer', 'old-offer'], ['answer', 'old-answer'], ['candidate', {candidate: 'old'}], ['restart', null]])
  b.signal(type, value, 0);
 await current.queue;
 assert.equal(current.pc.calls.length, calls); assert.equal(b.socket.sent.length, signals);
 for (const generation of [-1, 5, true, 1.5]) b.signal('offer', 'bad', generation);
 assert.equal(b.peer(), current);
 const a = fixture(); a.signal('offer', 'wrong-owner', 1); assert.equal(a.peer().generation, 0);
});

test('a replaced in-flight offer cannot publish stale SDP', async () => {
 const pending = waiting();
 class DeferredPC extends PC {
  async createOffer() { this.calls.push('offer'); return pending.promise; }
 }
 const a = fixture(0, {PeerConnection: DeferredPC});
 const old = a.peer(); await Promise.resolve();
 assert.ok(old.pc.calls.includes('offer'));
 a.transport.failPeer(old); a.tick(old.retryAt);
 pending.resolve({type: 'offer', sdp: 'ready'});
 await old.queue; await a.peer().queue;
 assert.equal(old.pc.localDescription, undefined);
 const offers = a.socket.sent.filter(row => row.name === 'rollback_signal' && row.data.type === 'offer');
 assert.equal(offers.length, 1); assert.equal(offers[0].data.generation, 1);
});

test('a replaced in-flight answer cannot publish stale SDP', async () => {
 const pending = waiting();
 class DeferredPC extends PC {
  async setRemoteDescription(value) { await pending.promise; return super.setRemoteDescription(value); }
 }
 const b = fixture(1, {PeerConnection: DeferredPC});
 b.signal('offer', 'old', 0); const old = b.peer(); await Promise.resolve();
 b.signal('offer', 'new', 1); const current = b.peer();
 pending.resolve(); await old.queue; await current.queue;
 assert.equal(old.pc.calls.includes('answer'), false);
 const answers = b.socket.sent.filter(row => row.name === 'rollback_signal' && row.data.type === 'answer');
 assert.equal(answers.length, 1); assert.equal(answers[0].data.generation, 1);
});

test('disconnect grace preserves transient connections and retries a lasting failure', () => {
 const a = fixture(), peer = a.peer();
 peer.pc.connectionState = 'disconnected'; peer.pc.onconnectionstatechange();
 a.tick(1499); assert.equal(peer.failed, false);
 peer.pc.connectionState = 'connected'; peer.pc.onconnectionstatechange();
 a.tick(2000); assert.equal(peer.failed, false);
 peer.pc.connectionState = 'disconnected'; peer.pc.onconnectionstatechange();
 a.tick(3499); assert.equal(peer.failed, false);
 a.tick(3500); assert.equal(peer.failed, true); assert.equal(peer.retryAt, 3750);
});

test('late RTC starts at relay receipt frontier and reconnect preserves selective progress', async () => {
 const a = fixture(0, {}, {peers: []});
 for (let frame = 1; frame <= 300; ++frame) {
  a.transport.send(frame, pad(frame));
  if (frame % 100 === 0) a.socket.receive('frameset', {epoch: 9, frame});
 }
 assert.equal(a.transport.relayConfirmed, 300); assert.equal(a.transport.history.size, 128);
 a.setFrame(301);
 a.socket.receive('rollback_peer', {epoch: 9, slot: 1});
 a.channel().onopen(); await a.peer().queue;
 assert.equal(a.peer().receiveThrough, 300, 'A late connection must not wait for evicted initial inputs');
 assert.equal(packet(a.channel().packets.at(-1), 301).ack, 300);
 // Receive a remote gap and cumulative receipt of our existing journal.
 a.channel().onmessage({data: encode(9, [{frame: 301, pad: pad(1)}, {frame: 303, pad: pad(3)}], 300)});
 for (let frame = 301; frame <= 304; ++frame) a.transport.send(frame, pad(frame));
 a.channel().onmessage({data: encode(9, [], 301, 2)}); // Selectively ACK local303, leave302/304 missing.
 const old = a.peer(), receipt = old.received, selective = old.acked;
 assert.equal(old.receiveThrough, 301); assert.deepEqual([...old.received.keys()], [301, 303]);
 assert.equal(old.ackThrough, 301); assert.deepEqual([...old.acked], [303]);
 a.transport.failPeer(old); a.tick(old.retryAt);
 const next = a.peer(); a.channel().onopen(); await next.queue;
 assert.equal(next.generation, 1); assert.equal(next.received, receipt); assert.equal(next.acked, selective);
 assert.equal(next.receiveThrough, 301); assert.equal(next.ackThrough, 301);
 assert.deepEqual(packet(a.channel().packets.at(-1), 304), {
  inputs: [{frame: 302, pad: pad(302)}, {frame: 304, pad: pad(304)}], ack: 301, mask: 2,
 });
 assert.equal(a.transport.sentThrough, 304);
 const submitted = a.received.length;
 a.channel().onmessage({data: encode(9, [{frame: 301, pad: pad(1)}], 301, 2)});
 assert.equal(a.received.length, submitted, 'Receipt deduplication survives the replacement connection');
 a.channel().onmessage({data: encode(9, [{frame: 302, pad: pad(2)}], 301, 2)});
 assert.equal(next.receiveThrough, 303, 'Filling the original gap advances through retained future receipt');
});

test('future candidate cap spans generations and handshake deadlines trigger bounded retry', async () => {
 const b = fixture(1, {}, {open: false}), waitingPeer = b.peer();
 for (let n = 0; n < 80; ++n) b.signal('candidate', {candidate: 'pending' + n}, n < 40 ? 1 : 2);
 for (let n = 0; n < 10; ++n) b.signal('candidate', {candidate: 'overflow' + n}, 3);
 assert.equal([...waitingPeer.futureCandidates.values()].reduce((sum, rows) => sum + rows.length, 0), 64);
 assert.equal(waitingPeer.futureCandidates.get(1).length, 40);
 assert.equal(waitingPeer.futureCandidates.get(2).length, 24);
 assert.equal(waitingPeer.futureCandidates.has(3), false);
 b.tick(9999); assert.equal(waitingPeer.failed, false);
 b.tick(10000); assert.equal(waitingPeer.failed, true); assert.equal(waitingPeer.retryAt, 10250);
 b.tick(10250);
 assert.ok(b.socket.sent.some(row => row.name === 'rollback_signal' && row.data.type === 'restart'));
 b.signal('offer', 'new-offer', 1); await b.peer().queue;
 assert.equal(b.peer().generation, 1); assert.equal(b.peer().pc.candidates.length, 40);
 const a = fixture(0, {}, {open: false}); await a.peer().queue;
 a.tick(9999); assert.equal(a.peer().failed, false);
 a.tick(10000); assert.equal(a.peer().failed, true);
 a.tick(10250); await a.peer().queue;
 assert.equal(a.peer().generation, 1); assert.equal(a.transport.metrics.reconnectAttempts, 1);
 assert.equal(a.peer().deadline, 20250);
 a.tick(20249); assert.equal(a.peer().failed, false);
 a.tick(20250); assert.equal(a.peer().failed, true); assert.equal(a.peer().retryAt, 20750);
});

test('a delayed bufferedamountlow event cannot bypass the 16ms ACK-only spacing', () => {
 const b = fixture(1), channel = b.channel();
 channel.bufferedAmount = 337;
 channel.onmessage({data: encode(9, [{frame: 1, pad: pad(1)}])});
 b.tick(0); assert.equal(b.peer().blocked, true); assert.equal(channel.packets.length, 0);
 assert.equal(b.transport.maintenanceTimer, null, 'Backpressure waits for the channel event');
 b.setTime(16); channel.bufferedAmount = 0; channel.onbufferedamountlow();
 assert.equal(channel.packets.length, 1); assert.equal(b.peer().lastAck, 16);
 assert.equal(b.peer().blocked, false, 'A successful flush clears backpressure');
 b.setTime(17); channel.onmessage({data: encode(9, [{frame: 2, pad: pad(2)}])});
 channel.onbufferedamountlow();
 assert.equal(channel.packets.length, 1, 'A stale low event must not emit a second ACK after only 1 ms');
 assert.equal(b.peer().ackPending, true);
 assert.equal(b.transport.maintenanceAt, 32);
 b.tick(31); assert.equal(channel.packets.length, 1);
 b.tick(32); assert.equal(channel.packets.length, 2);
 assert.deepEqual(packet(channel.packets.at(-1)), {inputs: [], ack: 2, mask: 0});
 assert.equal(b.transport.metrics.ackPackets, 2);
 assert.equal(b.transport.maintenanceTimer, null);
});

test('idle channels have no maintenance timer and a valid ACK cancels pending repair', () => {
 const a = fixture();
 assert.equal(a.transport.history.size, 0);
 assert.equal(a.transport.maintenanceTimer, null);
 a.tick(1000); assert.equal(a.transport.maintenanceTimer, null);
 a.transport.send(1, pad(1));
 const scheduled = a.transport.maintenanceTimer;
 assert.ok(scheduled); assert.equal(a.transport.maintenanceAt, 1050);
 a.channel().onmessage({data: encode(9, [], 2)});
 assert.equal(a.transport.maintenanceTimer, scheduled, 'Invalid ACK must not cancel a necessary repair');
 a.channel().onmessage({data: encode(9, [], 1)});
 assert.equal(scheduled._destroyed, true);
 assert.equal(a.transport.maintenanceTimer, null); assert.equal(a.transport.maintenanceAt, null);
 const packets = a.channel().packets.length;
 a.tick(10000); assert.equal(a.channel().packets.length, packets);
 assert.equal(a.transport.maintenanceTimer, null);
});

test('a blocked input channel does not poll and its low event schedules the next repair', () => {
 const a = fixture(), channel = a.channel();
 channel.bufferedAmount = 337; a.transport.send(1, pad(1));
 assert.equal(a.peer().blocked, true); assert.equal(channel.packets.length, 0);
 assert.equal(a.transport.maintenanceTimer, null);
 const drops = a.transport.metrics.backpressureDrops;
 for (const at of [16, 32, 64]) a.tick(at);
 assert.equal(a.transport.metrics.backpressureDrops, drops, 'No repeated attempts while waiting for bufferedamountlow');
 assert.equal(a.transport.maintenanceTimer, null);
 a.setTime(70); channel.bufferedAmount = 0; channel.onbufferedamountlow();
 assert.equal(a.peer().blocked, false); assert.equal(channel.packets.length, 1);
 assert.deepEqual(packet(channel.packets[0]).inputs, [{frame: 1, pad: pad(1)}]);
 assert.ok(a.transport.maintenanceTimer); assert.equal(a.transport.maintenanceAt, 120);
 a.tick(119); assert.equal(channel.packets.length, 1);
 a.tick(120); assert.equal(channel.packets.length, 2, 'Still-unacknowledged history repairs at its new deadline');
 assert.equal(a.transport.maintenanceAt, 170);
 channel.onmessage({data: encode(9, [], 1)});
 assert.equal(a.transport.maintenanceTimer, null);
});

test('dispose cancels maintenance and invalidates retained callbacks and async work', async () => {
 const pending = waiting();
 class DeferredPC extends PC { async createOffer() { return pending.promise; } }
 const a = fixture(0, {PeerConnection: DeferredPC}); await Promise.resolve();
 a.transport.send(1, pad(1));
 const peer = a.peer(), channel = a.channel(), callbacks = {
  open: channel.onopen, message: channel.onmessage, error: channel.onerror,
  close: channel.onclose, low: channel.onbufferedamountlow,
  ice: peer.pc.onicecandidate, datachannel: peer.pc.ondatachannel, state: peer.pc.onconnectionstatechange,
 };
 const timer = a.transport.maintenanceTimer, timerCallback = timer._onTimeout;
 a.transport.dispose();
 assert.equal(timer._destroyed, true);
 assert.equal(a.transport.peers.size, 0); assert.equal(a.transport.history.size, 0);
 assert.ok([...a.socket.listeners.values()].every(rows => rows.length === 0));
 const signals = a.socket.sent.length, metrics = {...a.transport.metrics};
 callbacks.open(); callbacks.error(); callbacks.close(); callbacks.low();
 callbacks.message({data: encode(9, [{frame: 1, pad: pad(2)}], 1)});
 callbacks.ice({candidate: {toJSON: () => ({candidate: 'stale'})}}); callbacks.state();
 const stray = new Channel(); callbacks.datachannel({channel: stray}); assert.equal(stray.readyState, 'closed');
 timerCallback(); a.tick(1000000); pending.resolve({type: 'offer', sdp: 'stale'}); await peer.queue;
 assert.equal(a.socket.sent.length, signals); assert.equal(a.received.length, 0);
 assert.deepEqual(a.transport.metrics, metrics); assert.equal(a.transport.send(2, pad(2)), false);
});

(async () => {
 let failures = 0;
 for (const {name, run} of tests) {
  fixtures = [];
  try { await run(); console.log('PASS ' + name); }
  catch (error) { ++failures; console.error('FAIL ' + name + '\n' + error.stack); }
  finally { for (const transport of fixtures) transport.dispose(); }
 }
 if (failures) process.exitCode = 1;
 else console.log(`Rollback RTC recovery: ${tests.length} deterministic boundary tests passed.`);
})();
