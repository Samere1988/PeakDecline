/* Shared browser session. Game-specific state and input access live in adapters. */
(() => {
    'use strict';
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
            this.rebuilding = false; this.sentThrough = event.completed;
            this.pendingInputs.clear(); this.transportSuspended = !!event.paused;
            this.lastProgress = performance.now();
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
                (!this.recoverable && (event.frame < this.frame || event.frame > this.frame + 32)) ||
                !Array.isArray(event.pads) || event.pads.length !== this.players)
                return this.fail('Invalid frame received. Return to lobbies.');
            const packed = [];
            for (const pad of event.pads) {
                if (!pad || !Number.isInteger(pad.buttons) || pad.buttons < 0 || pad.buttons > 65535 ||
                    !Number.isInteger(pad.x) || !Number.isInteger(pad.y) || Math.abs(pad.x) > 80 || Math.abs(pad.y) > 80)
                    return this.fail('Invalid controller input received.');
                packed.push(((pad.buttons & 65535) | ((pad.x & 255) << 16) | ((pad.y & 255) << 24)) >>> 0);
            }
            if (this.recoverable) {
                if (event.frame < this.frame) return; // Retained reconnects may replay an already consumed row.
                const previous = this.frames.get(event.frame);
                if (previous && previous.some((value, slot) => value !== packed[slot]))
                    return this.fail('Conflicting game frame received.');
                if (event.frame - this.frame >= 1200 || (!previous && this.frames.size >= 1200))
                    return this.fail('This device fell too far behind the game. Return to lobbies to rejoin.');
                this.frames.set(event.frame, packed);
                this.receivedThrough = Math.max(this.receivedThrough, event.frame);
                this.pendingInputs.delete(event.frame);
            } else {
                for (let slot = 0; slot < this.players; slot++)
                    if (!this.core._pn_store(slot, event.frame, packed[slot]))
                        return this.fail('Conflicting or expired game frame received.');
            }
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
                while (this.sentThrough < frame + this.lead) {
                    const future = ++this.sentThrough;
                    const pad = this.adapter.sampleInput();
                    if (this.recoverable) this.pendingInputs.set(future, {...pad});
                    this.socket.emit('input', {epoch: this.epoch, frame: future, pad});
                }
                if (frame > 1 && frame % this.game.tickRate === 0 && frame > this.hashThrough) {
                    this.hashThrough = frame;
                    this.socket.emit('hash', {epoch: this.epoch, frame: frame - 1,
                        hash: this.adapter.hashForFrame(frame - 1) >>> 0});
                }
            }
            if (this.recoverable) {
                const row = this.frames.get(frame);
                if (!row) return 0;
                for (let slot = 0; slot < this.players; slot++)
                    if (!this.core._pn_store(slot, frame, row[slot])) {
                        this.fail('Conflicting or expired game frame received.'); return -1;
                    }
            }
            return this.core._pn_ready(frame);
        }
        getFrame(frame) {
            return Array.from({length: this.players}, (_, slot) => {
                const value = this.core._pn_input(slot, frame) >>> 0;
                return {buttons: value & 65535, x: (value << 8) >> 24, y: value >> 24};
            });
        }
        catchingUp() {
            if (!this.recoverable || !this.spectator || this.transportSuspended || this.failed) return false;
            const backlog = this.receivedThrough - this.frame;
            this.replaying = backlog > (this.replaying ? 2 : 8);
            return this.replaying;
        }
        suspendTransport() { this.transportSuspended = true; }
        resumeTransport(event) {
            if (!this.recoverable || this.failed || event.epoch !== this.epoch) return;
            const completed = event.completed ?? event.through;
            if (event.frames !== undefined) {
                if (!Array.isArray(event.frames) || event.frames.length > 1200 || !Number.isInteger(completed) || completed < this.frame - 1)
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
            this.frames.clear(); this.pendingInputs.clear();
        }
    }
    window.PeakNet = {Session, adapters: new Map(), backends: new Map([['recomp-ring-lockstep-v1', Session]])};
})();
