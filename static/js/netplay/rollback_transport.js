/* Optional player-to-player input copies. The authenticated relay remains the
 * complete input journal, spectator feed and recovery path. Repair only resends
 * immutable submitted inputs; it never samples controllers or advances frames. */
(function(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root?.PeakNet) root.PeakNet.RollbackInputTransport = api.RollbackInputTransport;
})(typeof window === 'undefined' ? null : window, () => {
    'use strict';
    const MAGIC = 0x50445242, HEADER = 20, STRIDE = 8, REDUNDANCY = 8, HISTORY = 128;
    const ACK_MS = 16, REPAIR_MS = 50, MAX_GENERATION = 4, CONNECT_MS = 10000, DISCONNECT_MS = 1500;
    const integer = (n, low, high) => Number.isInteger(n) && n >= low && n <= high;
    const validPad = p => p && integer(p.buttons, 0, 65535) && integer(p.x, -80, 80) && integer(p.y, -80, 80);
    const same = (a, b) => a.buttons === b.buttons && a.x === b.x && a.y === b.y;
    function encode(epoch, inputs, ack = 0, mask = 0) {
        const buffer = new ArrayBuffer(HEADER + inputs.length * STRIDE), view = new DataView(buffer);
        view.setUint32(0, MAGIC); view.setUint8(4, 2); view.setUint8(5, inputs.length); view.setUint32(8, epoch);
        view.setUint32(12, ack); view.setUint32(16, mask);
        inputs.forEach(({frame, pad}, i) => {
            const at = HEADER + i * STRIDE;
            view.setUint32(at, frame); view.setUint16(at + 4, pad.buttons); view.setInt8(at + 6, pad.x); view.setInt8(at + 7, pad.y);
        });
        return buffer;
    }
    function decodePacket(buffer, epoch, frame) {
        if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < HEADER || buffer.byteLength > HEADER + STRIDE * REDUNDANCY) return null;
        const view = new DataView(buffer), count = view.getUint8(5), ack = view.getUint32(12), mask = view.getUint32(16);
        if (view.getUint32(0) !== MAGIC || view.getUint8(4) !== 2 || !integer(count, 0, REDUNDANCY) ||
            view.getUint16(6) !== 0 || view.getUint32(8) !== epoch || buffer.byteLength !== HEADER + count * STRIDE || ack > 0x7fffffff) return null;
        const inputs = [];
        let previous = 0;
        for (let i = 0; i < count; ++i) {
            const at = HEADER + i * STRIDE, number = view.getUint32(at);
            const pad = {buttons: view.getUint16(at + 4), x: view.getInt8(at + 6), y: view.getInt8(at + 7)};
            if (!integer(number, 1, 0x7fffffff) || number <= previous || number > frame + HISTORY || !validPad(pad)) return null;
            previous = number;
            if (number >= Math.max(1, frame - HISTORY)) inputs.push({frame: number, pad});
        }
        return {inputs, ack, mask, hasInputs: count > 0};
    }
    function decode(buffer, epoch, frame) { return decodePacket(buffer, epoch, frame)?.inputs ?? null; }
    class RollbackInputTransport {
        constructor({socket, epoch, players, slot, spectator, receiveInput, frame,
            PeerConnection = globalThis.RTCPeerConnection, clock = () => performance.now()}) {
            Object.assign(this, {socket, epoch, players, slot, receiveInput, frame, PeerConnection, clock});
            this.enabled = !spectator && players > 1 && integer(players, 2, 4) && integer(slot, 0, players - 1) &&
                integer(epoch, 0, 0xffffffff) && typeof PeerConnection === 'function';
            this.running = false; this.closed = false; this.configured = false;
            this.relayConfirmed = 0; this.sentThrough = 0;
            this.peers = new Map(); this.history = new Map();
            this.metrics = {sentPackets: 0, receivedPackets: 0, receivedInputs: 0, duplicates: 0, invalidPackets: 0,
                backpressureDrops: 0, failedPeers: 0, repairPackets: 0, ackPackets: 0, reconnectAttempts: 0, recoveredPeers: 0};
            this.handlers = {
                rollback_transport: event => this.configure(event),
                rollback_peer: event => this.peerReady(event),
                rollback_signal: event => this.signal(event),
                frameset: event => {
                    if (this.validEvent(event) && integer(event.frame, this.relayConfirmed + 1, this.sentThrough)) this.confirm(event.frame);
                }
            };
            if (this.enabled) for (const [name, handler] of Object.entries(this.handlers)) socket.on(name, handler);
        }
        start() {
            if (!this.enabled || this.running || this.closed) return;
            this.running = true;
            this.socket.emit('rollback_connect', {epoch: this.epoch});
        }
        validEvent(event) { return this.running && !this.closed && event?.epoch === this.epoch; }
        current(peer) { return !this.closed && this.peers.get(peer.slot) === peer; }
        active(peer) { return this.current(peer) && !peer.failed; }
        // Keep the reliable journal inside its bounded 128-frame acceptance horizon.
        canSend(frame) { return !this.enabled || frame <= this.relayConfirmed + 120; }
        // Lockstep owners also confirm rows this instance never sent, such as
        // replayed history after a reloaded tab rebuilds its match.
        confirm(frame) {
            if (!this.enabled || this.closed || !integer(frame, this.relayConfirmed + 1, 0x7fffffff)) return;
            this.relayConfirmed = frame;
            // A received complete relay row also proves receipt of each
            // remote input. This lets late RTC connections ACK past the
            // beginning of the bounded repair history.
            for (const peer of this.peers.values()) {
                peer.receiveThrough = Math.max(peer.receiveThrough, frame);
                this.advanceReceipt(peer);
            }
        }
        configure(event) {
            if (!this.validEvent(event) || this.configured || event.slot !== this.slot || event.players !== this.players ||
                !Array.isArray(event.peers) || !Array.isArray(event.iceServers)) return;
            this.iceServers = event.iceServers;
            this.configured = true;
            for (const slot of event.peers) this.peerReady({epoch: this.epoch, slot});
        }
        peerReady(event) {
            if (!this.validEvent(event) || !this.configured || !integer(event.slot, 0, this.players - 1) || event.slot === this.slot) return;
            // The relay announces each seat connection once. Another announcement
            // is a new remote instance (a reloaded tab): a new input stream that
            // starts at the relay frontier, negotiated from generation zero.
            const old = this.peers.get(event.slot);
            if (old) { this.closeConnection(old); this.peers.delete(event.slot); }
            const peer = this.ensurePeer(event.slot);
            if (peer && this.slot < event.slot) this.offer(peer);
        }
        ensurePeer(slot, generation = 0) {
            const old = this.peers.get(slot);
            if (old && generation <= old.generation) return old;
            const peer = {slot, generation, pc: null, queue: Promise.resolve(), candidates: [],
                received: old?.received ?? new Map(), receiveThrough: old?.receiveThrough ?? this.relayConfirmed,
                ackThrough: old?.ackThrough ?? 0, acked: old?.acked ?? new Set(), futureCandidates: new Map(),
                failed: false, offered: false, ackPending: false, lastAck: -Infinity, lastInputSend: -Infinity,
                lastRepair: this.clock(), retryAt: null, restartRequests: 0, disconnectedAt: null,
                deadline: this.clock() + CONNECT_MS};
            if (old) peer.candidates = old.futureCandidates.get(generation) ?? [];
            this.peers.set(slot, peer);
            if (old) this.closeConnection(old);
            try { peer.pc = new this.PeerConnection({iceServers: this.iceServers}); }
            catch (_) { this.failPeer(peer); return peer; }
            const pc = peer.pc;
            pc.onicecandidate = event => {
                if (this.active(peer) && event.candidate) this.sendSignal(peer, 'candidate', event.candidate.toJSON());
            };
            pc.ondatachannel = event => this.attachChannel(peer, event.channel);
            pc.onconnectionstatechange = () => {
                if (!this.active(peer)) return;
                if (['failed', 'closed'].includes(pc.connectionState)) this.failPeer(peer);
                else if (pc.connectionState === 'disconnected') peer.disconnectedAt ??= this.clock();
                else peer.disconnectedAt = null;
                this.scheduleMaintenance();
            };
            this.scheduleMaintenance();
            return peer;
        }
        offer(peer) {
            if (!this.active(peer) || peer.offered) return;
            peer.offered = true;
            try { this.attachChannel(peer, peer.pc.createDataChannel('rollback-input-v2', {ordered: false, maxRetransmits: 0})); }
            catch (_) { this.failPeer(peer); return; }
            peer.queue = peer.queue.then(async () => {
                if (!this.active(peer)) return;
                const offer = await peer.pc.createOffer();
                if (!this.active(peer)) return;
                await peer.pc.setLocalDescription(offer);
                if (this.active(peer)) this.sendSignal(peer, 'offer', peer.pc.localDescription.sdp);
            }).catch(() => { if (this.active(peer)) this.failPeer(peer); });
        }
        sendSignal(peer, type, value) {
            if (this.current(peer) && (!peer.failed || type === 'restart'))
                this.socket.emit('rollback_signal', {epoch: this.epoch, to: peer.slot, generation: peer.generation, type, value});
        }
        signal(event) {
            if (!this.validEvent(event) || !this.configured || event.to !== this.slot ||
                !integer(event.from, 0, this.players - 1) || event.from === this.slot) return;
            const generation = event.generation ?? 0;
            if (!integer(generation, 0, MAX_GENERATION)) return;
            let peer = this.ensurePeer(event.from);
            if (generation < peer.generation) return;
            if (event.type === 'restart') {
                if (event.from > this.slot && generation === peer.generation && event.value === null) this.failPeer(peer);
                return;
            }
            if (generation > peer.generation) {
                if (event.from > this.slot) return;
                if (event.type === 'candidate') {
                    const count = Array.from(peer.futureCandidates.values()).reduce((n, rows) => n + rows.length, 0);
                    if (count < 64) {
                        if (!peer.futureCandidates.has(generation)) peer.futureCandidates.set(generation, []);
                        peer.futureCandidates.get(generation).push(event.value);
                    }
                    return;
                }
                if (event.type !== 'offer' || typeof event.value !== 'string') return;
                peer = this.ensurePeer(event.from, generation);
            }
            if (!this.active(peer)) return;
            peer.queue = peer.queue.then(async () => {
                if (!this.active(peer)) return;
                if (event.type === 'candidate') {
                    if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(event.value);
                    else if (peer.candidates.length < 64) peer.candidates.push(event.value);
                    return;
                }
                if (!['offer', 'answer'].includes(event.type) || typeof event.value !== 'string' ||
                    (event.type === 'offer') !== (event.from < this.slot)) return;
                await peer.pc.setRemoteDescription({type: event.type, sdp: event.value});
                if (!this.active(peer)) return;
                for (const candidate of peer.candidates.splice(0)) {
                    await peer.pc.addIceCandidate(candidate);
                    if (!this.active(peer)) return;
                }
                if (event.type === 'offer') {
                    const answer = await peer.pc.createAnswer();
                    if (!this.active(peer)) return;
                    await peer.pc.setLocalDescription(answer);
                    if (this.active(peer)) this.sendSignal(peer, 'answer', peer.pc.localDescription.sdp);
                }
            }).catch(() => { if (this.active(peer)) this.failPeer(peer); });
        }
        attachChannel(peer, channel) {
            if (!this.active(peer) || peer.channel || channel.label !== 'rollback-input-v2' ||
                channel.ordered !== false || channel.maxRetransmits !== 0) { channel.close(); return; }
            peer.channel = channel; channel.binaryType = 'arraybuffer'; channel.bufferedAmountLowThreshold = HEADER + STRIDE * REDUNDANCY;
            channel.onopen = () => {
                if (!this.active(peer) || peer.opened) return;
                peer.opened = true; peer.deadline = null;
                if (peer.generation) this.metrics.recoveredPeers++;
                this.repair(peer);
                this.scheduleMaintenance();
            };
            channel.onerror = () => { if (this.active(peer)) this.failPeer(peer); };
            channel.onclose = () => { if (this.active(peer)) this.failPeer(peer); };
            channel.onbufferedamountlow = () => {
                if (this.active(peer) && peer.blocked) {
                    peer.blocked = false; this.repair(peer); this.scheduleMaintenance();
                }
            };
            channel.onmessage = event => this.receivePacket(peer, event.data);
        }
        advanceReceipt(peer) {
            while (peer.received.has(peer.receiveThrough + 1)) ++peer.receiveThrough;
            for (const number of peer.received.keys()) if (number < this.frame() - HISTORY) peer.received.delete(number);
        }
        receivePacket(peer, data) {
            if (!this.active(peer)) return;
            const packet = decodePacket(data, this.epoch, this.frame());
            // Validate the complete ACK before mutating either receipt state or
            // input history. Selective bits describe ack+1 through ack+32.
            if (!packet || packet.ack > this.sentThrough || Array.from({length: 32}, (_, i) => i)
                .some(i => (packet.mask & (1 << i)) && packet.ack + i + 1 > this.sentThrough)) {
                this.metrics.invalidPackets++; return;
            }
            this.metrics.receivedPackets++;
            for (const {frame, pad} of packet.inputs) {
                const previous = peer.received.get(frame);
                if (previous && same(previous, pad)) { this.metrics.duplicates++; continue; }
                // Conflicting copies still reach the engine's immutable-input
                // check. A rejected input must never become acknowledged.
                this.metrics.receivedInputs++;
                const accepted = this.receiveInput({epoch: this.epoch, slot: peer.slot, frame, pad});
                if (!this.active(peer) || accepted === false) return;
                peer.received.set(frame, pad);
            }
            this.advanceReceipt(peer);
            peer.ackThrough = Math.max(peer.ackThrough, packet.ack);
            for (let i = 0; i < 32; ++i) if (packet.mask & (1 << i)) peer.acked.add(packet.ack + i + 1);
            for (const number of peer.acked) if (number <= peer.ackThrough || number < this.sentThrough - HISTORY + 1) peer.acked.delete(number);
            if (packet.hasInputs) peer.ackPending = true; // ACK-only never solicits another ACK.
            this.scheduleMaintenance();
        }
        acknowledged(peer, frame) { return frame <= peer.ackThrough || peer.acked.has(frame); }
        sendPacket(peer, inputs, repair = false) {
            const channel = peer.channel;
            if (!this.active(peer) || channel?.readyState !== 'open') return false;
            if (channel.bufferedAmount > 4 * (HEADER + STRIDE * REDUNDANCY)) {
                this.metrics.backpressureDrops++; peer.blocked = true; return false;
            }
            let mask = 0;
            for (let i = 0; i < 32; ++i) if (peer.received.has(peer.receiveThrough + i + 1)) mask |= 1 << i;
            try { channel.send(encode(this.epoch, inputs, peer.receiveThrough, mask >>> 0)); }
            catch (_) { this.failPeer(peer); return false; }
            peer.blocked = false; peer.ackPending = false; peer.lastAck = this.clock(); this.metrics.sentPackets++;
            if (inputs.length) {
                peer.lastInputSend = this.clock();
                if (repair) { peer.lastRepair = this.clock(); this.metrics.repairPackets++; }
            } else this.metrics.ackPackets++;
            return true;
        }
        repair(peer) {
            const inputs = [];
            for (const [frame, pad] of this.history) {
                if (!this.acknowledged(peer, frame)) inputs.push({frame, pad});
                if (inputs.length === REDUNDANCY) break;
            }
            if (inputs.length) return this.sendPacket(peer, inputs, true);
            if (peer.ackPending && this.clock() - peer.lastAck >= ACK_MS) return this.sendPacket(peer, []);
            return false;
        }
        send(frame, pad) {
            if (!this.running || this.closed || !integer(frame, 1, 0x7fffffff) || !validPad(pad) || !this.canSend(frame)) return false;
            // Repairs use this method's saved values; callers cannot rewrite a
            // submitted frame, even after it has fallen out of retained history.
            if (frame <= this.sentThrough) return false;
            this.sentThrough = frame;
            this.history.set(frame, {buttons: pad.buttons, x: pad.x, y: pad.y});
            for (const number of this.history.keys()) if (number < this.sentThrough - HISTORY + 1) this.history.delete(number);
            const inputs = Array.from(this.history, ([frame, pad]) => ({frame, pad})).slice(-REDUNDANCY);
            let sent = false;
            for (const peer of this.peers.values()) sent = this.sendPacket(peer, inputs) || sent;
            this.scheduleMaintenance();
            return sent;
        }
        repairAt(peer) {
            for (const frame of this.history.keys()) if (!this.acknowledged(peer, frame)) {
                const oldGap = frame <= this.sentThrough - REDUNDANCY;
                return Math.max(peer.lastRepair + REPAIR_MS, oldGap ? -Infinity : peer.lastInputSend + REPAIR_MS);
            }
            return Infinity;
        }
        scheduleMaintenance() {
            if (!this.running || this.closed) return;
            let next = Infinity;
            for (const peer of this.peers.values()) {
                if (peer.failed) {
                    if (peer.retryAt !== null) next = Math.min(next, peer.retryAt);
                    continue;
                }
                if (peer.deadline !== null) next = Math.min(next, peer.deadline);
                if (peer.disconnectedAt !== null) next = Math.min(next, peer.disconnectedAt + DISCONNECT_MS);
                // A blocked channel wakes via bufferedamountlow, not a busy
                // timer loop. Closed/connecting channels have their deadline.
                if (peer.channel?.readyState !== 'open' || peer.blocked) continue;
                next = Math.min(next, this.repairAt(peer));
                if (peer.ackPending) next = Math.min(next, peer.lastAck + ACK_MS);
            }
            if (next === Infinity) {
                clearTimeout(this.maintenanceTimer); this.maintenanceTimer = null; this.maintenanceAt = null;
                return;
            }
            const at = Math.max(this.clock() + 1, next);
            // An already earlier wake is harmless and avoids replacing a
            // timer on every input. Recompute its next deadline after it fires.
            if (this.maintenanceTimer && this.maintenanceAt <= at) return;
            clearTimeout(this.maintenanceTimer);
            this.maintenanceAt = at;
            this.maintenanceTimer = setTimeout(() => {
                this.maintenanceTimer = null; this.maintenanceAt = null; this.maintain();
            }, Math.max(1, at - this.clock()));
            this.maintenanceTimer.unref?.();
        }
        maintain() {
            if (!this.running || this.closed) return;
            const now = this.clock();
            for (const peer of this.peers.values()) {
                if (peer.failed) {
                    if (peer.retryAt === null || now < peer.retryAt) continue;
                    peer.retryAt = null;
                    if (this.slot < peer.slot) {
                        if (peer.generation < MAX_GENERATION) {
                            this.metrics.reconnectAttempts++;
                            this.offer(this.ensurePeer(peer.slot, peer.generation + 1));
                        }
                    } else if (peer.restartRequests < MAX_GENERATION) {
                        this.sendSignal(peer, 'restart', null);
                        peer.restartRequests++;
                        if (peer.restartRequests < MAX_GENERATION) peer.retryAt = now + 250 * 2 ** peer.restartRequests;
                    }
                    continue;
                }
                if ((peer.deadline !== null && now >= peer.deadline) ||
                    (peer.disconnectedAt !== null && now - peer.disconnectedAt >= DISCONNECT_MS)) {
                    this.failPeer(peer); continue;
                }
                if (peer.channel?.readyState !== 'open' || peer.blocked) continue;
                if (now >= this.repairAt(peer)) this.repair(peer);
                if (peer.ackPending && now - peer.lastAck >= ACK_MS) this.sendPacket(peer, []);
            }
            this.scheduleMaintenance();
        }
        closeConnection(peer) {
            if (peer.channel) {
                for (const name of ['onopen', 'onclose', 'onerror', 'onmessage', 'onbufferedamountlow']) peer.channel[name] = null;
                peer.channel.close();
            }
            if (peer.pc) {
                peer.pc.onicecandidate = peer.pc.ondatachannel = peer.pc.onconnectionstatechange = null;
                peer.pc.close();
            }
        }
        failPeer(peer) {
            if (!this.active(peer)) return;
            peer.failed = true; this.metrics.failedPeers++; this.closeConnection(peer);
            if (peer.generation < MAX_GENERATION) peer.retryAt = this.clock() + 250 * 2 ** peer.generation;
            this.scheduleMaintenance();
        }
        diagnostics() {
            return {...this.metrics, enabled: this.enabled, relayConfirmed: this.relayConfirmed, retainedInputs: this.history.size,
                openPeers: Array.from(this.peers.values()).filter(p => !p.failed && p.channel?.readyState === 'open').length};
        }
        dispose() {
            if (this.closed) return;
            this.closed = true; this.running = false; clearTimeout(this.maintenanceTimer);
            if (this.enabled) for (const [name, handler] of Object.entries(this.handlers)) this.socket.off(name, handler);
            for (const peer of this.peers.values()) this.closeConnection(peer);
            this.peers.clear(); this.history.clear();
        }
    }
    return {RollbackInputTransport, encode, decode};
});
