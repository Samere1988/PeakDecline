const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '../../static/js/tv_player.js'), 'utf8');
function fixture() {
    const events = {}, timers = [], nodes = new Map();
    let now = 100;
    const video = {paused: true, currentTime: 0, playbackRate: 1,
        addEventListener: (event, handler) => events[event] = handler,
        pause() { this.paused = true; }, play: () => Promise.resolve()};
    class Hls {
        static isSupported() { return true; }
        static Events = {MANIFEST_PARSED: 'manifest', LEVEL_UPDATED: 'level', ERROR: 'error'};
        constructor() { this.handlers = {}; }
        on(event, handler) { this.handlers[event] = handler; }
        loadSource() {} attachMedia() {} destroy() {}
    }
    const c = vm.createContext({console, Hls, AbortController, performance: {now: () => now},
        setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {},
        setInterval() {}, clearInterval() {}, io: () => ({}),
        document: {addEventListener() {}, getElementById(id) {
            if (id === 'video-player') return video;
            if (!nodes.has(id)) nodes.set(id, {textContent: '', value: ''});
            return nodes.get(id);
        }}, fetch: () => new Promise(() => {})});
    vm.runInContext(source, c);
    const run = code => vm.runInContext(code, c);
    run("currentChannelId=1;channelTitle.textContent='Sports';lastClockPoll=100;");
    return {c, run, video, events, timers, text: () => nodes.get('current-status-text').textContent,
        advance: ms => { now += ms; }};
}
async function main() {
    const clock = fixture();
    const clockText = id => clock.c.document.getElementById(id).textContent;
    clock.video.paused = false;
    clock.video.currentTime = 10;
    clock.run("clockSample={stream_start_pdt:1000};playerPhase='playing';updateLiveSyncDisplay(1000,1010.25)");
    assert.equal(clockText('live-server-time'), '00:10.2');
    assert.equal(clockText('live-viewer-time'), '00:10.0');
    assert.equal(clockText('live-sync-difference'), 'In sync · 0.3s behind');
    for (const drift of [-0.04, 0, 0.04]) {
        clock.video.currentTime = 10 + drift;
        clock.run('updateLiveSyncDisplay(1000,1010)');
        assert.equal(clockText('live-sync-difference'), 'In sync · 0.0s behind');
    }
    clock.video.currentTime = 12;
    clock.run('updateLiveSyncDisplay(1000,1010)');
    assert.equal(clockText('live-sync-difference'), 'Out of sync · 2.0s ahead');
    clock.video.paused = true;
    clock.run('updateLiveSyncDisplay(1000,1015)');
    assert.equal(clockText('live-sync-difference'), 'Paused · 3.0s behind');
    clock.run('clockSample=null;enforceLiveSync()');
    assert.equal(clockText('live-server-time'), '—');
    assert.equal(clockText('live-viewer-time'), '—');
    assert.equal(clockText('live-sync-difference'), 'Waiting for server timeline');
    clock.run('currentChannelId=null;updateLiveSyncDisplay(null,null)');
    assert.equal(clockText('live-sync-difference'), 'No active stream');
    // A ready manifest must start playback even without a shared-clock sample.
    const startup = fixture(); let startupPlays = 0;
    startup.video.play = () => { startupPlays++; return Promise.resolve(); };
    startup.run('initPlayer();hls.levels=[{height:1080}];hls.handlers.manifest()');
    assert.equal(startupPlays, 1);
    assert.equal(startup.run('clockSample'), null);
    // A replaced player's manifest must never start the current player.
    startup.run('const oldManifest=hls.handlers.manifest;initPlayer();oldManifest()');
    assert.equal(startupPlays, 1);
    const f = fixture();
    f.run('initPlayer();lastClockPoll=100;enforceLiveSync()');
    assert.equal(f.text(), 'Loading Sports…');
    f.timers[0](); assert.match(f.text(), /Taking longer/);
    f.video.paused = false; f.events.playing();
    assert.equal(f.text(), 'Now playing Sports');
    f.run('enforceLiveSync()'); assert.equal(f.text(), 'Now playing Sports');
    f.advance(3100); f.run("showSyncStatus('LIVE')"); assert.equal(f.text(), 'LIVE');
    f.events.waiting(); f.run("showSyncStatus('LIVE')"); assert.match(f.text(), /Buffering/);
    f.events.playing(); assert.equal(f.text(), 'Now playing Sports');
    f.video.paused = true; f.events.pause(); assert.match(f.text(), /Paused/);
    f.video.play = () => Promise.reject(new Error('autoplay'));
    f.run('safePlay()'); await new Promise(setImmediate);
    f.run("showSyncStatus('LIVE')"); assert.equal(f.text(), 'Press Play to join live');
    f.run("hls.handlers.error(null,{fatal:true});showSyncStatus('LIVE')");
    assert.match(f.text(), /Press Play to reconnect/);
    // A timeout queued for an old channel cannot replace the new channel's status.
    f.run('initPlayer()'); const oldTimer = f.timers.at(-1);
    f.run("channelTitle.textContent='News';initPlayer()"); oldTimer();
    assert.equal(f.text(), 'Loading News…');
    const g = fixture();
    g.c.fetch = async () => ({ok: false, json: async () => ({error: 'internal secret'})});
    const request = g.run("playChannel(2, 'News')");
    assert.equal(g.text(), 'Switching to News…');
    await request; g.run("showSyncStatus('LIVE')");
    assert.equal(g.text(), 'Unable to switch to News. Try again or choose another channel.');
    // A canceled timer from the same channel and phase must not replace a newer message.
    const t = fixture();
    t.run("showPlayerStatus('loading','Old load')"); const canceled = t.timers.at(-1);
    t.run("showPlayerStatus('loading','New load')"); canceled();
    assert.equal(t.text(), 'New load');
    // Muted autoplay notices survive clock ticks, and clear after sound activation.
    const m = fixture(); let plays = 0;
    m.video.play = () => ++plays === 1 ? Promise.reject(Object.assign(new Error('policy'),{name:'NotAllowedError'}))
        : (m.video.paused = false, Promise.resolve());
    m.run('safePlay()'); await new Promise(setImmediate);
    m.run("showSyncStatus('LIVE')"); assert.match(m.text(), /Playing muted/);
    m.video.muted = false; m.events.volumechange(); m.run("showSyncStatus('LIVE')");
    assert.equal(m.text(), 'LIVE');
    // Late success/failure from a prior channel's muted fallback cannot change status.
    for (const reject of [false,true]) {
        const stale=fixture(); let settle,attempts=0;
        stale.video.play=()=>++attempts===1?Promise.reject(new Error('policy'))
            :new Promise((resolve,fail)=>{settle=reject?fail:resolve;});
        stale.run('safePlay()');await new Promise(setImmediate);
        stale.run("generation++;showPlayerStatus('loading','Loading next channel…')");
        settle();await new Promise(setImmediate);
        assert.equal(stale.text(),'Loading next channel…');
    }
    const a=fixture(); a.video.play=()=>Promise.reject(Object.assign(new Error('interrupted'),{name:'AbortError'}));
    a.run("showPlayerStatus('paused','Paused');safePlay()");await new Promise(setImmediate);
    assert.equal(a.text(),'Paused');
    // Startup failure, native decoder failure, and end of stream have distinct feedback.
    const e=fixture();e.c.fetch=async()=>({ok:false});
    e.run('currentChannelId=null');await e.run('refreshLiveStatus()');
    assert.equal(e.text(),'Unable to check live TV. Refresh to try again.');
    e.run('currentChannelId=1;hls=null');e.events.error();assert.match(e.text(),/Press Play to reconnect/);
    e.run("showPlayerStatus('playing','LIVE')");e.events.ended();assert.match(e.text(),/Press Play to reconnect/);
    e.run("showPlayerStatus('loading','Loading');startupPending=true");e.events.playing();
    assert.equal(e.text(),'Loading','paused elements cannot report successful playback');
    // Fatal errors while actively playing report recovery; while paused they require Play.
    const r=fixture();r.run('initPlayer()');r.video.paused=false;
    r.run('hls.handlers.error(null,{fatal:true})');assert.match(r.text(),/Reconnecting/);
    const d=fixture();d.video.paused=false;d.video.seeking=true;
    d.run("programOffset=()=>1000;sharedTarget=()=>1010;showPlayerStatus('playing','LIVE');enforceLiveSync()");
    assert.equal(d.text(),'Aligning with live…');
    d.video.currentTime=10;d.run('enforceLiveSync()');assert.equal(d.text(),'LIVE');
    d.run('sharedTarget=()=>null;enforceLiveSync()');assert.equal(d.text(),'Playing — live sync temporarily unavailable');
    d.run("showPlayerStatus('buffering','Buffering');enforceLiveSync()");assert.equal(d.text(),'Buffering');
    const brief = fixture(); brief.video.paused = false;
    brief.run('hls={}');
    for (let i=0;i<5;i++) { brief.events.waiting(); brief.advance(100); brief.events.playing(); }
    brief.run('checkBufferingFallback(performance.now())');
    assert.equal(brief.run('fallbackRequested'), false, 'brief waits must retain Native');
    for (let i=0;i<3;i++) { brief.events.waiting(); brief.advance(1100); brief.events.playing(); }
    brief.run('checkBufferingFallback(performance.now())');
    assert.equal(brief.run('fallbackRequested'), true, 'repeated substantial stalls should use Auto');
    console.log('PASS loading, slow startup, success, buffering, pause, autoplay, recovery, stale timer and switch failure statuses');
    console.log('PASS status timer versions, muted notice persistence, stale autoplay promises, aborted play, status fetch failure, native error and ended feedback');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
