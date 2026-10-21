/* Presentation only: authenticated room signaling, no camera/microphone access.
 * Capture once, encode per viewer. A short decoded-video lease keeps the bounded
 * image relay available during negotiation, stalled streams and ICE failure. */
(() => {
    'use strict';
    const TARGET = Object.freeze({width: 1920, height: 1080, fps: 60, bitrate: 12000000});
    const videoBackends = new Set(['solo-media-v1', 'devilution-native-v1', 'cmr2-server-relay-v1']);
    const isViewer = (game, member) => member.connected && member.role === 'spectator' &&
        (member.watchMode === 'media' || videoBackends.has(game.backend));
    const closePeer = peer => { if (peer) { peer.closed = true; peer.pc.close(); } };
    const emit = (session, name, data = {}) => session.socket.emit(name, {epoch: session.epoch, ...data});
    function peerFor(session, event) {
        const pc = new RTCPeerConnection({iceServers: event.iceServers, bundlePolicy: 'max-bundle'});
        const peer = {pc, id: event.peer, token: event.token, pending: [], chain: Promise.resolve(), closed: false, activeUntil: 0};
        peer.send = (type, value) => {
            if (!peer.closed) emit(session, 'spectator_signal', {to: peer.id, token: peer.token, type, value});
        };
        pc.onicecandidate = ({candidate}) => { if (candidate) peer.send('candidate', candidate.toJSON()); };
        return peer;
    }
    async function signal(peer, event) {
        if (peer.closed) return;
        if (event.type === 'candidate') {
            if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(event.value);
            else if (peer.pending.length < 128) peer.pending.push(event.value);
        } else {
            await peer.pc.setRemoteDescription({type: event.type, sdp: event.value});
            for (const candidate of peer.pending.splice(0)) await peer.pc.addIceCandidate(candidate);
            if (event.type === 'offer') {
                const answer = videoDescription(await peer.pc.createAnswer());
                await peer.pc.setLocalDescription(answer);
                peer.send('answer', answer.sdp);
            }
        }
    }
    function videoDescription(offer) {
        // Chromium starts camera calls at a few hundred kbps, which initially
        // scales game video down even on a fast link. This codec hint starts at
        // 8 Mbps; congestion control can still reduce it and other engines may
        // ignore the hint. The standard sender parameters enforce the ceiling.
        const sections = offer.sdp.split(/(?=m=)/);
        offer.sdp = sections.map(section => {
            if (!section.startsWith('m=video')) return section;
            for (const match of [...section.matchAll(/a=rtpmap:(\d+) (?:VP8|VP9|H264|AV1)\//g)]) {
                const pattern = new RegExp('a=fmtp:' + match[1] + ' ([^\\r\\n]*)');
                if (pattern.test(section)) section = section.replace(pattern, '$&;x-google-start-bitrate=8000');
                else section += 'a=fmtp:' + match[1] + ' x-google-start-bitrate=8000\r\n';
            }
            return section;
        }).join('');
        return offer;
    }
    function enqueue(peer, action) {
        peer.chain = peer.chain.then(() => peer.closed ? undefined : action()).catch(error => { peer.error = error.message; closePeer(peer); });
    }
    class Publisher {
        constructor(session, adapter, room) {
            this.session = session; this.adapter = adapter; this.room = room;
            this.peers = new Map(); this.requests = new Map(); this.stopped = false;
            this.update = event => {
                if (event.epoch === session.epoch) { this.room = event; this.maintain(); }
            };
            this.transport = event => {
                if (!this.live() || event.epoch !== session.epoch || !event.publisher) return;
                this.requests.set(event.peer, event); this.maintain();
            };
            this.signal = event => {
                const peer = this.peers.get(event.from);
                if (event.epoch === session.epoch && peer?.token === event.token) enqueue(peer, () => signal(peer, event));
            };
            this.state = event => {
                const peer = this.peers.get(event.peer);
                if (event.epoch === session.epoch && peer?.token === event.token)
                    peer.activeUntil = event.active ? performance.now() + 4500 : 0;
            };
            this.handlers = {room_update: this.update, start: this.update, spectator_transport: this.transport,
                spectator_signal: this.signal, spectator_stream_state: this.state};
            for (const [name, handler] of Object.entries(this.handlers)) session.socket.on(name, handler);
            this.timer = setInterval(() => this.maintain(), 500);
        }
        live() {
            const s = this.session;
            return !this.stopped && s.running && !s.failed && s.socket.connected &&
                s.slot === (s.game.backend === 'cmr2-server-relay-v1' ? s.coordinator : 0);
        }
        viewers() { return this.room.members.filter(m => isViewer(this.session.game, m)); }
        fallbackNeeded() {
            return this.live() && this.viewers().some(m => {
                const peer = this.peers.get(m.id);
                return !peer || peer.closed || peer.activeUntil < performance.now();
            });
        }
        maintain() {
            const viewers = this.live() ? this.viewers() : [];
            const ids = new Set(viewers.map(m => m.id));
            for (const [id, peer] of this.peers) if (!ids.has(id)) { closePeer(peer); this.peers.delete(id); }
            for (const id of this.requests.keys()) if (!ids.has(id)) this.requests.delete(id);
            if (!viewers.length) { this.releaseCapture(); return; }
            if (!this.lastConnect || performance.now() - this.lastConnect > 2500) {
                this.lastConnect = performance.now(); emit(this.session, 'spectator_connect');
            }
            const surface = this.adapter.spectatorSurface();
            if (!surface?.width || !surface.height) return;
            if (!this.capture && surface.captureStream) {
                try {
                    this.capture = surface.captureStream(TARGET.fps);
                    this.capture.getVideoTracks()[0].contentHint = 'motion';
                } catch { /* The bounded relay remains usable if capture is unsupported. */ }
            }
            const source = this.adapter.spectatorAudioSource?.();
            if (source && source !== this.audioSource && source.context.state !== 'closed') {
                this.releaseAudio(); this.audioSource = source;
                this.audioDestination = source.context.createMediaStreamDestination();
                source.connect(this.audioDestination);
                // Only the fallback uses PCM; WebRTC carries the full-rate mix.
                this.tap = source.context.createScriptProcessor(4096, 2, 1);
                source.connect(this.tap); this.tap.connect(this.audioDestination);
                this.tap.onaudioprocess = event => {
                    if (!this.fallbackNeeded()) return;
                    const input = event.inputBuffer;
                    this.onAudio?.(input.getChannelData(0), input.getChannelData(Math.min(1, input.numberOfChannels - 1)), input.sampleRate);
                };
            }
            for (const [id, request] of this.requests) {
                let peer = this.peers.get(id);
                if (peer?.token !== request.token) { closePeer(peer); this.peers.delete(id); peer = null; }
                if (!peer && this.capture && typeof RTCPeerConnection !== 'undefined') {
                    try {
                        peer = peerFor(this.session, request); this.peers.set(id, peer);
                        peer.video = peer.pc.addTransceiver(this.capture.getVideoTracks()[0], {direction: 'sendonly',
                            streams: [this.capture], sendEncodings: [{maxBitrate: TARGET.bitrate, maxFramerate: TARGET.fps}]}).sender;
                        peer.audio = peer.pc.addTransceiver('audio', {direction: 'sendonly'}).sender;
                        enqueue(peer, async () => {
                            const offer = videoDescription(await peer.pc.createOffer()); await peer.pc.setLocalDescription(offer);
                            peer.send('offer', offer.sdp);
                        });
                    } catch { closePeer(peer); }
                }
                if (!peer || peer.closed) continue;
                const audioTrack = this.audioDestination?.stream.getAudioTracks()[0] || null;
                if (peer.audioTrack !== audioTrack) {
                    peer.audioTrack = audioTrack;
                    enqueue(peer, () => peer.audio.replaceTrack(audioTrack));
                }
                const scale = Math.max(1, surface.width / TARGET.width, surface.height / TARGET.height);
                if (peer.scale !== scale) {
                    peer.scale = scale;
                    enqueue(peer, async () => {
                        const params = peer.video.getParameters();
                        if (params.encodings?.length) {
                            Object.assign(params.encodings[0], {maxBitrate: TARGET.bitrate, maxFramerate: TARGET.fps, scaleResolutionDownBy: scale});
                            params.degradationPreference = 'balanced';
                            // Some engines do not implement every encoding control.
                            await peer.video.setParameters(params).catch(() => {});
                        }
                    });
                }
            }
        }
        releaseAudio() {
            if (this.audioSource) {
                for (const node of [this.audioDestination, this.tap]) if (node) try { this.audioSource.disconnect(node); } catch {}
            }
            if (this.tap) { this.tap.onaudioprocess = null; this.tap.disconnect(); }
            this.audioDestination?.stream.getTracks().forEach(track => track.stop());
            this.audioSource = this.audioDestination = this.tap = null;
        }
        releaseCapture() {
            this.capture?.getTracks().forEach(track => track.stop()); this.capture = null; this.releaseAudio();
        }
        dispose() {
            this.stopped = true; clearInterval(this.timer);
            for (const [name, handler] of Object.entries(this.handlers)) this.session.socket.off(name, handler);
            for (const peer of this.peers.values()) closePeer(peer);
            this.peers.clear(); this.requests.clear(); this.releaseCapture();
        }
    }
    class Receiver {
        constructor(session, onStream, onActive) {
            this.session = session; this.onStream = onStream; this.onActive = onActive;
            this.transport = event => {
                if (event.epoch !== session.epoch || event.publisher || event.token !== this.token || typeof RTCPeerConnection === 'undefined') return;
                if (this.peer?.id === event.peer && this.peer.token === event.token) return;
                closePeer(this.peer); this.lastFrame = 0; this.onActive(false);
                try {
                    const peer = this.peer = peerFor(session, event), stream = new MediaStream();
                    peer.pc.ontrack = event => {
                        if (peer.closed) return;
                        stream.addTrack(event.track); this.onStream(stream);
                    };
                    peer.pc.onconnectionstatechange = () => { if (['failed', 'closed', 'disconnected'].includes(peer.pc.connectionState)) this.status(false); };
                } catch { /* Fallback can still receive without WebRTC. */ }
            };
            this.signal = event => {
                if (event.epoch === session.epoch && this.peer?.id === event.from && this.peer.token === event.token)
                    enqueue(this.peer, () => signal(this.peer, event));
            };
            session.socket.on('spectator_transport', this.transport); session.socket.on('spectator_signal', this.signal);
            this.retry();
            this.timer = setInterval(() => {
                const active = this.lastFrame > 0 && performance.now() - this.lastFrame < 3000 && !this.peer?.closed && this.peer?.pc.connectionState === 'connected';
                this.status(active);
                if (!active && performance.now() - this.attempt > 12000) this.retry();
            }, 2000);
        }
        status(active) {
            this.onActive(active);
            emit(this.session, 'spectator_stream_state', {token: this.token, active});
        }
        frame() {
            if (!this.peer || this.peer.closed || this.peer.pc.connectionState !== 'connected') return;
            const first = !this.lastFrame || performance.now() - this.lastFrame >= 3000;
            this.lastFrame = performance.now();
            if (first) this.status(true);
        }
        retry() {
            if (this.token) this.status(false);
            closePeer(this.peer); this.peer = null; this.lastFrame = 0;
            this.token = crypto.randomUUID(); this.attempt = performance.now();
            emit(this.session, 'spectator_connect', {token: this.token});
        }
        dispose() {
            this.status(false); clearInterval(this.timer); closePeer(this.peer);
            this.session.socket.off('spectator_transport', this.transport); this.session.socket.off('spectator_signal', this.signal);
        }
    }
    PeakNet.SpectatorStream = {Publisher, Receiver, isViewer, videoBackends, target: TARGET};
})();
