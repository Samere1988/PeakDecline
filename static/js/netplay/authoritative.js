/* Optional host-authoritative backend. No game physics or weapon rules live here.
 * The authority and predicted client MUST use separate simulation instances. */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root?.PeakNet) {
        Object.assign(root.PeakNet, api);
        root.PeakNet.backends.set('authoritative-host-v1', api.AuthoritativeSession);
    }
})(typeof window !== 'undefined' ? window : null, () => {
    'use strict';
    const copy = value => structuredClone(value);
    const int = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;
    const neutral = () => ({buttons: 0, moveX: 0, moveY: 0, lookX: 0, lookY: 0});
    function validCommand(command) {
        return command && Object.keys(command).length === 5 && int(command.buttons, 0, 65535) &&
            ['moveX', 'moveY'].every(key => int(command[key], -127, 127)) &&
            ['lookX', 'lookY'].every(key => int(command[key], -32767, 32767));
    }
    function requireMethods(adapter, names) {
        for (const name of names) if (typeof adapter?.[name] !== 'function') throw new Error(`Missing FPS adapter method: ${name}`);
    }

    const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
    // Deltas replace top-level records. Games should key entities by stable IDs,
    // rather than putting the entire world in one array.
    class SnapshotCodec {
        constructor() { this.tick = -1; this.state = null; this.fullTick = -60; }
        encode(snapshot) {
            const {state, ...header} = snapshot;
            let packet = {...header, state: copy(state)};
            if (this.state && snapshot.tick - this.fullTick < 60) {
                const changed = Object.fromEntries(Object.entries(state).filter(([key, value]) =>
                    JSON.stringify(value) !== JSON.stringify(this.state[key])));
                const removed = Object.keys(this.state).filter(key => !Object.hasOwn(state, key));
                const delta = {...header, baseTick: this.tick, changed, removed};
                if (bytes(delta) < bytes(packet)) packet = delta;
            }
            if (bytes(packet) > 65536 || bytes(state) > 65536) throw new Error('FPS snapshot exceeds 64 KiB; reduce replicated state.');
            if (packet.state) this.fullTick = snapshot.tick;
            this.tick = snapshot.tick; this.state = copy(state);
            return packet;
        }
        decode(packet) {
            let state = packet.state;
            if (!state) {
                if (packet.baseTick !== this.tick || !this.state) throw new Error('FPS snapshot baseline missing; restart the room.');
                state = {...this.state, ...packet.changed};
                for (const key of packet.removed) delete state[key];
            }
            this.tick = packet.tick; this.state = copy(state);
            return {...packet, state: copy(state)};
        }
    }

    // Optional cosmetic records can update less frequently. Unclassified records,
    // removals and new records always go out immediately.
    class ReplicationSchedule {
        constructor(interval = () => 1) { this.interval = interval; this.state = {}; this.sent = new Map(); }
        select(state, tick) {
            const next = {};
            for (const [key, value] of Object.entries(state)) {
                const interval = this.interval(key);
                if (!int(interval, 1, 60)) throw new Error('Replication interval must be 1..60 ticks.');
                const due = !Object.hasOwn(this.state, key) || tick - this.sent.get(key) >= interval;
                Object.defineProperty(next, key, {value: copy(due ? value : this.state[key]), enumerable: true, configurable: true});
                if (due) this.sent.set(key, tick);
            }
            for (const key of this.sent.keys()) if (!Object.hasOwn(state, key)) this.sent.delete(key);
            this.state = next;
            return copy(next);
        }
    }

    class GameplayEvents {
        constructor(deliver = () => {}) { this.deliver = deliver; this.last = 0; this.predicted = new Set(); }
        predict(slot, seq, key, type, data, replaying) {
            if (replaying) return;
            const id = `${slot}:${seq}:${key}`;
            if (this.predicted.has(id)) return;
            this.predicted.add(id);
            while (this.predicted.size > 2048) this.predicted.delete(this.predicted.values().next().value);
            this.deliver({type, data: copy(data), prediction: id}, {predicted: true});
        }
        receive(events = []) {
            for (const event of events) {
                if (event.id <= this.last) continue;
                if (event.id !== this.last + 1) throw new Error('FPS gameplay event gap.');
                this.last = event.id;
                const matched = this.predicted.delete(event.prediction);
                this.deliver(copy(event), {predicted: false, confirmedPrediction: matched});
            }
        }
    }

    class SnapshotHistory {
        constructor(capacity = 120) {
            if (!int(capacity, 2, 600)) throw new Error('Invalid history capacity.');
            this.capacity = capacity; this.rows = [];
        }
        push(tick, state) {
            if (!int(tick, 0, 0x7fffffff) || (this.rows.length && tick <= this.rows.at(-1).tick))
                throw new Error('Snapshots must advance.');
            this.rows.push({tick, state: copy(state)});
            while (this.rows.length > this.capacity) this.rows.shift();
        }
        sample(tick, interpolate) {
            if (!this.rows.length) return null;
            const first = this.rows[0], last = this.rows.at(-1);
            if (tick <= first.tick) return copy(first.state);
            if (tick >= last.tick) return copy(last.state); // Freeze rather than extrapolate unknown events.
            const index = this.rows.findIndex(row => row.tick >= tick);
            const a = this.rows[index - 1], b = this.rows[index];
            return interpolate(copy(a.state), copy(b.state), (tick - a.tick) / (b.tick - a.tick));
        }
        rewind(requestedTick, nowTick, maxRewindTicks) {
            if (!int(requestedTick, 0, nowTick) || !int(maxRewindTicks, 0, this.capacity)) return null;
            const tick = Math.max(nowTick - maxRewindTicks, requestedTick);
            const row = this.rows.findLast(row => row.tick <= tick);
            // A caller queries this copy for hit validation. Never rewind the live world.
            return row ? {tick: row.tick, state: copy(row.state)} : null;
        }
    }

    class PredictedClient {
        constructor({adapter, slot, tickRate, maxPending = 64, events}) {
            this.events = events; this.corrections = 0; this.replayed = 0;
            requireMethods(adapter, ['sampleInput', 'captureLocal', 'restoreLocal', 'simulateLocal', 'selectLocalState']);
            Object.assign(this, {adapter, slot, tickRate, maxPending});
            this.sequence = 0; this.ack = 0; this.snapshotTick = -1; this.pending = [];
        }
        predict(viewTick) {
            if (this.pending.length >= this.maxPending) return null;
            const command = this.adapter.sampleInput();
            if (!validCommand(command)) throw new Error('Invalid FPS input.');
            const packet = {seq: ++this.sequence, viewTick, command: copy(command)};
            this.pending.push(packet);
            this.adapter.simulateLocal(copy(command), 1 / this.tickRate, this.context(packet.seq, false));
            return copy(packet);
        }
        context(seq, replaying) {
            return {seq, replaying, emitEffect: (key, type, data = {}) =>
                this.events?.predict(this.slot, seq, key, type, data, replaying)};
        }
        reconcile(snapshot) {
            if (snapshot.tick <= this.snapshotTick) return false;
            const ack = snapshot.acks[this.slot];
            if (!int(ack, this.ack, this.sequence)) throw new Error('Invalid input acknowledgement.');
            const before = copy(this.adapter.captureLocal());
            this.adapter.restoreLocal(copy(this.adapter.selectLocalState(snapshot.state, this.slot)));
            this.pending = this.pending.filter(packet => packet.seq > ack);
            for (const packet of this.pending)
                this.adapter.simulateLocal(copy(packet.command), 1 / this.tickRate, this.context(packet.seq, true));
            this.replayed += this.pending.length;
            if (JSON.stringify(before) !== JSON.stringify(this.adapter.captureLocal())) this.corrections++;
            this.ack = ack; this.snapshotTick = snapshot.tick;
            this.adapter.onReconcile?.(before, copy(this.adapter.captureLocal()));
            return true;
        }
    }

    class AuthoritativeHost {
        constructor({adapter, players, tickRate, historyTicks = 120, maxRewindTicks = 12, maxPending = 64}) {
            requireMethods(adapter, ['step', 'captureState']);
            Object.assign(this, {adapter, players, tickRate, maxRewindTicks, maxPending});
            this.tick = 0; this.eventId = 0; this.events = [];
            this.queues = Array.from({length: players}, () => []);
            this.received = Array(players).fill(0); this.acks = Array(players).fill(0);
            this.history = new SnapshotHistory(historyTicks);
            this.history.push(0, adapter.captureState());
        }
        receive(slot, packet) {
            if (!int(slot, 0, this.players - 1) || !int(packet?.seq, 1, 0x7fffffff) ||
                !int(packet.viewTick, 0, this.tick) || !validCommand(packet.command)) throw new Error('Invalid authority input.');
            if (packet.seq <= this.received[slot]) return; // Duplicate delivery is harmless.
            if (packet.seq !== this.received[slot] + 1 || this.queues[slot].length >= this.maxPending)
                throw new Error('Authority input history exceeded.');
            this.queues[slot].push(copy(packet)); this.received[slot] = packet.seq;
        }
        advance() {
            const packets = this.queues.map((queue, slot) => {
                const packet = queue.shift();
                if (packet) this.acks[slot] = packet.seq;
                return packet || null;
            });
            const tick = this.tick + 1;
            this.adapter.step(packets.map(packet => packet ? copy(packet.command) : neutral()), 1 / this.tickRate, {
                tick, packets: copy(packets),
                emitEvent: (type, data = {}, origin = null) => {
                    if (!['shot', 'explosion', 'pickup', 'death', 'respawn'].includes(type)) throw new Error('Unknown gameplay event.');
                    if (this.events.length >= 256) throw new Error('Gameplay event budget exceeded.');
                    const event = {id: ++this.eventId, tick, type, data: copy(data)};
                    if (origin) {
                        if (!packets[origin.slot] || typeof origin.key !== 'string' || origin.key.length > 64) throw new Error('Invalid event origin.');
                        event.prediction = `${origin.slot}:${packets[origin.slot].seq}:${origin.key}`;
                    }
                    this.events.push(event);
                },
                // Games validate shots against historical hitboxes, then apply damage
                // to current state. Missing input never repeats fire/reload/look deltas.
                rewindFor: slot => packets[slot] ? this.history.rewind(packets[slot].viewTick, this.tick, this.maxRewindTicks) : null
            });
            this.tick = tick;
            const state = this.adapter.captureState();
            this.history.push(tick, state);
            return {tick, acks: [...this.acks], state: copy(state)};
        }
    }

    class AuthoritativeSession {
        static async create(options) { return new AuthoritativeSession(options); }
        constructor({socket, game, epoch, players, slot, spectator, onFailure, resumeSequence, clock = () => performance.now()}) {
            const config = game.authoritative;
            if (game.inputSchema !== 'fps-command-v1' || !int(game.tickRate, 10, 120) || !int(players, 1, 8) ||
                (!spectator && !int(slot, 0, players - 1)) || !config ||
                !int(config.historyTicks, 2, 600) || !int(config.maxPending, 1, 120) ||
                !int(config.maxRewindTicks, 0, config.historyTicks) ||
                !int(config.snapshotInterval, 1, 12) || !int(config.interpolationTicks, 1, config.historyTicks))
                throw new Error('Invalid authoritative session configuration.');
            Object.assign(this, {socket, game, epoch, players, slot, spectator, onFailure, clock, config});
            this.resumeSequence = resumeSequence;
            this.resuming = int(resumeSequence,0,0x7fffffff);
            this.transportSuspended = false;
            this.encoder = new SnapshotCodec(); this.decoder = new SnapshotCodec();
            this.metrics = {recoveries:0, skippedEffects:0, rttMs: null, receivedBytes: 0, sentBytes: 0, snapshots: 0, stalls: 0, predictionStalls: 0};
            this.startedAt = clock();
            this.isAuthority = !spectator && slot === 0;
            this.failed = false; this.running = false; this.frame = 1;
            this.history = new SnapshotHistory(config.historyTicks);
            this.lastSnapshot = -1; this.viewTick = 0; this.lastProgress = clock();
            this.watchdog = setInterval(() => {
                if (this.running && !this.transportSuspended && clock() - this.lastProgress > 30000) this.fail('The FPS authority stopped responding. Return to lobbies.');
            }, 1000);
        }
        bind(adapter) {
            if (this.adapter || this.failed) throw new Error('FPS adapter already bound or disposed.');
            requireMethods(adapter, ['interpolateState', 'renderState']);
            this.adapter = adapter;
            this.events = new GameplayEvents((event, context) => {
                // Confirmation remains observable, but never repeats the predicted effect.
                if (context.confirmedPrediction) adapter.confirmEffect?.(event);
                else adapter.onGameplayEvent?.(event, context);
            });
            if (!this.spectator) this.client = new PredictedClient({adapter, slot: this.slot, tickRate: this.game.tickRate, events: this.events, ...this.config});
            if (this.client && this.resuming) this.client.sequence = this.resumeSequence;
            if (this.isAuthority) {
                requireMethods(adapter, ['createAuthority']);
                const authority = adapter.createAuthority();
                if (authority === adapter) throw new Error('Authority must have its own simulation state.');
                this.replication = new ReplicationSchedule(authority.replicationInterval?.bind(authority));
                this.authority = new AuthoritativeHost({adapter: authority, players: this.players, tickRate: this.game.tickRate, ...this.config});
            }
            this.socket.emit('loaded', {epoch: this.epoch, compatibility: this.game});
        }
        start() {
            if (this.failed || this.running || !this.adapter) return;
            this.running = true; this.nextTick = this.clock(); this.lastProgress = this.nextTick;
            if (this.isAuthority) this.sendSnapshot({tick: 0,
                acks: Array(this.players).fill(0), state: this.authority.adapter.captureState()});
        }
        latency(ms) { if (Number.isFinite(ms) && ms >= 0) this.metrics.rttMs = ms; }
        diagnostics() {
            const seconds = Math.max(1, (this.clock() - this.startedAt) / 1000);
            return {...this.metrics, receiveBytesPerSecond: this.metrics.receivedBytes / seconds,
                sendBytesPerSecond: this.metrics.sentBytes / seconds,
                snapshotAgeMs: Math.max(0, this.clock() - this.lastProgress),
                pendingInputs: this.client?.pending.length || 0,
                corrections: this.client?.corrections || 0, replayedInputs: this.client?.replayed || 0};
        }
        sendSnapshot(snapshot) {
            snapshot = {...snapshot, state: this.replication.select(snapshot.state, snapshot.tick)};
            const events = this.authority.events.splice(0);
            const packet = {epoch: this.epoch, ...this.encoder.encode({...snapshot, events})};
            this.metrics.sentBytes += bytes(packet);
            this.socket.emit('world_snapshot', packet);
        }
        receiveCommand(event) {
            if (this.failed || event.epoch !== this.epoch || !this.isAuthority) return;
            try { this.authority.receive(event.slot, event); } catch (error) { this.fail(error.message); }
        }
        suspendTransport() { this.transportSuspended = true; }
        continueTransport() {
            this.transportSuspended = false; this.nextTick = this.clock(); this.lastProgress = this.nextTick;
        }
        resumeTransport(event) {
            if (this.failed || event.epoch !== this.epoch || !Array.isArray(event.received) || event.received.length !== this.players
                    || !event.received.every(n=>int(n,0,0x7fffffff)) || !Array.isArray(event.members)) return this.fail('Invalid reconnect state.');
            const baseline = event.baseline;
            if (baseline && baseline.tick > this.lastSnapshot) {
                if (!int(baseline.eventCursor,this.events.last,Number.MAX_SAFE_INTEGER)) return this.fail('Invalid reconnect event cursor.');
                this.events.last = baseline.eventCursor;
                this.recovering = false; this.recoveryAt = undefined;
                this.receiveSnapshot({...baseline,epoch:this.epoch});
            }
            if (this.failed) return;
            if (this.client) {
                const received=event.received[this.slot];
                if(received>this.client.sequence) return this.fail('Reconnect input history does not match this game tab.');
                for(const packet of this.client.pending) if(packet.seq>received)
                    this.socket.emit('fps_command',{epoch:this.epoch,...copy(packet)});
            }
            this.continueTransport();
            if(!event.members.some(p=>p.slot===0&&p.connected!==false)) this.suspendTransport();
        }
        receiveBootstrap(event) {
            if (this.failed || !this.running || (!this.spectator && !this.resuming) || event.epoch !== this.epoch || this.lastSnapshot >= 0) return;
            if (!int(event.eventCursor,0,Number.MAX_SAFE_INTEGER) || !event.state || event.events?.length)
                return this.fail('Invalid spectator checkpoint.');
            this.events.last = event.eventCursor;
            this.receiveSnapshot(event);
            this.resuming = false;
        }
        requestRecovery() {
            const now=this.clock();
            if(this.recoveryAt!==undefined && now-this.recoveryAt<250)return;
            this.recovering=true;this.recoveryAt=now;
            this.socket.emit('world_resync',{epoch:this.epoch,afterEvent:this.events.last});
        }
        receiveRecovery(event) {
            if(this.failed || !this.running || event.epoch!==this.epoch || !this.recovering)return;
            if(!event.state || !int(event.eventCursor,this.events.last,Number.MAX_SAFE_INTEGER))return this.fail('Invalid recovery checkpoint.');
            if(event.resetEffects===true){
                this.metrics.skippedEffects+=event.eventCursor-this.events.last;
                this.events.last=event.eventCursor;
            }
            this.recovering=false;this.recoveryAt=undefined;
            this.receiveSnapshot(event);
            if(!this.failed && this.events.last!==event.eventCursor)return this.fail('Incomplete recovery effects.');
            this.metrics.recoveries++;
        }
        receiveSnapshot(event) {
            if (this.failed || !this.running || event.epoch !== this.epoch || event.tick <= this.lastSnapshot) return;
            const freshEvent=Array.isArray(event.events)?event.events.find(e=>e.id>this.events.last):null;
            if(this.recovering || (!event.state && event.baseTick!==this.decoder.tick) ||
                (freshEvent && freshEvent.id!==this.events.last+1))return this.requestRecovery();
            try {
                if (!int(event.tick, 0, 0x7fffffff) || !Array.isArray(event.acks) || event.acks.length !== this.players ||
                    !event.acks.every(ack => int(ack, 0, 0x7fffffff))) throw new Error('Invalid world snapshot.');
                this.metrics.receivedBytes += bytes(event); this.metrics.snapshots++;
                event = this.decoder.decode(event);
                this.client?.reconcile(event);
                this.events.receive(event.events);
                this.history.push(event.tick, event.state);
                this.lastSnapshot = event.tick; this.snapshotAt = this.clock(); this.lastProgress = this.snapshotAt;
            } catch (error) { this.fail(error.message); }
        }
        advance() {
            if (!this.running || this.failed || this.transportSuspended || (this.resuming && this.lastSnapshot < 0)) return false;
            const now = this.clock(), dt = 1000 / this.game.tickRate;
            if (now < this.nextTick) return false;
            // Bounded catch-up: callers may poll each animation frame; hidden tabs
            // cannot unleash an unlimited backlog after returning to the foreground.
            if (now - this.nextTick > 4 * dt) this.metrics.stalls++;
            this.nextTick = Math.max(this.nextTick + dt, now - 4 * dt);
            try {
                const packet = this.client?.predict(this.viewTick);
                if (this.client && !packet) this.metrics.predictionStalls++;
                if (packet) this.socket.emit('fps_command', {epoch: this.epoch, ...packet});
                if (this.authority) {
                    const snapshot = this.authority.advance();
                    if (snapshot.tick % this.config.snapshotInterval === 0)
                        this.sendSnapshot(snapshot);
                }
                this.frame++;
                return true;
            } catch (error) { this.fail(error.message); return false; }
        }
        render() {
            if (!this.running || this.failed || this.lastSnapshot < 0) return;
            try {
                const elapsed = Math.max(0, (this.clock() - this.snapshotAt) * this.game.tickRate / 1000);
                this.renderTick = Math.max(this.renderTick || 0, Math.min(this.lastSnapshot,
                    Math.max(0, this.lastSnapshot + elapsed - this.config.interpolationTicks)));
                this.viewTick = Math.floor(this.renderTick);
                const remote = this.history.sample(this.renderTick, (a, b, alpha) => this.adapter.interpolateState(a, b, alpha));
                this.adapter.renderState(remote, this.client ? copy(this.adapter.captureLocal()) : null);
            } catch (error) { this.fail(error.message); }
        }
        fail(message) {
            if (this.failed) return;
            this.dispose(); this.socket.emit('failed', {epoch: this.epoch, message:String(message).slice(0,240)}); this.onFailure(message);
        }
        dispose() {
            if (this.failed) return;
            this.failed = true; this.running = false; clearInterval(this.watchdog);
            this.authority?.adapter.destroy?.(); this.adapter?.destroy?.();
            this.history.rows.length = 0;
            if (this.client) this.client.pending.length = 0;
        }
    }
    return {ReplicationSchedule, SnapshotCodec, GameplayEvents, SnapshotHistory, PredictedClient, AuthoritativeHost, AuthoritativeSession, validFpsCommand: validCommand};
});
