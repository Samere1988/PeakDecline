/* Lockstep rows assembled from peer input copies, using the installed Wasm input
 * ring and a scripted transport. The relay journal remains authoritative. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const createCore = require(path.resolve(__dirname, '../../instance/netplay/build/netplay.js'));
const source = fs.readFileSync(path.resolve(__dirname, '../../static/js/netplay/session.js'), 'utf8');

class FakeTransport {
    constructor(options) {
        Object.assign(this, options);
        this.enabled = !options.spectator && options.players > 1;
        this.sent = []; this.relayConfirmed = 0; this.started = 0; this.disposed = false;
        FakeTransport.last = this;
    }
    start() { this.started++; }
    canSend(frame) { return frame <= this.relayConfirmed + 120; }
    confirm(frame) { this.relayConfirmed = Math.max(this.relayConfirmed, frame); }
    send(frame, pad) { this.sent.push({frame, pad}); return true; }
    diagnostics() { return {relayConfirmed: this.relayConfirmed}; }
    dispose() { this.disposed = true; }
}

const pads = Array.from({length: 4}, (_, i) => ({buttons: 1 << i, x: i * 10, y: i ? -i * 10 : 0}));
async function create(id, {players = 2, slot = 0, spectator = false, recovery, lockstep = {peerInputs: true}, hash} = {}) {
    const sandbox = {performance: {now: () => 0}, setInterval: () => 1, clearInterval() {}};
    sandbox.window = sandbox; vm.createContext(sandbox);
    vm.runInContext(source, sandbox);
    sandbox.PeakNet.RollbackInputTransport = FakeTransport;
    FakeTransport.last = null;
    const events = [], failures = [];
    const session = new sandbox.PeakNet.Session({socket: {emit: (event, data) => events.push({event, data})},
        core: await createCore(), game: {id, tickRate: 60, lockstep}, epoch: 3, players, slot, spectator, recovery,
        onFailure: message => failures.push(message)});
    session.bind({sampleInput: () => pads[slot], hashForFrame: hash || (frame => 1000 + frame)});
    return {session, events, failures, transport: spectator ? null : FakeTransport.last,
        sent: name => JSON.parse(JSON.stringify(events.filter(e => e.event === name).map(e => e.data)))};
}
const row = (frame, values = pads.slice(0, 2)) => ({epoch: 3, frame, pads: values});
const peer = (session, frame, slot = 1, pad = pads[slot]) => session.receivePeerInput({epoch: 3, slot, frame, pad});

(async () => {
    for (const id of ['fzerox', 'marioparty']) {
        // Peer copies complete rows before the relay; the relay verifies them later.
        let t = await create(id);
        assert.equal(t.session.peered, true); assert.equal(t.session.buffered, true);
        t.session.latency(1); t.session.start(); assert.equal(t.transport.started, 1);
        assert.equal(t.session.frameReady(1), 0);
        assert.deepEqual(t.sent('input').map(i => i.frame), t.transport.sent.map(i => i.frame), 'every input still reaches the relay');
        for (let frame = 1; frame <= 70; frame++) {
            assert.equal(peer(t.session, frame), true);
            assert.equal(t.session.frameReady(frame), 1, `peer row ${frame}`);
        }
        assert.deepEqual(JSON.parse(JSON.stringify(t.session.getFrame(70))), pads.slice(0, 2));
        assert.equal(t.session.diagnostics().peerRows, 70);
        assert.equal(t.sent('hash').length, 0, 'checksums wait for relay confirmation');
        for (let frame = 1; frame <= 59; frame++) t.session.receive(row(frame));
        assert.deepEqual(t.sent('hash'), [{epoch: 3, frame: 59, hash: 1059}]);
        assert.equal(t.transport.relayConfirmed, 59);
        for (let frame = 60; frame <= 70; frame++) t.session.receive(row(frame));
        assert.equal(t.session.unconfirmed.size, 0); assert.deepEqual(t.failures, []);
        // Relay rows still work without peer copies, and late peer copies are ignored.
        assert.equal(t.session.frameReady(71), 0);
        t.session.receive(row(71)); assert.equal(peer(t.session, 71, 1, pads[3]), true);
        assert.equal(t.session.frameReady(71), 1); assert.deepEqual(t.failures, []);
        // An unconsumed peer copy never overrides the authoritative relay row.
        assert.equal(peer(t.session, 72, 1, pads[3]), true);
        t.session.receive(row(72)); assert.equal(t.session.frameReady(72), 1);
        assert.deepEqual(JSON.parse(JSON.stringify(t.session.getFrame(72))), pads.slice(0, 2));
        // A relay row that disagrees with a consumed peer row ends the match.
        peer(t.session, 73, 1, pads[3]); assert.equal(t.session.frameReady(73), 1);
        t.session.receive(row(73));
        assert.match(t.failures[0], /Conflicting game frame/);
        assert.equal(t.transport.disposed, true);

        // A conflicting late copy of a consumed peer row is also rejected.
        t = await create(id); t.session.start(); t.session.frameReady(1);
        peer(t.session, 1); assert.equal(t.session.frameReady(1), 1);
        assert.equal(peer(t.session, 1, 1, pads[2]), false);
        assert.match(t.failures[0], /Conflicting game frame/);

        // Peer progress stays inside the relay window: 120 frames beyond confirmation.
        t = await create(id); t.session.latency(1); t.session.start();
        for (let frame = 1; frame <= 130; frame++) {
            peer(t.session, frame);
            if (t.session.frameReady(frame) !== 1) break;
        }
        assert.equal(t.session.sentThrough, 120); assert.equal(t.session.frame, 121);
        assert.equal(t.session.frameReady(121), 0);
        t.session.receive(row(1)); assert.equal(t.session.frameReady(121), 1);
        assert.equal(t.session.sentThrough, 121);
        assert.deepEqual(t.failures, []);

        // Spectators and rooms without the descriptor flag never create a transport.
        assert.equal((await create(id, {spectator: true})).transport, null);
        t = await create(id, {lockstep: null});
        assert.equal(t.transport, null); assert.equal(t.session.peered, false);
        assert.equal(t.session.buffered, id === 'marioparty');
    }

    // Retained reconnect: report the relay-confirmed position and verify early rows.
    let t = await create('marioparty');
    t.session.latency(1); t.session.start();
    for (let frame = 1; frame <= 10; frame++) { peer(t.session, frame); assert.equal(t.session.frameReady(frame), 1); }
    for (let frame = 1; frame <= 4; frame++) t.session.receive(row(frame));
    t.session.frameReady(11); t.session.suspendTransport();
    assert.equal(t.session.resumeFrame(), 4);
    const before = t.events.length;
    t.session.resumeTransport({epoch: 3, completed: 7, paused: false, frames: [5, 6, 7].map(frame => row(frame))});
    assert.deepEqual(t.failures, []); assert.equal(t.session.unconfirmed.size, 3);
    assert.deepEqual(t.events.slice(before).filter(e => e.event === 'input').map(e => e.data.frame).slice(0, 3), [8, 9, 10],
        'inputs not yet in the relay journal are resent');
    for (let frame = 8; frame <= 10; frame++) t.session.receive(row(frame));
    assert.equal(t.session.unconfirmed.size, 0); assert.deepEqual(t.failures, []);
    // A paused seat may return as a new tab, so unconsumed remote copies are
    // dropped on pause and ignored while paused; the relay delivers them again.
    t = await create('marioparty'); t.session.latency(1); t.session.start(); t.session.frameReady(1);
    peer(t.session, 1); peer(t.session, 2); t.session.suspendTransport();
    assert.equal(peer(t.session, 3), true);
    t.session.resumeTransport({epoch: 3, paused: false});
    assert.equal(t.session.frameReady(1), 0, 'stale copies are not consumed after a pause');
    assert.equal(t.session.peerInputs.get(1)[0] !== undefined && t.session.peerInputs.get(1)[1] === undefined, true);
    assert.equal(t.session.peerInputs.get(3)?.[1], undefined);
    peer(t.session, 1); assert.equal(t.session.frameReady(1), 1);
    // On pause, rows consumed before the relay are reported as witnesses.
    t = await create('marioparty'); t.session.start(); t.session.frameReady(1);
    peer(t.session, 1); assert.equal(t.session.frameReady(1), 1); t.session.suspendTransport();
    assert.deepEqual(t.sent('lockstep_witness'), [{epoch: 3, rows: [{frame: 1, pads: pads.slice(0, 2)}]}]);
    t = await create('fzerox'); t.session.start(); t.session.frameReady(1);
    peer(t.session, 1); t.session.frameReady(1); t.session.suspendTransport();
    assert.equal(t.sent('lockstep_witness').length, 0, 'unretained games end on disconnect instead');
    // History that contradicts an early row is rejected.
    t = await create('marioparty'); t.session.start();
    for (let frame = 1; frame <= 3; frame++) { t.session.frameReady(frame); peer(t.session, frame); t.session.frameReady(frame); }
    t.session.suspendTransport();
    t.session.resumeTransport({epoch: 3, completed: 2, frames: [row(1), row(2, [pads[0], pads[3]])]});
    assert.match(t.failures[0], /Conflicting game frame/);

    // A rebuilt tab joins peer transport only when live, after retained inputs.
    t = await create('marioparty', {players: 2, slot: 1, recovery: {through: 90, checkpointFrame: 59}, hash: () => 77});
    t.session.start(); assert.equal(t.transport.started, 0);
    assert.equal(peer(t.session, 95, 0), false, 'a rebuilding tab does not take peer copies');
    t.session.receiveReplay({epoch: 3, start: 1, through: 90, frames: Array.from({length: 90}, (_, i) => row(i + 1))});
    for (let frame = 1; frame <= 91; frame++) t.session.frameReady(frame);
    assert.equal(t.sent('party_replay_ready').length, 1);
    t.session.replayLive({epoch: 3, completed: 90, inputsThrough: 94, paused: false});
    assert.equal(t.transport.started, 1); assert.equal(t.transport.relayConfirmed, 90);
    assert.equal(t.session.sentThrough, 94);
    t.session.frameReady(91);
    assert.equal(t.sent('input')[0].frame, 95, 'the replacement tab never rewrites retained inputs');
    t.session.receive(row(91)); assert.equal(t.session.frameReady(91), 1);
    for (const bad of [0, 1 + 129, 1.5]) {
        const r = await create('marioparty', {recovery: {through: 1, checkpointFrame: 0}});
        r.session.start(); r.session.receiveReplay({epoch: 3, start: 1, through: 1, frames: [row(1)]});
        r.session.frameReady(1); r.session.frameReady(2);
        r.session.replayLive({epoch: 3, completed: 1, inputsThrough: bad});
        assert.match(r.failures[0], /recovery position/);
    }
    console.log('PASS lockstep peer rows: early rows, relay verification, conflicts, checksum deferral, 120-frame cap, resume and rebuilt-tab handoff.');
})().catch(error => { console.error(error); process.exitCode = 1; });
