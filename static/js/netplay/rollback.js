/* Optional deterministic rollback backend. Game state belongs to the adapter.
 * No Vita runtime or game-specific memory layout is embedded in this module. */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root?.PeakNet) {
        Object.assign(root.PeakNet, api);
        root.PeakNet.backends.set('rollback-v1', api.RollbackSession);
    }
})(typeof window !== 'undefined' ? window : null, () => {
    'use strict';
    const neutral = () => ({buttons: 0, x: 0, y: 0});
    const equal = (a, b) => a.buttons === b.buttons && a.x === b.x && a.y === b.y;
    const validPad = p => p && Number.isInteger(p.buttons) && p.buttons >= 0 && p.buttons <= 65535 &&
        ['x', 'y'].every(k => Number.isInteger(p[k]) && Math.abs(p[k]) <= 80);
    const copy = p => ({buttons: p.buttons, x: p.x, y: p.y});
    const integer = (n, low, high) => Number.isInteger(n) && n >= low && n <= high;

    // Preserve the order of brief local presses/releases while simulation is
    // stalled. Only unsent frames consume this queue; sent inputs stay immutable.
    class RollbackInputBuffer {
        constructor(limit = 8) {
            if (!integer(limit, 1, 32)) throw new Error('Invalid input edge buffer size.');
            this.limit = limit; this.dropped = 0; this.reset();
        }
        reset(pad = neutral()) {
            this.pending = []; this.observed = copy(pad); this.overflowed = false;
        }
        record(pad) {
            if (equal(this.observed, pad)) return;
            this.observed = copy(pad);
            // Keep the oldest ordered sequence. After overflow, return to the
            // live state when it drains instead of inserting reordered edges.
            if (this.overflowed || this.pending.length >= this.limit) {
                this.overflowed = true; ++this.dropped; return;
            }
            this.pending.push(copy(pad));
        }
        take(pad) {
            if (this.pending.length) return this.pending.shift();
            this.observed = copy(pad); this.overflowed = false;
            return copy(pad);
        }
    }

    class RollbackEngine {
        constructor({players, maxPrediction = 6, hashInterval = 1, adapter}) {
            if (!integer(players, 1, 4) || !integer(maxPrediction, 0, 12) || !integer(hashInterval, 1, 128))
                throw new Error('Invalid rollback configuration.');
            for (const name of ['saveState', 'restoreState', 'simulateFrame', 'hashState'])
                if (typeof adapter?.[name] !== 'function') throw new Error(`Rollback adapter requires ${name}().`);
            Object.assign(this, {players, maxPrediction, hashInterval, adapter});
            this.frame = 1; // Next simulation frame; snapshots contain its pre-frame state.
            this.confirmed = 0;
            this.actual = new Map();
            this.used = new Map();
            this.snapshots = new Map();
            this.hashes = new Map();
            this.baseline = Array.from({length: players}, neutral);
            this.dirty = null;
            this.confirmationBarrier = null;
            this.rollbacks = 0;
            this.replayedFrames = 0;
            this.lastStallReason = null;
            this.metrics = {saveMs: 0, saveCount: 0, restoreMs: 0, restoreCount: 0,
                replayMs: 0, replayCount: 0, hashMs: 0, hashCount: 0,
                stalls: {confirmation: 0, prediction: 0, adapter: 0, relay: 0}};
            this.disposed = false;
        }
        measure(name, operation) {
            const started = performance.now();
            try { return operation(); }
            finally { this.metrics[name + 'Ms'] += performance.now() - started; ++this.metrics[name + 'Count']; }
        }
        capture(frame, replaying) {
            const context = {frame, confirmed: this.confirmed, replaying};
            this.adapter.prepareFrame?.(context);
            // This opt-in promises that confirmed forward frames cannot need
            // a rewind. Still retain every speculative/replayed frame, including
            // one whose missing input arrives during a yielded native update.
            if (!replaying && frame <= this.confirmed && this.adapter.skipConfirmedSnapshots === true &&
                typeof this.adapter.prepareFrame === 'function') return;
            const snapshot = this.measure('save', () => this.adapter.saveState(context));
            if (snapshot === undefined || snapshot === null) throw new Error('Game could not capture rollback state.');
            this.snapshots.set(frame, snapshot);
        }
        checksum(frame) {
            if (frame % this.hashInterval) return;
            const hash = this.measure('hash', () => this.adapter.hashState());
            if (!integer(hash, 0, 0xffffffff)) throw new Error('Game returned an invalid state checksum.');
            this.hashes.set(frame, hash);
        }
        stall(reason) {
            this.lastStallReason = reason; ++this.metrics.stalls[reason];
            return false;
        }
        receive(slot, frame, pad) {
            if (this.disposed) return;
            if (!integer(slot, 0, this.players - 1) || !integer(frame, 1, 0x7fffffff) || !validPad(pad))
                throw new Error('Invalid rollback input.');
            if (frame < this.frame - 128) return; // Already finalized and discarded.
            if (frame > this.frame + 128) throw new Error('Rollback peer is too far ahead.');
            const row = this.actual.get(frame) || Array(this.players).fill(null);
            if (row[slot]) {
                if (!equal(row[slot], pad)) throw new Error('Conflicting confirmed input.');
                return;
            }
            row[slot] = copy(pad);
            this.actual.set(frame, row);
            const used = this.used.get(frame);
            if (used && !equal(used[slot], pad)) {
                if (!this.snapshots.has(frame)) throw new Error('Input arrived outside retained rollback history.');
                this.dirty = Math.min(this.dirty ?? frame, frame);
            }
            while (this.actual.get(this.confirmed + 1)?.every(Boolean)) ++this.confirmed;
        }
        inputs(frame) {
            return Array.from({length: this.players}, (_, slot) => {
                // Hold the latest known input. Never use an input from the future.
                for (let f = frame; f >= Math.max(1, this.frame - 128); --f) {
                    const input = this.actual.get(f)?.[slot];
                    if (input) return copy(input);
                }
                return copy(this.baseline[slot]);
            });
        }
        release(frame) {
            if (!this.snapshots.has(frame)) return;
            this.adapter.releaseState?.(this.snapshots.get(frame));
            this.snapshots.delete(frame);
        }
        simulate(frame, replaying) {
            this.release(frame);
            this.capture(frame, replaying);
            const pads = this.inputs(frame);
            this.used.set(frame, pads.map(copy));
            this.adapter.simulateFrame(pads, {frame, replaying});
            if (this.adapter.needsConfirmation?.()) {
                this.retryInCoroutine(frame);
                return false;
            }
            this.checksum(frame);
            return true;
        }
        // Scene changes and coroutine side effects cannot run during replay.
        // Discard the speculative tail and retry this exact frame, confirmed,
        // in the game's normal loop. Already-sent controller inputs stay valid.
        retryInCoroutine(frame) {
            if (!this.snapshots.has(frame)) throw new Error('Adapter requested a rewind of a confirmed frame without a snapshot.');
            this.measure('restore', () => this.adapter.restoreState(this.snapshots.get(frame)));
            for (const f of this.snapshots.keys()) if (f >= frame) this.release(f);
            for (const f of this.used.keys()) if (f >= frame) this.used.delete(f);
            for (const f of this.hashes.keys()) if (f >= frame) this.hashes.delete(f);
            this.frame = frame;
            this.pendingFrame = null;
            if (this.dirty >= frame) this.dirty = null;
            this.confirmationBarrier = frame;
            this.lastStallReason = 'confirmation';
        }
        reconcile() {
            if (this.disposed || this.dirty === null) return;
            const from = this.dirty;
            if (!this.snapshots.has(from)) throw new Error('Rollback snapshot unavailable.');
            this.measure('restore', () => this.adapter.restoreState(this.snapshots.get(from)));
            this.dirty = null;
            const end = this.frame;
            for (let f = from; f < end; ++f) if (!this.measure('replay', () => this.simulate(f, true))) break;
            ++this.rollbacks;
            this.replayedFrames += this.frame - from;
        }
        advance() {
            const pending = this.beginAdvance();
            if (!pending) return false;
            this.adapter.simulateFrame(pending.pads, {frame: pending.frame, replaying: false});
            return this.completeAdvance();
        }
        // Coroutine-based games run the forward update in their own loop,
        // between these calls. Replays remain synchronous and never render.
        beginAdvance() {
            if (this.disposed) return false;
            if (this.pendingFrame) throw new Error('Previous game frame has not completed.');
            this.reconcile();
            if (this.confirmationBarrier > this.confirmed) return this.stall('confirmation');
            if (this.frame > this.confirmed + this.maxPrediction && this.frame > this.confirmed) return this.stall('prediction');
            if (this.frame > this.confirmed && this.adapter.canPredict?.({frame: this.frame, confirmed: this.confirmed}) === false)
                return this.stall('adapter');
            this.lastStallReason = null;
            this.capture(this.frame, false);
            const pads = this.inputs(this.frame);
            this.used.set(this.frame, pads.map(copy));
            this.pendingFrame = this.frame;
            return {frame: this.frame, pads};
        }
        completeAdvance() {
            if (this.disposed) return false;
            if (this.pendingFrame !== this.frame) throw new Error('No game frame awaiting completion.');
            if (this.adapter.needsConfirmation?.()) {
                this.retryInCoroutine(this.frame);
                return false;
            }
            this.confirmationBarrier = null;
            this.checksum(this.frame);
            this.pendingFrame = null;
            ++this.frame;
            // Confirmed frames cannot change. Keep a bounded checksum/input tail
            // for diagnostics, and only the snapshots still eligible for rewind.
            for (const f of this.snapshots.keys())
                if (f <= this.confirmed && (this.dirty === null || f < this.dirty)) this.release(f);
            const before = this.frame - 128;
            for (const f of this.actual.keys()) if (f < before) {
                this.actual.delete(f);
            }
            if (before > 1) {
                const previous = this.used.get(before - 1);
                if (previous) this.baseline = previous.map(copy);
            }
            for (const f of this.used.keys()) if (f < before) this.used.delete(f);
            for (const f of this.hashes.keys()) if (f < before) this.hashes.delete(f);
            return true;
        }
        dispose() {
            this.disposed = true;
            for (const f of this.snapshots.keys()) this.release(f);
            this.actual.clear(); this.used.clear(); this.hashes.clear();
        }
    }

    class RollbackSession {
        static async create(options) { return new RollbackSession(options); }
        constructor({socket, game, epoch, players, slot, spectator, onFailure}) {
            if (game.inputSchema !== 'n64-pad-v1' || !integer(players, 1, 4) ||
                (!spectator && !integer(slot, 0, players - 1))) throw new Error('Invalid rollback session.');
            const config = game.rollback;
            if (!config || !integer(config.inputDelay, 0, 4) || !integer(config.maxPrediction, 1, 12))
                throw new Error('Missing or invalid rollback settings.');
            const confirmedDelay = config.confirmedInputDelay ?? config.inputDelay;
            if (!integer(confirmedDelay, config.inputDelay, 12))
                throw new Error('Invalid confirmed-input delay.');
            const hashInterval = config.hashInterval ?? 1;
            if (!integer(hashInterval, 1, 128) || game.tickRate % hashInterval)
                throw new Error('Invalid rollback checksum interval.');
            Object.assign(this, {socket, game, epoch, players, slot, spectator, onFailure});
            this.hashInterval = hashInterval;
            this.delay = config.inputDelay;
            this.confirmedDelay = confirmedDelay;
            this.maxPrediction = spectator ? 0 : config.maxPrediction;
            this.failed = false; this.running = false; this.frame = 1;
            this.sentThrough = 0; this.hashThrough = 0;
            const InputTransport = typeof window !== 'undefined' && window.PeakNet?.RollbackInputTransport;
            if (config.peerInputs && InputTransport) this.inputTransport = new InputTransport({socket, epoch, players, slot,
                spectator, receiveInput: event => this.receiveInput(event), frame: () => this.frame});
            this.lastProgress = performance.now();
            this.watchdog = setInterval(() => {
                if (this.running && performance.now() - this.lastProgress > 30000)
                    this.fail('The game stopped receiving inputs. Return to lobbies to try again.');
            }, 1000);
        }
        bind(adapter) {
            if (this.failed) return;
            if (this.engine) throw new Error('Rollback adapter already bound.');
            if (typeof adapter.sampleInput !== 'function') throw new Error('Rollback adapter requires sampleInput().');
            this.adapter = adapter;
            this.engine = new RollbackEngine({players: this.players, maxPrediction: this.maxPrediction,
                hashInterval: this.hashInterval, adapter});
            this.socket.emit('loaded', {epoch: this.epoch, compatibility: this.game});
        }
        start() {
            if (this.failed || this.running || !this.engine) return;
            this.running = true; this.lastProgress = performance.now();
            this.inputTransport?.start();
            if (!this.spectator) for (let f = 1; f <= this.delay; ++f) this.send(f, neutral());
        }
        latency() {} // Delay is agreed in the catalog; never change it independently mid-match.
        inputDelay() {
            return this.players > 1 && this.adapter?.confirmedInputMode?.() === true ? this.confirmedDelay : this.delay;
        }
        send(frame, pad) {
            this.engine.receive(this.slot, frame, pad);
            this.sentThrough = frame;
            this.socket.emit('input', {epoch: this.epoch, frame, pad: copy(pad)});
            this.inputTransport?.send(frame, pad);
        }
        receiveInput(event) {
            if (this.failed || event.epoch !== this.epoch || !this.engine) return;
            try { this.engine.receive(event.slot, event.frame, event.pad); }
            catch (error) { this.fail(error.message); }
        }
        receive(event) {
            // Complete rows are the relay's confirmation of locally submitted
            // input too. Individual inputs arrive first, enabling speculation.
            if (this.failed || event.epoch !== this.epoch || !this.engine) return;
            if (!Array.isArray(event.pads) || event.pads.length !== this.players)
                return this.fail('Invalid confirmed frame.');
            event.pads.forEach((pad, slot) => this.receiveInput({...event, slot, pad}));
        }
        advance(deferred = false) {
            if (!this.running || this.failed || !this.engine) return false;
            try {
                if (!this.spectator) {
                    const through = this.frame + this.inputDelay();
                    // Expand a confirmed-only phase's input pipeline without
                    // leaving holes. On returning to prediction, drain existing
                    // samples; never rewrite inputs already sent to a peer.
                    while (this.sentThrough < through) {
                        const frame = this.sentThrough + 1;
                        if (this.inputTransport?.canSend(frame) === false) {
                            // A full future buffer must not prevent consumption
                            // of an earlier frame whose inputs are available.
                            if (this.sentThrough < this.frame) return this.engine.stall('relay');
                            break;
                        }
                        this.send(frame, this.adapter.sampleInput({frame}));
                    }
                }
                if (deferred) {
                    const pending = this.engine.beginAdvance();
                    this.frame = this.engine.frame;
                    if (!pending) this.publishHashes();
                    return pending;
                }
                const advanced = this.engine.advance();
                this.frame = this.engine.frame;
                if (advanced) this.lastProgress = performance.now();
                this.publishHashes();
                return advanced;
            } catch (error) { this.fail(error.message); return false; }
        }
        beginAdvance() { return this.advance(true); }
        completeAdvance() {
            if (!this.running || this.failed || !this.engine) return false;
            try {
                const advanced = this.engine.completeAdvance();
                this.frame = this.engine.frame;
                if (advanced) this.lastProgress = performance.now();
                this.publishHashes();
                return advanced;
            } catch (error) { this.fail(error.message); return false; }
        }
        publishHashes() {
            // Inputs can arrive while a coroutine frame is pending. Do not
            // publish its checksum until any resulting correction is replayed.
            // Peer copies can also arrive before the relay has accepted the
            // complete row; keep its checkpoint until that journal catches up.
            const end = Math.min(this.engine.confirmed, this.frame - 1, (this.engine.dirty ?? Infinity) - 1,
                this.inputTransport?.enabled ? this.inputTransport.relayConfirmed : Infinity);
            if (!this.spectator) {
                const interval = this.game.tickRate;
                while (this.hashThrough + interval <= end) {
                    this.hashThrough += interval;
                    const hash = this.engine.hashes.get(this.hashThrough);
                    if (hash === undefined) throw new Error('Confirmed checksum history expired.');
                    this.socket.emit('hash', {epoch: this.epoch, frame: this.hashThrough, hash});
                }
            }
        }
        fail(message) {
            if (this.failed) return;
            this.dispose();
            this.socket.emit('failed', {epoch: this.epoch, message:String(message).slice(0,240)});
            this.onFailure(message);
        }
        diagnostics() {
            return {frame: this.frame, confirmed: this.engine?.confirmed ?? 0, inputDelay: this.delay,
                phaseInputDelay: this.inputDelay(), bufferedInputs: Math.max(0, this.sentThrough - this.frame),
                hashInterval: this.hashInterval, stallReason: this.engine?.lastStallReason ?? null,
                costs: this.engine ? {...this.engine.metrics, stalls: {...this.engine.metrics.stalls}} : null,
                transport: this.inputTransport?.diagnostics() ?? null};
        }
        dispose() {
            this.failed = true; this.running = false; clearInterval(this.watchdog);
            this.inputTransport?.dispose();
            this.engine?.dispose();
        }
    }
    return {RollbackEngine, RollbackSession, RollbackInputBuffer};
});
