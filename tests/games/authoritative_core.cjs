const assert = require('node:assert/strict');
const {SnapshotHistory, PredictedClient, AuthoritativeHost, AuthoritativeSession, validFpsCommand} = require('../../static/js/netplay/authoritative.js');
const command = (moveX = 0, buttons = 0) => ({buttons, moveX, moveY: 0, lookX: 0, lookY: 0});
const interpolate = (a, b, alpha) => ({players: a.players.map((p, i) => ({x: p.x + (b.players[i].x - p.x) * alpha}))});
function gameAdapter(players = 2) {
    let local = {x: 0};
    return {
        sampleInput: () => command(60), captureLocal: () => local,
        restoreLocal: state => { local = state; },
        simulateLocal: (input, dt) => { local.x += input.moveX * dt; },
        selectLocalState: (state, slot) => state.players[slot],
        interpolateState: interpolate, renderState() {},
        createAuthority() {
            const state = {players: Array.from({length: players}, () => ({x: 0}))};
            return {step(inputs, dt) { inputs.forEach((input, slot) => {
                // The authority's wall intentionally corrects naive client prediction.
                state.players[slot].x = Math.min(20, state.players[slot].x + input.moveX * dt);
            }); }, captureState: () => state};
        }
    };
}
assert.equal(validFpsCommand(command()), true);
assert.equal(validFpsCommand({...command(), lookX: NaN}), false);
assert.equal(validFpsCommand({...command(), buttons: -1}), false);
assert.equal(validFpsCommand({...command(), moveX: 128}), false);

const history = new SnapshotHistory(3);
for (let tick = 0; tick < 5; tick++) history.push(tick, {players: [{x: tick * 10}]});
assert.equal(history.rows.length, 3);
assert.equal(history.sample(2.5, interpolate).players[0].x, 25);
assert.equal(history.sample(20, interpolate).players[0].x, 40);
assert.equal(history.rewind(0, 4, 1).tick, 3);
assert.equal(history.rewind(5, 4, 1), null);
const past = history.rewind(3, 4, 1); past.state.players[0].x = 1000;
assert.equal(history.rows[1].state.players[0].x, 30, 'Rewind queries cannot mutate live history.');

const adapter = gameAdapter(1), client = new PredictedClient({adapter, slot: 0, tickRate: 60, maxPending: 3});
client.predict(0); client.predict(0); client.predict(0);
assert.equal(client.predict(0), null, 'Unacknowledged input history is bounded.');
client.reconcile({tick: 1, acks: [1], state: {players: [{x: 0}]}});
assert.equal(adapter.captureLocal().x, 2, 'Correct position, then replay only unacknowledged commands.');
assert.equal(client.reconcile({tick: 0, acks: [0], state: {players: [{x: 99}]}}), false);
assert.throws(() => client.reconcile({tick: 2, acks: [9], state: {players: [{x: 0}]}}));

let rewindHit, shots = 0;
const world = {players: [{x: 0}]};
const host = new AuthoritativeHost({players: 1, tickRate: 60, maxRewindTicks: 3, adapter: {
    captureState: () => world,
    step(inputs, dt, context) {
        world.players[0].x++;
        if (inputs[0].buttons) { shots++; rewindHit = context.rewindFor(0); }
    }
}});
for (let i = 0; i < 8; i++) host.advance();
host.receive(0, {seq: 1, viewTick: 0, command: command(0, 1)});
host.advance(); host.advance();
assert.equal(shots, 1, 'Missing packets cannot repeat one-shot actions.');
assert.equal(rewindHit.tick, 5, 'Old hit claims are bounded by the rewind window.');
assert.equal(rewindHit.state.players[0].x, 5);
assert.equal(world.players[0].x, 10, 'Hit queries leave the current world untouched.');

// Simulated delayed relay: authority, guest, and spectator exercise the actual
// session lifecycle, sequence acknowledgements, bounded prediction and renders.
let now = 0, order = 0;
const pending = [], sessions = [], errors = [], sent = [0, 0, 0];
const game = {inputSchema: 'fps-command-v1', tickRate: 60, authoritative: {
    historyTicks: 120, maxPending: 64, maxRewindTicks: 12, snapshotInterval: 3, interpolationTicks: 6
}};
function queue(delay, fn) { pending.push({at: now + delay, order: ++order, fn}); }
function deliver() {
    pending.sort((a, b) => a.at - b.at || a.order - b.order);
    while (pending[0]?.at <= now) pending.shift().fn();
}
try {
    for (let slot = 0; slot < 3; slot++) {
        const socket = {emit(event, packet) {
            if (event === 'fps_command') {
                sent[slot]++;
                queue(35, () => sessions[0].receiveCommand({...packet, slot}));
            } else if (event === 'world_snapshot') {
                assert.equal(slot, 0);
                for (const peer of sessions) queue(55, () => peer.receiveSnapshot(structuredClone(packet)));
            }
        }};
        const session = new AuthoritativeSession({socket, game, epoch: 4, players: 2, slot,
            spectator: slot === 2, onFailure: error => errors.push(error), clock: () => now});
        sessions.push(session); session.bind(gameAdapter());
    }
    sessions.forEach(session => session.start());
    for (let step = 0; step < 500; step++) {
        now = step * 17; deliver();
        sessions.forEach(session => { session.advance(); session.render(); });
    }
    assert.deepEqual(errors, []);
    assert.equal(sent[2], 0);
    for (const session of sessions.slice(0, 2)) {
        assert.ok(session.client.ack > 400);
        assert.ok(session.client.pending.length < 12);
        assert.ok(session.adapter.captureLocal().x >= 20 && session.adapter.captureLocal().x < 32);
    }
    const tick = sessions[1].lastSnapshot;
    sessions[1].receiveSnapshot({epoch: 3, tick: tick + 1000, acks: [0, 0], state: {}});
    assert.equal(sessions[1].lastSnapshot, tick, 'Old epochs cannot affect a restarted game.');
    sessions.forEach(session => session.dispose());
    assert.ok(sessions.every(session => session.history.rows.length === 0));
    console.log('FPS authority, delayed prediction/reconciliation, interpolation, bounded rewind, spectators, epochs and disposal passed.');
} finally { sessions.forEach(session => session.dispose()); }

// Late spectators start from a full current checkpoint, not a tick-zero replay.
{
    const delivered=[], failures=[];
    const late=new AuthoritativeSession({socket:{emit(){}},game,epoch:7,players:2,slot:null,spectator:true,
        onFailure:error=>failures.push(error),clock:()=>1000});
    try {
        late.bind({...gameAdapter(),onGameplayEvent:event=>delivered.push(event.id)});
        late.receiveSnapshot({epoch:7,tick:20,acks:[0,0],state:{players:[{x:1},{x:2}]}});
        assert.equal(late.lastSnapshot,-1,'Snapshots received before start must not initialize a viewer');
        late.start();
        late.receiveBootstrap({epoch:7,tick:20,acks:[0,0],state:{players:[{x:1},{x:2}]},eventCursor:9});
        assert.equal(late.lastSnapshot,20);assert.equal(late.events.last,9);assert.equal(late.client,undefined);
        late.receiveSnapshot({epoch:7,tick:21,acks:[0,0],baseTick:20,changed:{players:[{x:2},{x:3}]},removed:[],
            events:[{id:10,tick:21,type:'shot',data:{}}]});
        assert.deepEqual(delivered,[10]);
        late.receiveBootstrap({epoch:7,tick:22,acks:[0,0],state:{players:[]},eventCursor:999});
        assert.equal(late.events.last,10,'Duplicate bootstraps cannot skip effects');
        assert.deepEqual(failures,[]);
    } finally {late.dispose();}
}
console.log('Late spectator checkpoint and event-cursor initialization passed.');

// Reconnect retries unreceived inputs in sequence without replacing the engine.
{
    let clock=0;
    const sent=[], failures=[];
    const peer=new AuthoritativeSession({socket:{emit:(event,data)=>sent.push({event,data})},game,epoch:8,players:2,slot:1,spectator:false,
        onFailure:error=>failures.push(error),clock:()=>clock});
    try{
        peer.bind(gameAdapter());peer.start();
        peer.receiveSnapshot({epoch:8,tick:0,acks:[0,0],state:{players:[{x:0},{x:0}]}});
        peer.advance();clock=17;peer.advance();
        assert.equal(peer.client.sequence,2);
        peer.suspendTransport();clock=60000;
        assert.equal(peer.advance(),false);assert.equal(peer.client.sequence,2);
        peer.requestRecovery();
        assert.equal(peer.recovering,true);
        peer.resumeTransport({epoch:8,received:[0,1],members:[{slot:0,connected:true}],
            baseline:{tick:1,acks:[0,1],state:{players:[{x:0},{x:1}]},eventCursor:0}});
        assert.equal(peer.transportSuspended,false);
        assert.equal(peer.recovering,false,'Reconnect checkpoint must supersede an interrupted recovery');
        assert.equal(peer.lastSnapshot,1);
        assert.deepEqual(sent.filter(p=>p.event==='fps_command').map(p=>p.data.seq),[1,2,2]);
        assert.deepEqual(peer.client.pending.map(p=>p.seq),[2]);
        assert.deepEqual(failures,[]);
    }finally{peer.dispose();}
}
console.log('Reconnect pause, sequence retry and retained prediction state passed.');

// A missing delta base requests a full checkpoint instead of killing the room.
{
    const sent=[],delivered=[],failures=[];
    const watcher=new AuthoritativeSession({socket:{emit:(event,data)=>sent.push({event,data})},game,epoch:9,players:2,slot:null,spectator:true,
        onFailure:error=>failures.push(error),clock:()=>0});
    try{
        watcher.bind({...gameAdapter(),onGameplayEvent:e=>delivered.push(e.id)});watcher.start();
        watcher.receiveSnapshot({epoch:9,tick:0,acks:[0,0],state:{players:[{x:0},{x:0}]}});
        const missing={epoch:9,tick:6,acks:[0,0],baseTick:3,changed:{players:[{x:6},{x:6}]},removed:[]};
        watcher.receiveSnapshot(missing);watcher.receiveSnapshot(missing);
        assert.equal(watcher.failed,false);assert.equal(watcher.lastSnapshot,0);
        assert.equal(sent.filter(p=>p.event==='world_resync').length,1,'Recovery requests must be rate limited');
        watcher.receiveRecovery({epoch:9,tick:6,acks:[0,0],state:{players:[{x:6},{x:6}]},eventCursor:2,
            events:[{id:1,tick:3,type:'shot',data:{}},{id:2,tick:6,type:'explosion',data:{}}]});
        assert.equal(watcher.lastSnapshot,6);assert.deepEqual(delivered,[1,2]);
        watcher.receiveSnapshot({epoch:9,tick:9,acks:[0,0],baseTick:6,changed:{players:[{x:9},{x:9}]},removed:[],
            events:[{id:3,tick:9,type:'shot',data:{}}]});
        assert.deepEqual(delivered,[1,2,3]);assert.equal(watcher.metrics.recoveries,1);
        assert.deepEqual(failures,[]);
    }finally{watcher.dispose();}
}
console.log('Missing delta baseline recovered without duplicate gameplay effects.');
