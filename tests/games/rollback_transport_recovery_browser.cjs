/* Baseline/candidate transport measurement through real local Chromium RTC.
 * Impairment is applied to packets by input frame and elapsed episode time,
 * never by packet count: retransmission/ACK changes do not change the loss
 * schedule. No game, WASM, physical controller or screen latency is measured.
 *
 * ROLLBACK_TRANSPORT_SOURCE selects a frozen or candidate transport JS file.
 * ROLLBACK_TRANSPORT_REPORT writes the machine-readable results.
 * ROLLBACK_RECOVERY_EXPECT=baseline|candidate enables behavioral assertions.
 */
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const assert = require('node:assert/strict');
const sourcePath = path.resolve(process.env.ROLLBACK_TRANSPORT_SOURCE || path.join(__dirname, '../../static/js/netplay/rollback_transport.js'));
const source = fs.readFileSync(sourcePath, 'utf8');
const config = {
    episodes: Number(process.env.ROLLBACK_RECOVERY_EPISODES || 12),
    recoveryEpisodes: Number(process.env.ROLLBACK_RECOVERY_RECONNECT_EPISODES || 4),
    cleanFrames: 8, transitMs: 40, relayStallMs: 160, burstMs: 80,
    reconnectDeadlineMs: Number(process.env.ROLLBACK_RECOVERY_DEADLINE_MS || 3000),
    scenarios: (process.env.ROLLBACK_RECOVERY_SCENARIOS || 'clean,lost-final,burst-stalled,connection-failure').split(','),
    diagnostic: process.env.ROLLBACK_RECOVERY_DIAGNOSTIC === '1',
    baselineTimerControl: process.env.ROLLBACK_RECOVERY_BASELINE_TICK === '1'
};
assert.ok(Number.isInteger(config.episodes) && config.episodes >= 1 && config.episodes <= 100);
assert.ok(Number.isInteger(config.recoveryEpisodes) && config.recoveryEpisodes >= 1 && config.recoveryEpisodes <= 20);
assert.ok(Number.isInteger(config.reconnectDeadlineMs) && config.reconnectDeadlineMs >= 1000 && config.reconnectDeadlineMs <= 20000);
assert.ok(config.scenarios.length && config.scenarios.every(s => ['clean', 'lost-final', 'burst-stalled', 'connection-failure'].includes(s)));
(async () => {
    const browser = await chromium.launch({headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined});
    try {
        const page = await browser.newPage(), pageErrors = [];
        page.on('pageerror', error => pageErrors.push(String(error)));
        await page.addScriptTag({content: 'window.PeakNet={};'});
        await page.addScriptTag({content: source});
        const report = await page.evaluate(async config => {
            const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
            const round = n => n === null ? null : Math.round(n * 100) / 100;
            function summarize(values) {
                const ordered = values.filter(Number.isFinite).sort((a, b) => a - b);
                const percentile = p => ordered.length ? round(ordered[Math.ceil(ordered.length * p) - 1]) : null;
                return {count: ordered.length, medianMs: percentile(.5), p95Ms: percentile(.95), p99Ms: percentile(.99), maxMs: ordered.length ? round(ordered.at(-1)) : null};
            }
            function packetFrames(buffer) {
                if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 12) throw Error('Unexpected transport packet');
                const view = new DataView(buffer), version = view.getUint8(4), count = view.getUint8(5);
                const header = version === 1 ? 12 : version === 2 ? 20 : 0;
                if (!header || buffer.byteLength !== header + count * 8 || count > 8) throw Error('Unbounded or unknown transport packet');
                return {version, frames: Array.from({length: count}, (_, i) => view.getUint32(header + i * 8))};
            }
            let nextEpoch = 1;
            async function pair(mode) {
                const epoch = nextEpoch++, ready = new Set(), sockets = [], transports = [], timers = new Set(), controls = [];
                const first = new Map(), rtc = new Map(), sampled = new Map(), channels = [[], []];
                let currentFrame = 1, disposed = false, targetAt = null, closedAt = null, reopenedAt = null, relayDeliveryAt = 0;
                const stats = {packets: 0, inputPackets: 0, ackPackets: 0, bytes: 0, dropped: 0, signaling: 0, maxPacketBytes: 0};
                const timing = {relayLateness: [], rtcTimerLateness: [], maintain: [], send: [], receivePacket: []};
                const droppedOriginal = new Set(), versions = new Set(), channelOptions = [];
                function schedule(callback, ms, samples = null) {
                    const due = performance.now() + ms;
                    const timer = setTimeout(() => {
                        timers.delete(timer);
                        if (!disposed) {
                            if (samples) samples.push(performance.now() - due);
                            callback();
                        }
                    }, ms);
                    timers.add(timer); return timer;
                }
                function receive(frame, pad, route) {
                    const expected = {buttons: frame % 65536, x: frame % 70, y: -(frame % 70)};
                    if (pad.buttons !== expected.buttons || pad.x !== expected.x || pad.y !== expected.y) throw Error('Input payload mismatch');
                    const arrival = {at: performance.now(), route};
                    if (!first.has(frame)) first.set(frame, arrival);
                    if (route === 'rtc' && !rtc.has(frame)) rtc.set(frame, arrival);
                }
                function instrument(channel, slot) {
                    if (channel.__recoveryMeasured) return channel;
                    channel.__recoveryMeasured = true; channels[slot].push(channel);
                    channelOptions.push({ordered: channel.ordered, maxRetransmits: channel.maxRetransmits, label: channel.label});
                    channel.addEventListener('open', () => {
                        if (slot === 0 && closedAt !== null && reopenedAt === null) reopenedAt = performance.now();
                    });
                    const nativeSend = channel.send.bind(channel);
                    channel.send = buffer => {
                        const {version, frames} = packetFrames(buffer); versions.add(version);
                        stats.packets++; stats.bytes += buffer.byteLength; stats.maxPacketBytes = Math.max(stats.maxPacketBytes, buffer.byteLength);
                        if (frames.length) stats.inputPackets++; else stats.ackPackets++;
                        const containsTarget = slot === 0 && frames.includes(1);
                        let drop = false;
                        if (containsTarget && mode === 'lost-final' && !droppedOriginal.has(1)) {
                            droppedOriginal.add(1); drop = true;
                        }
                        if (containsTarget && mode === 'burst-stalled' && performance.now() - targetAt < config.burstMs) drop = true;
                        if (drop) { stats.dropped++; return; }
                        const copy = buffer.slice(0);
                        schedule(() => {
                            if (channel.readyState !== 'open') return;
                            try { nativeSend(copy); } catch (error) {
                                if (channel.readyState === 'open') throw error;
                            }
                        }, config.transitMs, config.diagnostic ? timing.rtcTimerLateness : null);
                    };
                    return channel;
                }
                class Socket {
                    constructor(slot) { this.slot = slot; this.listeners = new Map(); }
                    on(name, fn) { const list = this.listeners.get(name) || []; list.push(fn); this.listeners.set(name, list); }
                    off(name, fn) { this.listeners.set(name, (this.listeners.get(name) || []).filter(f => f !== fn)); }
                    receive(name, event) { for (const fn of this.listeners.get(name) || []) fn(event); }
                    emit(name, event) {
                        if (disposed) return;
                        if (name === 'rollback_connect') {
                            ready.add(this.slot);
                            queueMicrotask(() => { if (!disposed) this.receive('rollback_transport', {epoch, slot: this.slot, players: 2, peers: [...ready], iceServers: []}); });
                            for (const other of ready) if (other !== this.slot) queueMicrotask(() => {
                                if (!disposed) sockets[other].receive('rollback_peer', {epoch, slot: this.slot});
                            });
                        } else if (name === 'rollback_signal') {
                            stats.signaling++;
                            if (event.epoch !== epoch || event.to !== 1 - this.slot || !ready.has(event.to)) throw Error('Invalid signaling target');
                            // Simulated authenticated signaling derives sender from this
                            // socket. Generation and restart fields pass through unchanged.
                            queueMicrotask(() => { if (!disposed) sockets[event.to].receive(name, {...event, from: this.slot}); });
                        }
                    }
                }
                for (let slot = 0; slot < 2; slot++) sockets.push(new Socket(slot));
                for (let slot = 0; slot < 2; slot++) {
                    function PeerConnection(options) {
                        const pc = new RTCPeerConnection(options), create = pc.createDataChannel.bind(pc);
                        pc.createDataChannel = (...args) => instrument(create(...args), slot);
                        pc.addEventListener('datachannel', event => instrument(event.channel, slot));
                        return pc;
                    }
                    transports.push(new PeakNet.RollbackInputTransport({socket: sockets[slot], epoch, players: 2, slot, spectator: false,
                        frame: () => currentFrame, PeerConnection,
                        receiveInput: event => {
                            if (event.epoch !== epoch || event.slot !== 1 - slot) throw Error('Wrong input identity');
                            if (slot === 1) receive(event.frame, event.pad, 'rtc');
                        }}));
                    if (config.diagnostic) {
                        const transport = transports.at(-1);
                        for (const name of ['maintain', 'send', 'receivePacket']) if (typeof transport[name] === 'function') {
                            const original = transport[name].bind(transport);
                            transport[name] = (...args) => {
                                const start = performance.now();
                                try { return original(...args); }
                                finally { timing[name].push(performance.now() - start); }
                            };
                        }
                    }
                }
                const setupAt = performance.now();
                for (const transport of transports) {
                    if (config.baselineTimerControl && typeof transport.maintain !== 'function')
                        controls.push(setInterval(() => {}, 16));
                    transport.start();
                }
                while (transports.some(t => t.diagnostics().openPeers !== 1)) {
                    if (performance.now() - setupAt > 10000) throw Error('Initial RTC setup timed out');
                    await pause(5);
                }
                const setupMs = performance.now() - setupAt;
                function send(frame, relayExtra = 0) {
                    currentFrame = frame;
                    const at = performance.now(), pad = {buttons: frame % 65536, x: frame % 70, y: -(frame % 70)};
                    sampled.set(frame, at); if (frame === 1) targetAt = at;
                    if (!transports[0].canSend(frame)) throw Error('Relay lead unexpectedly exceeded');
                    // A real frameset requires both player submissions. Keep
                    // both sender high-water marks valid for the v2 ACKs while
                    // measuring only slot 0 -> slot 1 input arrival.
                    transports[0].send(frame, pad);
                    transports[1].send(frame, pad);
                    relayDeliveryAt = Math.max(relayDeliveryAt, at + config.transitMs + relayExtra);
                    schedule(() => {
                        receive(frame, pad, 'relay');
                        for (const socket of sockets) socket.receive('frameset', {epoch, frame, pads: [pad, pad]});
                    }, Math.max(0, relayDeliveryAt - performance.now()), config.diagnostic ? timing.relayLateness : null);
                }
                function closeChannel() {
                    closedAt = performance.now();
                    const channel = channels[0].findLast(channel => channel.readyState === 'open');
                    if (!channel) throw Error('Missing open channel at failure injection');
                    channel.close();
                }
                function result(extra = {}) {
                    const frames = [...sampled.keys()];
                    if (frames.some(frame => !first.has(frame))) throw Error('Input was not delivered by either path');
                    if (stats.packets > 2000 || stats.signaling > 256) throw Error('Unbounded repair or negotiation loop');
                    return {...extra, mode, setupMs: round(setupMs), inputs: frames.length, received: frames.length,
                        rtcFirst: frames.filter(frame => first.get(frame).route === 'rtc').length,
                        rtcReceived: frames.filter(frame => rtc.has(frame)).length,
                        inputMs: summarize(frames.map(frame => first.get(frame).at - sampled.get(frame))),
                        rtcInputMs: summarize(frames.filter(frame => rtc.has(frame)).map(frame => rtc.get(frame).at - sampled.get(frame))),
                        inputSamplesMs: frames.map(frame => round(first.get(frame).at - sampled.get(frame))),
                        rtcInputSamplesMs: frames.filter(frame => rtc.has(frame)).map(frame => round(rtc.get(frame).at - sampled.get(frame))),
                        options: channelOptions, protocolVersions: [...versions], packets: {...stats},
                        timing: config.diagnostic ? Object.fromEntries(Object.entries(timing).map(([name, samples]) => [name, {...summarize(samples), totalMs: round(samples.reduce((a, b) => a + b, 0))}])) : undefined,
                        visibility: config.diagnostic ? document.visibilityState : undefined,
                        metrics: transports.map(t => t.diagnostics())};
                }
                function dispose() {
                    disposed = true; for (const timer of timers) clearTimeout(timer); timers.clear();
                    for (const timer of controls) clearInterval(timer);
                    for (const transport of transports) transport.dispose();
                }
                return {send, closeChannel, result, dispose, first, rtc, sampled,
                    reopened: () => reopenedAt === null ? null : reopenedAt - closedAt};
            }
            const cases = [];
            for (const mode of ['clean', 'lost-final', 'burst-stalled']) {
                if (!config.scenarios.includes(mode)) continue;
                const episodes = [];
                for (let index = 0; index < config.episodes; index++) {
                    const test = await pair(mode);
                    try {
                        if (mode === 'clean') {
                            for (let frame = 1; frame <= config.cleanFrames; frame++) { test.send(frame); await pause(1000 / 60); }
                            await pause(config.transitMs * 3);
                        } else {
                            test.send(1, config.relayStallMs);
                            // Deliberately no new gameplay input after the dropped tail.
                            await pause(config.transitMs + config.relayStallMs + 60);
                        }
                        episodes.push(test.result({episode: index + 1}));
                    } finally { test.dispose(); }
                }
                cases.push({scenario: mode, episodes: episodes.length, inputs: episodes.reduce((n, e) => n + e.inputs, 0),
                    received: episodes.reduce((n, e) => n + e.received, 0), rtcFirst: episodes.reduce((n, e) => n + e.rtcFirst, 0),
                    inputMs: summarize(episodes.flatMap(e => e.inputSamplesMs)),
                    rtcInputMs: summarize(episodes.flatMap(e => e.rtcInputSamplesMs)),
                    packets: episodes.reduce((result, e) => { for (const key of ['packets', 'inputPackets', 'ackPackets', 'bytes', 'dropped']) result[key] = (result[key] || 0) + e.packets[key]; return result; }, {}),
                    episodeResults: episodes});
            }
            const recoveries = [];
            for (let index = 0; index < (config.scenarios.includes('connection-failure') ? config.recoveryEpisodes : 0); index++) {
                const test = await pair('connection-failure');
                try {
                    test.closeChannel(); const failedAt = performance.now(); let frame = 0;
                    do {
                        test.send(++frame); await pause(50);
                    } while (test.reopened() === null && performance.now() - failedAt < config.reconnectDeadlineMs);
                    const reopenedMs = test.reopened();
                    // A delayed reliable probe distinguishes restored RTC from a
                    // relay that merely remains healthy throughout the outage.
                    const probe = ++frame; test.send(probe, config.relayStallMs);
                    await pause(config.transitMs + config.relayStallMs + 60);
                    recoveries.push(test.result({episode: index + 1, reopenedMs: round(reopenedMs),
                        deadlineMs: config.reconnectDeadlineMs, timedOut: reopenedMs === null,
                        probeFrame: probe, probeRtcReceived: test.rtc.has(probe), probeRoute: test.first.get(probe)?.route}));
                } finally { test.dispose(); }
            }
            return {config, cases, recovery: {episodes: recoveries.length, reopened: recoveries.filter(e => !e.timedOut).length,
                timeout: recoveries.filter(e => e.timedOut).length, reconnectMs: summarize(recoveries.map(e => e.reopenedMs)),
                restoredRtcProbes: recoveries.filter(e => e.probeRtcReceived).length, episodeResults: recoveries}};
        }, config);
        assert.deepEqual(pageErrors, [], 'Browser errors during measurement');
        for (const row of report.cases) assert.equal(row.inputs, row.received);
        const episodes = [...report.cases.flatMap(row => row.episodeResults), ...report.recovery.episodeResults];
        for (const episode of episodes) {
            assert.equal(episode.inputs, episode.received);
            assert.ok(episode.options.every(option => option.ordered === false && option.maxRetransmits === 0));
            assert.ok(episode.metrics.every(metrics => metrics.invalidPackets === 0), 'Measurement must not inject invalid ACKs or inputs');
        }
        assert.ok(report.cases.filter(row => row.scenario !== 'clean').every(row => row.packets.dropped >= config.episodes));
        const expectation = process.env.ROLLBACK_RECOVERY_EXPECT;
        if (expectation === 'candidate') {
            for (const row of report.cases.filter(row => row.scenario !== 'clean')) assert.equal(row.rtcFirst, row.inputs, 'Repair must deliver stalled inputs before delayed relay');
            const expectedRecovery = config.scenarios.includes('connection-failure') ? config.recoveryEpisodes : 0;
            assert.equal(report.recovery.reopened, expectedRecovery, 'Every failed channel must reconnect');
            assert.equal(report.recovery.restoredRtcProbes, expectedRecovery, 'RTC inputs must resume after reconnect');
        } else if (expectation === 'baseline') {
            for (const row of report.cases.filter(row => row.scenario !== 'clean')) assert.equal(row.rtcFirst, 0);
            assert.equal(report.recovery.reopened, 0);
        }
        const output = {sourcePath, sourceSha256: crypto.createHash('sha256').update(source).digest('hex'),
            harnessSha256: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),
            browserVersion: await browser.version(),
            capturedAt: new Date().toISOString(), expectedBehavior: expectation || 'measurement-only',
            scope: 'Real local Chromium RTC. In-page authenticated-seat signaling fixture and application-emulated one-way transit/loss. Sample-to-input-arrival, not Internet, simulation or input-to-photon latency.',
            limitations: ['Independent episodes on one machine; small sample, not a production reliability estimate.',
                'Dropped original packet and fixed burst interval use input identity/time; ACK-only packets are not deliberately dropped.',
                'Reconnect timeout is censored: null latency means no recovery observed before deadline.',
                'Flask signaling authorization and native game correctness require separate integration tests.'], ...report};
        if (process.env.ROLLBACK_TRANSPORT_REPORT) {
            const destination = path.resolve(process.env.ROLLBACK_TRANSPORT_REPORT);
            fs.mkdirSync(path.dirname(destination), {recursive: true}); fs.writeFileSync(destination, JSON.stringify(output, null, 2));
        }
        console.log(JSON.stringify({sourcePath, sourceSha256: output.sourceSha256,
            cases: output.cases.map(({episodeResults, ...summary}) => summary),
            recovery: (({episodeResults, ...summary}) => summary)(output.recovery)}, null, 2));
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
