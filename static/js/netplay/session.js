/* Shared browser session. Game-specific state and input access live in adapters.
 * Optional player-to-player input copies may complete a row before the relay.
 * The relay journal stays authoritative: every input still goes through it,
 * rows consumed early are verified against its rows, and checksums wait for it. */
(() => {
    'use strict';
    const pack = pad => ((pad.buttons & 65535) | ((pad.x & 255) << 16) | ((pad.y & 255) << 24)) >>> 0;
    const unpack = value => ({buttons: value & 65535, x: (value << 8) >> 24, y: value >> 24});
    class Session {
        static async create(options) {
            if (options.game.inputSchema !== 'n64-pad-v1') throw new Error('Unsupported input format.');
            const core = await createPeakNetCore({locateFile: name => options.coreUrl + name});
            return new Session({...options, core});
        }
        constructor({socket, core, game, epoch, players, slot, spectator, onFailure, recovery}) {
            Object.assign(this, {socket, core, game, epoch, players, slot, spectator, onFailure, recovery});
            this.recovery = recovery;
            this.rebuilding = !!recovery;
            this.replayRequested = false;
            this.replayReady = false;
            this.replayHash = null;
            this.failed = false;
            this.running = false;
            this.lead = 4;
            this.sentThrough = 0;
            this.hashThrough = 0;
            this.frame = 1;
            this.recoverable = ['mk64', 'marioparty', 'marioparty2'].includes(game.id);
            this.transportSuspended = false;
            this.pendingInputs = new Map();
            this.frames = new Map();
            this.receivedThrough = 0;
            this.peerInputs = new Map(); // Unconsumed peer copies by frame.
            this.unconfirmed = new Map(); // Rows consumed from peer copies, awaiting relay rows.
            this.pendingHashes = [];
            this.peerRows = 0;
            const Transport = !spectator && game.lockstep?.peerInputs === true && typeof window !== 'undefined' && window.PeakNet?.RollbackInputTransport;
            if (Transport) this.transport = new Transport({socket, epoch, players, slot, spectator,
                receiveInput: event => this.receivePeerInput(event), frame: () => this.frame});
            this.peered = !!this.transport?.enabled;
            // Retained games and peer copies buffer rows; other relay rows enter the core directly.
            this.buffered = this.recoverable || this.peered;
            this.roundTrips = [];
            this.lowerLeadSamples = 0;
            this.lastProgress = performance.now();
            if (!core._pn_reset(players)) throw new Error('Unsupported player count.');
            this.watchdog = setInterval(() => {
                if (this.running && !this.transportSuspended && performance.now() - this.lastProgress > 30000)
                    this.fail('The game stopped receiving inputs. Return to lobbies to try again.');
            }, 1000);
        }
        bind(adapter) {
            if (this.failed) return;
            this.adapter = adapter;
            if (!adapter.deferLoaded) this.loaded();
        }
        loaded() {
            if (this.failed || this.didLoad) return;
            this.didLoad = true;
            this.socket.emit('loaded', {epoch: this.epoch, compatibility: this.game});
        }
        start() {
            this.running = true; this.lastProgress = performance.now();
            if (this.rebuilding) this.requestReplay();
            else this.transport?.start();
        }
        requestReplay() {
            if (!this.rebuilding || this.replayRequested || this.transportSuspended || this.failed || this.frames.size >= 32) return;
            this.replayRequested = true;
            this.socket.emit('party_replay', {epoch:this.epoch, start:this.receivedThrough + 1});
        }
        receiveReplay(event) {
            if (!this.rebuilding || !this.replayRequested || this.failed || event.epoch !== this.epoch) return;
            if (event.start !== this.receivedThrough + 1 || event.through !== this.recovery.through ||
                !Array.isArray(event.frames) || event.frames.length > 600 ||
                event.frames.length !== Math.min(600, event.through - event.start + 1) ||
                event.frames.some((row, i) => row.frame !== event.start + i || row.epoch !== this.epoch))
                return this.fail('Invalid Mario Party recovery history.');
            this.replayRequested = false;
            for (const row of event.frames) this.receive(row);
        }
        replayLive(event) {
            if (!this.rebuilding || !this.replayReady || this.failed || event.epoch !== this.epoch || event.completed !== this.recovery.through) return;
            // With peer copies the relay retains the replaced tab's submitted
            // inputs, because other players may already have consumed them.
            const inputsThrough = event.inputsThrough ?? event.completed;
            if (!Number.isInteger(inputsThrough) || inputsThrough < event.completed || inputsThrough > event.completed + 128)
                return this.fail('Invalid Mario Party recovery position.');
            this.rebuilding = false; this.sentThrough = inputsThrough;
            this.pendingInputs.clear(); this.transportSuspended = !!event.paused;
            this.lastProgress = performance.now();
            this.transport?.start(); this.transport?.confirm(this.receivedThrough);
        }
        latency(ms) {
            if (!Number.isFinite(ms) || ms < 0) return;
            if (!this.recoverable) {
                this.lead = Math.max(1, Math.min(8, Math.ceil(ms / (1000 / this.game.tickRate)) + 1));
                return;
            }
            this.roundTrips.push(ms);
            if (this.roundTrips.length > 8) this.roundTrips.shift();
            const worst = Math.max(...this.roundTrips), jitter = worst - Math.min(...this.roundTrips);
            const target = Math.max(1, Math.min(8, Math.ceil((worst + Math.min(1000 / this.game.tickRate / 2, jitter / 4)) / (1000 / this.game.tickRate))));
            // Grow immediately for latency spikes; shrink only after several stable probes.
            if (this.roundTrips.length === 1 || target >= this.lead) {
                this.lead = target; this.lowerLeadSamples = 0;
            } else if (++this.lowerLeadSamples >= 4) {
                this.lead = target; this.lowerLeadSamples = 0;
            }
        }
        receive(event) {
            if (this.failed || event.epoch !== this.epoch) return;
            if (!Number.isInteger(event.frame) || event.frame < 1 ||
                (!this.recoverable && event.frame > this.frame + 32) || (!this.buffered && event.frame < this.frame) ||
                !Array.isArray(event.pads) || event.pads.length !== this.players)
                return this.fail('Invalid frame received. Return to lobbies.');
            const packed = [];
            for (const pad of event.pads) {
                if (!this.validPad(pad)) return this.fail('Invalid controller input received.');
                packed.push(pack(pad));
            }
            if (this.buffered) {
                const early = this.unconfirmed.get(event.frame);
                if (early) {
                    if (early.some((value, slot) => value !== packed[slot]))
                        return this.fail('Conflicting game frame received.');
                    this.unconfirmed.delete(event.frame);
                    if (event.frame >= this.frame) this.frames.set(event.frame, packed);
                    return this.confirmed(event.frame);
                }
                // Retained reconnects may replay an already consumed row.
                if (event.frame < this.frame) return this.confirmed(event.frame);
                const previous = this.frames.get(event.frame);
                if (previous && previous.some((value, slot) => value !== packed[slot]))
                    return this.fail('Conflicting game frame received.');
                if (event.frame - this.frame >= 1200 || (!previous && this.frames.size >= 1200))
                    return this.fail('This device fell too far behind the game. Return to lobbies to rejoin.');
                this.frames.set(event.frame, packed);
                // The relay row is authoritative for every frame not yet consumed.
                this.peerInputs.delete(event.frame);
                this.confirmed(event.frame);
            } else {
                for (let slot = 0; slot < this.players; slot++)
                    if (!this.core._pn_store(slot, event.frame, packed[slot]))
                        return this.fail('Conflicting or expired game frame received.');
            }
        }
        validPad(pad) {
            return !!pad && Number.isInteger(pad.buttons) && pad.buttons >= 0 && pad.buttons <= 65535 &&
                Number.isInteger(pad.x) && Number.isInteger(pad.y) && Math.abs(pad.x) <= 80 && Math.abs(pad.y) <= 80;
        }
        confirmed(frame) {
            this.receivedThrough = Math.max(this.receivedThrough, frame);
            this.pendingInputs.delete(frame);
            this.transport?.confirm(this.receivedThrough);
            this.flushHashes();
        }
        // Returns false only for an input the transport must not acknowledge.
        receivePeerInput({epoch, slot, frame, pad}) {
            if (this.failed || !this.peered || this.rebuilding || epoch !== this.epoch || !Number.isInteger(slot) ||
                slot < 0 || slot >= this.players || slot === this.slot || !Number.isInteger(frame) || frame < 1 || !this.validPad(pad))
                return false;
            const value = pack(pad), early = this.unconfirmed.get(frame);
            if (early) {
                if (early[slot] !== value) this.fail('Conflicting game frame received.');
                return !this.failed;
            }
            // Relay rows already decide this frame; consumed frames are relay rows or early rows.
            if (frame <= this.receivedThrough || frame < this.frame || this.transportSuspended) return true;
            if (frame > this.frame + 128) return false;
            this.peerInput(frame)[slot] = value;
            return true;
        }
        peerInput(frame) {
            let row = this.peerInputs.get(frame);
            if (!row) this.peerInputs.set(frame, row = new Array(this.players).fill(undefined));
            return row;
        }
        flushHashes() {
            // The relay checks only frames its journal has completed.
            while (this.pendingHashes.length && (!this.peered || this.pendingHashes[0].frame <= this.receivedThrough))
                this.socket.emit('hash', {epoch: this.epoch, ...this.pendingHashes.shift()});
        }
        frameReady(frame) {
            if (this.failed) return -1;
            // MK64 reaches this bridge only after successful native initialization.
            if (this.adapter?.deferLoaded) this.loaded();
            if (!this.running || !this.adapter || this.transportSuspended) return 0;
            if (frame > this.frame) {
                this.lastProgress = performance.now();
                this.frames.delete(this.frame);
                this.frame = frame;
            }
            if (this.rebuilding) {
                if (frame === this.recovery.checkpointFrame + 1 && this.recovery.checkpointFrame > 0 && this.replayHash === null)
                    this.replayHash = this.adapter.hashForFrame(this.recovery.checkpointFrame) >>> 0;
                if (frame > this.recovery.through) {
                    if (!this.replayReady) {
                        this.replayReady = true;
                        this.socket.emit('party_replay_ready', {epoch:this.epoch, frame:this.recovery.through, hash:this.replayHash});
                    }
                    return 0;
                }
                if (this.receivedThrough < this.recovery.through) this.requestReplay();
            }
            if (!this.spectator && !this.rebuilding) {
                // Peer rows may lead the relay by at most 120 frames, inside its 128-frame window.
                while (this.sentThrough < frame + this.lead && (!this.peered || this.transport.canSend(this.sentThrough + 1))) {
                    const future = ++this.sentThrough;
                    const pad = this.adapter.sampleInput();
                    if (this.recoverable) this.pendingInputs.set(future, {...pad});
                    this.socket.emit('input', {epoch: this.epoch, frame: future, pad});
                    if (this.peered) {
                        this.transport.send(future, pad);
                        if (this.validPad(pad)) this.peerInput(future)[this.slot] = pack(pad);
                    }
                }
                if (frame > 1 && frame % this.game.tickRate === 0 && frame > this.hashThrough) {
                    this.hashThrough = frame;
                    this.pendingHashes.push({frame: frame - 1, hash: this.adapter.hashForFrame(frame - 1) >>> 0});
                    this.flushHashes();
                }
            }
            if (this.buffered) {
                let row = this.frames.get(frame) ?? this.unconfirmed.get(frame);
                const copies = !row && !this.rebuilding && this.peerInputs.get(frame);
                if (copies && !copies.includes(undefined)) {
                    row = copies; this.peerInputs.delete(frame);
                    this.unconfirmed.set(frame, row); this.peerRows++;
                }
                if (!row) return 0;
                for (let slot = 0; slot < this.players; slot++)
                    if (!this.core._pn_store(slot, frame, row[slot])) {
                        this.fail('Conflicting or expired game frame received.'); return -1;
                    }
            }
            return this.core._pn_ready(frame);
        }
        getFrame(frame) {
            return Array.from({length: this.players}, (_, slot) => unpack(this.core._pn_input(slot, frame) >>> 0));
        }
        catchingUp() {
            if (!this.recoverable || !this.spectator || this.transportSuspended || this.failed) return false;
            const backlog = this.receivedThrough - this.frame;
            this.replaying = backlog > (this.replaying ? 2 : 8);
            return this.replaying;
        }
        resumeFrame() { return Math.min(this.frame - 1, this.receivedThrough); }
        diagnostics() {
            return {frame: this.frame, lead: this.lead, relayThrough: this.receivedThrough, peerRows: this.peerRows,
                unconfirmed: this.unconfirmed.size, transport: this.transport?.diagnostics() ?? null};
        }
        suspendTransport() {
            this.transportSuspended = true;
            // A closing tab may lose its last relay inputs after their peer copies
            // were consumed here. Report those rows so the relay can keep them.
            if (this.peered && this.recoverable && this.unconfirmed.size && this.socket.connected !== false)
                this.socket.emit('lockstep_witness', {epoch: this.epoch, rows: [...this.unconfirmed]
                    .sort((a, b) => a[0] - b[0]).slice(0, 128).map(([frame, row]) => ({frame, pads: row.map(unpack)}))});
            // A paused seat may return as a reloaded tab whose earlier copies the
            // journal never received. Unconsumed remote copies are dropped; the
            // relay delivers every journal input in its rows.
            for (const [frame, row] of this.peerInputs) {
                const own = row[this.slot];
                if (own === undefined) this.peerInputs.delete(frame);
                else { row.fill(undefined); row[this.slot] = own; }
            }
        }
        resumeTransport(event) {
            if (this.failed || event.epoch !== this.epoch) return;
            if (!this.recoverable) {
                // Only a stall pause reaches these sessions; nothing was missed while paused.
                this.transportSuspended = false; this.lastProgress = performance.now(); return;
            }
            const completed = event.completed ?? event.through;
            if (event.frames !== undefined) {
                // Rows consumed early from peer copies may lead the relay journal.
                if (!Array.isArray(event.frames) || event.frames.length > 1200 || !Number.isInteger(completed) || completed < this.resumeFrame())
                    return this.fail('The retained game history is unavailable. Return to lobbies.');
                for (const row of event.frames) this.receive(row);
                if (this.failed) return;
                for (let frame = this.frame; frame <= completed; frame++)
                    if (!this.frames.has(frame)) return this.fail('The retained game history is incomplete. Return to lobbies.');
                for (const [frame, pad] of this.pendingInputs) {
                    if (frame <= completed) this.pendingInputs.delete(frame);
                    else this.socket.emit('input', {epoch: this.epoch, frame, pad});
                }
            }
            this.transportSuspended = !!event.paused;
            this.lastProgress = performance.now();
        }
        fail(message) {
            if (this.failed) return;
            this.dispose();
            this.socket.emit('failed', {epoch: this.epoch, message:String(message).slice(0,240)});
            this.onFailure(message);
        }
        dispose() {
            this.failed = true; this.running = false; clearInterval(this.watchdog);
            this.transport?.dispose();
            this.frames.clear(); this.pendingInputs.clear(); this.peerInputs.clear(); this.unconfirmed.clear();
        }
    }
    window.PeakNet = {Session, adapters: new Map(), backends: new Map([['recomp-ring-lockstep-v1', Session]])};
})();
