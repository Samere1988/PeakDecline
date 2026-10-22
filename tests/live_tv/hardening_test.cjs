const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '../../static/js/tv_player.js'), 'utf8');
function fixture() {
    let now = 10000;
    const requests = [], timers = [], dispatched = [], frames = [], nodes = new Map();
    const v = {currentTime: 20, paused: true, playbackRate: 1, seeking: false, readyState: 4,
        buffered: {length: 0}, seekable: {length: 0}, addEventListener() {}, pause() {this.paused = true;},
        requestVideoFrameCallback(fn) {frames.push(fn); return frames.length;}, cancelVideoFrameCallback() {}};
    const c = vm.createContext({console, AbortController, performance: {now: () => now},
        setTimeout: fn => (timers.push(fn), timers.length), clearTimeout() {}, setInterval() {}, clearInterval() {},
        io: () => ({}), CustomEvent: class {constructor(type) {this.type = type;}},
        window: {dispatchEvent: event => dispatched.push(event.type)},
        document: {addEventListener() {}, getElementById(id) {
            if (id === 'video-player') return v;
            if (!nodes.has(id)) nodes.set(id, {dataset: {}, textContent: '', value: '', querySelectorAll: () => [], setAttribute() {}});
            return nodes.get(id);
        }}, fetch: () => new Promise(resolve => requests.push(resolve))});
    vm.runInContext(source, c);
    const run = code => vm.runInContext(code, c);
    run("currentChannelId=1;streamSession='abcd1234';streamEpoch='epoch';");
    const sample = {channel_id: 1, session: 'seg_abcd1234', stream_epoch: 'epoch', target_pdt: 1000, edge_pdt: 1006, max_extrapolation: 3, fresh: true};
    return {c, v, run, timers, frames, dispatched, advance: ms => now += ms,
        async poll(rtt, overrides = {}) {
            const done = run('pollLiveClock()'); now += rtt;
            requests.shift()({ok: true, json: async () => ({...sample, ...overrides})}); await done;
        }};
}
(async () => {
    const f = fixture();
    await f.poll(40); assert.equal(f.run('clockSample.rtt'), .04);
    f.advance(500); await f.poll(800, {target_pdt: 9999});
    assert.equal(f.run('clockSample.target_pdt'), 1000, 'queueing spike must not move the clock');
    f.advance(1000); await f.poll(50, {target_pdt: 1002});
    assert.equal(f.run('clockSample.target_pdt'), 1002, 'expired low RTT samples must be replaced');
    await f.poll(20, {fresh: false}); assert.equal(f.run('sharedTarget()'), null);
    f.run('refreshLiveStatus=()=>{}');
    await f.poll(20, {session: 'seg_old-session'}); assert.equal(f.run('clockSample.fresh'), false);
    console.log('PASS clock queueing spike filtering, expiry, stale source and session guard');

    const paused = fixture();
    paused.c.loads = [];
    paused.run("locallyPaused=true;renderChannels=()=>{};initPlayer=preserve=>loads.push(preserve);applyLiveState({is_streaming:true,current_channel_id:1,stream_epoch:'epoch',stream_revision:4,stream_session:'restarted'})");
    assert.deepEqual(paused.c.loads, [true]);
    console.log('PASS server encoder recovery preserves local pause');

    const frame = fixture();
    frame.run('startFrameTracking(generation)');
    frame.frames[0](10000, {mediaTime: 19.5, presentedFrames: 20});
    frame.run('recordLiveDiagnostics(1000,1020)');
    assert.equal(frame.c.window.liveTvDiagnostics.displayedDrift, .5);
    frame.run('generation++;displayedFrame=null');
    frame.frames[1](11000, {mediaTime: 99, presentedFrames: 21});
    assert.equal(frame.run('displayedFrame'), null);
    console.log('PASS displayed-frame diagnostics and stale callback guard');

    const recovery = fixture(); recovery.v.paused = false;
    for (let i = 0; i < 4; i++) recovery.run('schedulePlayerRecovery()');
    assert.equal(recovery.run('recoveryAttempts'), 3);
    assert.equal(recovery.v.paused, true);
    console.log('PASS fatal playback recovery is bounded');
    recovery.c.rebuilds = 0;
    recovery.run('initPlayer=()=>rebuilds++;safePlay()');
    assert.equal(recovery.c.rebuilds, 1);
    console.log('PASS explicit Play rebuilds a failed decoder before calling play');

    const stalled = fixture();
    stalled.run('hls={};bufferingSince=0;checkBufferingFallback(6000)');
    assert.equal(stalled.dispatched.length, 0);
    stalled.v.paused = false;
    stalled.run('checkBufferingFallback(6000);checkBufferingFallback(7000)');
    assert.deepEqual(stalled.dispatched, ['live-quality-fallback']);
    console.log('PASS sustained buffering requests one adaptive fallback and respects pause');
})().catch(error => {console.error(error); process.exitCode = 1;});
