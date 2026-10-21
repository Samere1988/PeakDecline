/* Relay-only versus peer-input lockstep rows through real local Chromium RTC.
 * Every session uses the installed Wasm input core. An in-page relay applies the
 * rooms.py row order, input window, conflict and checksum rules. Each
 * client/relay direction is one ordered stream: a lost message arrives after a
 * fast-retransmit delay (one link round trip plus three 60 Hz messages) and
 * holds every later message on that stream, like TCP head-of-line blocking.
 * RTC copies get the same per-link loss and, by default, the same one-way delay
 * as the relay route, so clean timing is equal and differences come from loss.
 * Losses are keyed by stream, message type and frame, not by send count, so
 * both variants see the same relay loss schedule. No game runtime, rendering,
 * physical controller or Internet routing is measured.
 *
 * LOCKSTEP_BASELINE_SOURCE / LOCKSTEP_CANDIDATE_SOURCE select session.js files.
 * LOCKSTEP_GAME (fzerox|marioparty) selects the direct or retained row path.
 * LOCKSTEP_ONE_WAY_MS lists each seat's one-way delay to the relay; seat 0 hosts.
 * LOCKSTEP_SCENARIOS, LOCKSTEP_SECONDS and LOCKSTEP_REPETITIONS size the runs.
 * LOCKSTEP_NETWORK_REPORT writes JSON; LOCKSTEP_NETWORK_EXPECT=1 asserts results.
 */
const path = require('node:path'), fs = require('node:fs'), crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE ||
    path.join(process.env.HOME, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const root = path.resolve(__dirname, '../..');
const sources = {
    baseline: path.resolve(process.env.LOCKSTEP_BASELINE_SOURCE || path.join(root, '.tmp/lockstep-peer-20261021/baseline/session.js')),
    candidate: path.resolve(process.env.LOCKSTEP_CANDIDATE_SOURCE || path.join(root, 'static/js/netplay/session.js'))
};
const files = {
    '/transport.js': path.join(root, 'static/js/netplay/rollback_transport.js'),
    '/netplay.js': path.join(root, 'instance/netplay/build/netplay.js'),
    '/netplay.wasm': path.join(root, 'instance/netplay/build/netplay.wasm')
};
const scenarioLoss = {clean: 0, 'loss-1': 0.01, 'loss-3': 0.03, 'loss-1-no-rtc': 0.01, 'loss-1-rtc-dropped': 0.01};
// Fallbacks: a browser without RTCPeerConnection, and open channels that lose every packet.
const fallback = {'loss-1-no-rtc': 'unsupported', 'loss-1-rtc-dropped': 'dropped'};
const config = {
    game: process.env.LOCKSTEP_GAME || 'fzerox',
    seconds: Number(process.env.LOCKSTEP_SECONDS || 20),
    warmupSeconds: Number(process.env.LOCKSTEP_WARMUP_SECONDS || 2),
    repetitions: Number(process.env.LOCKSTEP_REPETITIONS || 3),
    oneWayMs: (process.env.LOCKSTEP_ONE_WAY_MS || '1,35,35').split(',').map(Number),
    scenarios: (process.env.LOCKSTEP_SCENARIOS || 'clean,loss-1,loss-3,loss-1-no-rtc,loss-1-rtc-dropped').split(','),
    rtcOneWayMs: process.env.LOCKSTEP_RTC_ONE_WAY_MS === undefined ? null : Number(process.env.LOCKSTEP_RTC_ONE_WAY_MS)
};
assert.ok(['fzerox', 'marioparty'].includes(config.game));
assert.ok(config.oneWayMs.length >= 2 && config.oneWayMs.length <= 4 && config.oneWayMs.every(ms => ms >= 0 && ms <= 500));
assert.ok(config.scenarios.length && config.scenarios.every(name => name in scenarioLoss));
assert.ok(config.seconds >= 5 && config.seconds <= 600 && config.repetitions >= 1 && config.repetitions <= 20);
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function run(browser, variant, scenario, repetition) {
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('http://lockstep.test/**', route => {
        const name = new URL(route.request().url()).pathname;
        if (name === '/') return route.fulfill({contentType: 'text/html', body: '<!doctype html><title>lockstep</title>'});
        const file = name === '/session.js' ? sources[variant] : files[name];
        if (!file) return route.fulfill({status: 404, body: ''});
        return route.fulfill({contentType: name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript', body: fs.readFileSync(file)});
    });
    await page.goto('http://lockstep.test/');
    for (const script of ['/netplay.js', '/session.js', '/transport.js']) await page.addScriptTag({url: script});
    const result = await page.evaluate(async ({config, scenario, loss, seed, peer, fallback}) => {
        const tickMs = 1000 / 60, players = config.oneWayMs.length, epoch = 1;
        const hash32 = text => { let h = 2166136261; for (let i = 0; i < text.length; ++i) h = Math.imul(h ^ text.charCodeAt(i), 16777619); return h >>> 0; };
        const keyed = key => { let t = hash32(seed + ':' + key) + 0x6D2B79F5; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
        let rtcState = hash32('rtc:' + seed) || 1;
        const rtcRandom = () => { rtcState ^= rtcState << 13; rtcState ^= rtcState >>> 17; rtcState ^= rtcState << 5; return (rtcState >>> 0) / 4294967296; };
        const linkLoss = slot => slot === 0 ? 0 : loss; // Seat 0 hosts beside the relay.
        const counts = {tcpLost: 0, tcpMessages: 0, rtcDropped: 0, rtcPackets: 0, rtcUntagged: 0};
        class Stream {
            constructor(id, oneWay, lossRate) { Object.assign(this, {id, oneWay, lossRate, last: 0, queue: [], timer: null}); }
            send(kind, frame, deliver) {
                const now = performance.now();
                let at = now + this.oneWay;
                counts.tcpMessages++;
                if (this.lossRate && frame !== undefined && keyed(`${this.id}:${kind}:${frame}`) < this.lossRate) {
                    counts.tcpLost++; at += 2 * this.oneWay + 3 * tickMs;
                }
                this.last = at = Math.max(at, this.last);
                this.queue.push({at, deliver});
                this.pump();
            }
            pump() {
                if (this.timer !== null || !this.queue.length) return;
                this.timer = setTimeout(() => {
                    this.timer = null;
                    while (this.queue.length && this.queue[0].at <= performance.now() + 0.5) this.queue.shift().deliver();
                    this.pump();
                }, Math.max(0, this.queue[0].at - performance.now()));
            }
        }
        const up = config.oneWayMs.map((ms, slot) => new Stream('up' + slot, ms, linkLoss(slot)));
        const down = config.oneWayMs.map((ms, slot) => new Stream('down' + slot, ms, linkLoss(slot)));
        const clone = value => JSON.parse(JSON.stringify(value));
        // Relay: rooms.py drain_inputs, input window, first-input-wins and checksum horizon.
        const relay = {inputs: new Map(), completed: 0, window: peer ? 128 : 16, hashes: new Map(), peers: new Set(),
            droppedInputs: 0, conflicts: 0, acceptedHashes: 0, droppedHashes: 0, desyncs: 0};
        const toClient = (slot, name, data, frame) => down[slot].send(name, frame, () => sockets[slot].dispatch(name, clone(data)));
        function relayReceive(slot, name, data) {
            if (name === 'input') {
                if (!(relay.completed < data.frame && data.frame <= relay.completed + relay.window)) { relay.droppedInputs++; return; }
                if (!relay.inputs.has(data.frame)) relay.inputs.set(data.frame, new Array(players).fill(null));
                const row = relay.inputs.get(data.frame);
                if (row[slot] && JSON.stringify(row[slot]) !== JSON.stringify(data.pad)) { relay.conflicts++; return; }
                row[slot] = data.pad;
                while (relay.inputs.get(relay.completed + 1)?.every(pad => pad)) {
                    const frame = ++relay.completed, pads = relay.inputs.get(frame);
                    relay.inputs.delete(frame);
                    for (let to = 0; to < players; ++to) toClient(to, 'frameset', {epoch, frame, pads}, frame);
                }
            } else if (name === 'hash') {
                if (data.frame < relay.completed - 120 || data.frame > relay.completed) { relay.droppedHashes++; return; }
                relay.acceptedHashes++;
                if (!relay.hashes.has(data.frame)) relay.hashes.set(data.frame, new Map());
                const row = relay.hashes.get(data.frame); row.set(slot, data.hash);
                if (row.size === players && new Set(row.values()).size !== 1) relay.desyncs++;
            } else if (name === 'rollback_connect') {
                const first = !relay.peers.has(slot); relay.peers.add(slot);
                toClient(slot, 'rollback_transport', {epoch, slot, players, peers: [...relay.peers], iceServers: []});
                if (first) for (const other of relay.peers) if (other !== slot) toClient(other, 'rollback_peer', {epoch, slot});
            } else if (name === 'rollback_signal') {
                if (relay.peers.has(data.to)) toClient(data.to, 'rollback_signal', {epoch, from: slot, to: data.to, generation: data.generation, type: data.type, value: data.value});
            }
        }
        class Socket {
            constructor(slot) { this.slot = slot; this.listeners = new Map(); }
            on(name, fn) { this.listeners.set(name, [...(this.listeners.get(name) || []), fn]); return this; }
            off(name, fn) { this.listeners.set(name, (this.listeners.get(name) || []).filter(f => f !== fn)); return this; }
            dispatch(name, data) { for (const fn of this.listeners.get(name) || []) fn(data); }
            emit(name, data) {
                if (name === 'rollback_signal' && ['offer', 'answer'].includes(data.type))
                    for (const pc of connections) if (pc.localDescription?.sdp === data.value) pc.meta = {from: this.slot, to: data.to};
                const copy = clone(data ?? null);
                up[this.slot].send(name, ['input', 'hash'].includes(name) ? data.frame : undefined, () => relayReceive(this.slot, name, copy));
                return this;
            }
        }
        // Real RTC with sender-side impairment, tagged to seats through signaled SDP.
        const connections = [], Native = RTCPeerConnection;
        const rtcDelay = meta => config.rtcOneWayMs ?? config.oneWayMs[meta.from] + config.oneWayMs[meta.to];
        const rtcLoss = meta => 1 - (1 - linkLoss(meta.from)) * (1 - linkLoss(meta.to));
        function impair(channel, pc) {
            if (channel.__impaired) return;
            channel.__impaired = true;
            const send = channel.send.bind(channel);
            channel.send = buffer => {
                counts.rtcPackets++;
                if (!pc.meta) { counts.rtcUntagged++; return send(buffer); }
                if (fallback === 'dropped' || rtcRandom() < rtcLoss(pc.meta)) { counts.rtcDropped++; return; }
                const copy = buffer.slice(0);
                setTimeout(() => { if (channel.readyState === 'open') try { send(copy); } catch (_) {} }, rtcDelay(pc.meta));
            };
        }
        window.RTCPeerConnection = fallback === 'unsupported' ? undefined : class extends Native {
            constructor(options) { super(options); connections.push(this); }
            createDataChannel(...args) { const channel = super.createDataChannel(...args); impair(channel, this); return channel; }
            set ondatachannel(fn) { super.ondatachannel = fn ? event => { impair(event.channel, this); fn(event); } : null; }
            get ondatachannel() { return super.ondatachannel; }
        };
        const sockets = [], sessions = [], failures = [], clients = [];
        for (let slot = 0; slot < players; ++slot) {
            const socket = new Socket(slot), client = {slot, frame: 1, sampled: 0, hash: 2166136261, hashes: new Map(), ticks: []};
            sockets.push(socket); clients.push(client);
            socket.on('frameset', event => sessions[slot].receive(event)); // lobby.js registers this before any transport.
            socket.on('start', () => sessions[slot].start());
            const core = await createPeakNetCore({locateFile: name => '/' + name});
            const session = new PeakNet.Session({socket, core, epoch, players, slot, spectator: false,
                game: {id: config.game, tickRate: 60, inputSchema: 'n64-pad-v1', lockstep: {peerInputs: true}},
                onFailure: message => failures.push({slot, message})});
            session.bind({sampleInput: () => {
                const n = ++client.sampled;
                return {buttons: (slot * 4099 + n * 31) & 65535, x: (n * 7 + slot * 13) % 161 - 80, y: (n * 11 + slot * 5) % 161 - 80};
            }, hashForFrame: frame => client.hashes.get(frame)});
            sessions.push(session);
        }
        for (let slot = 0; slot < players; ++slot) toClient(slot, 'start', {epoch});
        const t0 = performance.now() + 50, measureFrom = config.warmupSeconds * 60, totalTicks = (config.warmupSeconds + config.seconds) * 60;
        // One frame attempt per 60 Hz display tick, as a rAF-paced runtime would.
        await new Promise(resolve => {
            let tick = 0;
            const step = () => {
                for (const client of clients) {
                    const session = sessions[client.slot];
                    if (session.failed) continue;
                    const advanced = session.frameReady(client.frame) === 1;
                    if (advanced) {
                        for (const pad of session.getFrame(client.frame))
                            client.hash = Math.imul(client.hash ^ (pad.buttons + 65536 * (pad.x + 128) + 16777216 * (pad.y + 128)), 16777619) >>> 0;
                        client.hashes.set(client.frame, client.hash); client.frame++;
                    }
                    if (tick >= measureFrom) client.ticks.push(advanced ? 1 : 0);
                }
                if (++tick >= totalTicks) return resolve();
                setTimeout(step, Math.max(0, t0 + tick * tickMs - performance.now()));
            };
            setTimeout(step, Math.max(0, t0 - performance.now()));
        });
        // Let delayed relay rows confirm every early peer row before inspecting.
        await new Promise(resolve => setTimeout(resolve, 2500));
        const perClient = clients.map(client => {
            const freezes = []; let run = 0;
            for (const advanced of [...client.ticks, 1]) { if (advanced) { if (run) freezes.push(run); run = 0; } else run++; }
            const diagnostics = sessions[client.slot].diagnostics?.() ?? null;
            return {slot: client.slot, frames: client.frame - 1, measuredTicks: client.ticks.length,
                advancedTicks: client.ticks.reduce((n, v) => n + v, 0),
                freezes50: freezes.filter(n => n * tickMs >= 49).length, freezes100: freezes.filter(n => n * tickMs >= 99).length,
                longestFreezeMs: Math.round(Math.max(0, ...freezes) * tickMs), peerRows: diagnostics?.peerRows ?? 0,
                unconfirmedAtEnd: diagnostics?.unconfirmed ?? 0, openPeers: diagnostics?.transport?.openPeers ?? 0,
                invalidPackets: diagnostics?.transport?.invalidPackets ?? 0, failedPeers: diagnostics?.transport?.failedPeers ?? 0};
        });
        const common = Math.min(...clients.map(c => c.frame - 1));
        let hashMismatches = 0;
        for (let frame = 1; frame <= common; ++frame) if (new Set(clients.map(c => c.hashes.get(frame))).size !== 1) hashMismatches++;
        for (const session of sessions) session.dispose();
        return {perClient, commonFrames: common, hashMismatches, failures, counts,
            relay: {completed: relay.completed, droppedInputs: relay.droppedInputs, conflicts: relay.conflicts,
                acceptedHashes: relay.acceptedHashes, droppedHashes: relay.droppedHashes, desyncs: relay.desyncs}};
    }, {config, scenario, loss: scenarioLoss[scenario], seed: `${scenario}:${repetition}`, peer: variant === 'candidate', fallback: fallback[scenario] ?? null});
    await page.close();
    return {variant, scenario, repetition, errors, ...result};
}

const median = values => { const v = [...values].sort((a, b) => a - b); return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null; };
function summarize(runs) {
    const minutes = config.seconds / 60;
    const perRun = runs.map(run => {
        const c = run.perClient, ticks = c.reduce((n, p) => n + p.measuredTicks, 0);
        return {stalledTickPercent: 100 * (1 - c.reduce((n, p) => n + p.advancedTicks, 0) / ticks),
            freezes50PerMinute: c.reduce((n, p) => n + p.freezes50, 0) / c.length / minutes,
            freezes100PerMinute: c.reduce((n, p) => n + p.freezes100, 0) / c.length / minutes,
            longestFreezeMs: Math.max(...c.map(p => p.longestFreezeMs)),
            framesPerSecond: c.reduce((n, p) => n + p.advancedTicks, 0) / c.length / config.seconds,
            peerRowPercent: 100 * c.reduce((n, p) => n + p.peerRows, 0) / c.reduce((n, p) => n + p.frames, 0)};
    });
    const round = n => Math.round(n * 100) / 100;
    return Object.fromEntries(Object.keys(perRun[0]).map(key => [key, round(median(perRun.map(r => r[key])))]));
}

(async () => {
    const browser = await chromium.launch({headless: true,
        executablePath: process.env.BROWSER_PATH || path.join(process.env.HOME, '.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'),
        args: ['--disable-features=WebRtcHideLocalIpsWithMdns', '--disable-background-timer-throttling']});
    const runs = [];
    try {
        for (let repetition = 0; repetition < config.repetitions; ++repetition)
            for (const scenario of config.scenarios)
                // Alternate the order so neither variant always runs first.
                for (const variant of repetition % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
                    const result = await run(browser, variant, scenario, repetition);
                    runs.push(result);
                    const s = summarize([result]);
                    console.log(`${config.game} ${scenario} r${repetition} ${variant}: stalled ${s.stalledTickPercent}% ticks, ` +
                        `${s.freezes100PerMinute}/min freezes >=100 ms, longest ${s.longestFreezeMs} ms, ${s.framesPerSecond} fps, ` +
                        `peer rows ${s.peerRowPercent}%, failures ${result.failures.length}, hash mismatches ${result.hashMismatches}`);
                }
    } finally { await browser.close(); }
    const summary = {};
    for (const scenario of config.scenarios) summary[scenario] = Object.fromEntries(['baseline', 'candidate'].map(variant =>
        [variant, summarize(runs.filter(r => r.scenario === scenario && r.variant === variant))]));
    const report = {generated: new Date().toISOString(), browser: browser.version?.() ?? null, config,
        sources: Object.fromEntries(Object.entries({...sources, transport: files['/transport.js'], core: files['/netplay.wasm']})
            .map(([name, file]) => [name, {file: path.relative(root, file), sha256: sha(file)}])),
        harness: {file: path.relative(root, __filename), sha256: sha(__filename)}, summary, runs};
    console.log(JSON.stringify(summary, null, 2));
    if (process.env.LOCKSTEP_NETWORK_REPORT) {
        fs.mkdirSync(path.dirname(path.resolve(process.env.LOCKSTEP_NETWORK_REPORT)), {recursive: true});
        fs.writeFileSync(process.env.LOCKSTEP_NETWORK_REPORT, JSON.stringify(report, null, 2));
    }
    // Correctness holds for both variants in every run.
    for (const run of runs) {
        const label = `${run.variant} ${run.scenario} r${run.repetition}`;
        assert.deepEqual(run.errors, [], label); assert.deepEqual(run.failures, [], label);
        assert.equal(run.hashMismatches, 0, label); assert.ok(run.commonFrames > config.seconds * 30, label);
        assert.equal(run.relay.droppedInputs, 0, label); assert.equal(run.relay.conflicts, 0, label);
        assert.equal(run.relay.desyncs, 0, label); assert.equal(run.relay.droppedHashes, 0, label);
        assert.ok(run.perClient.every(c => c.unconfirmedAtEnd === 0), label + ': every early row was confirmed by the relay');
        if (run.variant === 'candidate' && fallback[run.scenario] === 'unsupported')
            assert.ok(run.perClient.every(c => c.peerRows === 0 && c.openPeers === 0), label + ': relay-only without RTC');
        else if (run.variant === 'candidate' && fallback[run.scenario] === 'dropped')
            assert.ok(run.perClient.every(c => c.peerRows === 0), label + ': relay rows when every copy is lost');
        else if (run.variant === 'candidate') {
            assert.equal(run.counts.rtcUntagged, 0, label);
            assert.ok(run.perClient.every(c => c.openPeers === config.oneWayMs.length - 1 && c.invalidPackets === 0), label);
            // With equal path delays, clean relay rows arrive with the peer copies.
            if (scenarioLoss[run.scenario] > 0) assert.ok(run.perClient.every(c => c.peerRows > 0), label);
        }
    }
    if (process.env.LOCKSTEP_NETWORK_EXPECT === '1') {
        for (const scenario of config.scenarios.filter(name => scenarioLoss[name] > 0 && !fallback[name])) {
            const {baseline, candidate} = summary[scenario];
            assert.ok(candidate.freezes100PerMinute < baseline.freezes100PerMinute, `${scenario}: fewer 100 ms freezes`);
            assert.ok(candidate.stalledTickPercent < baseline.stalledTickPercent, `${scenario}: fewer stalled ticks`);
        }
        // Clean links and failed RTC must not be worse than relay-only.
        for (const scenario of config.scenarios.filter(name => !scenarioLoss[name] || fallback[name]))
            assert.ok(summary[scenario].candidate.stalledTickPercent <= summary[scenario].baseline.stalledTickPercent + 1, `${scenario}: not worse`);
    }
    console.log('PASS lockstep peer-input network comparison: all runs correct' +
        (process.env.LOCKSTEP_NETWORK_EXPECT === '1' ? '; candidate reduced freezes under loss.' : '.'));
})().catch(error => { console.error(error); process.exitCode = 1; });
