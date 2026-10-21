/* Shared spectator presentation for every streamed game; simulation viewers
 * (including Perfect Dark) keep their existing native rendering path. */
(() => {
    'use strict';
    const $ = id => document.getElementById(id);
    const mediaEvent = game => ({'solo-media-v1':'solo_media', 'devilution-native-v1':'diablo_media', 'cmr2-server-relay-v1':'cmr2_media'})[game.backend] || 'spectator_media';
    PeakNet.publishSpectators = (session, adapter, initialRoom) => {
        if (session.spectator || !adapter.spectatorSurface) return () => {};
        const publisher = new PeakNet.SpectatorStream.Publisher(session, adapter, initialRoom);
        session.spectatorPublisher = publisher;
        let stopped = false, busy = false;
        const broadcast = (kind, payload) => {
            if (!stopped && publisher.fallbackNeeded() && (session.socket.io?.engine?.writeBuffer?.length || 0) < 4)
                session.socket.emit(mediaEvent(session.game), {epoch: session.epoch, kind, payload: new Uint8Array(payload.buffer || payload)});
        };
        publisher.onAudio = (left, right, rate) => {
            const ratio = rate / 16000, pcm = new Int16Array(Math.floor(left.length / ratio));
            for (let i = 0; i < pcm.length; i++) {
                const at = Math.floor(i * ratio);
                pcm[i] = Math.round(Math.max(-1, Math.min(1, (left[at] + right[at]) / 2)) * 32767);
            }
            if (pcm.length) broadcast('audio', pcm);
        };
        const copy = document.createElement('canvas'), context = copy.getContext('2d');
        const timer = setInterval(() => {
            if (stopped || busy || !publisher.fallbackNeeded()) return;
            const canvas = adapter.spectatorSurface();
            if (!canvas?.width || !canvas.height) return;
            const scale = Math.min(1, 1280 / canvas.width, 720 / canvas.height);
            const width = Math.max(1, Math.round(canvas.width * scale)), height = Math.max(1, Math.round(canvas.height * scale));
            if (copy.width !== width || copy.height !== height) { copy.width = width; copy.height = height; }
            busy = true;
            try {
                context.drawImage(canvas, 0, 0, width, height);
                copy.toBlob(async blob => {
                    try {
                        // Noisy scenes can exceed the relay's frame bound. Send
                        // a smaller picture instead of dropping every frame.
                        if (blob?.size > 192 * 1024 && !stopped && publisher.fallbackNeeded()) {
                            copy.width = Math.max(1, Math.floor(width / 2)); copy.height = Math.max(1, Math.floor(height / 2));
                            context.drawImage(canvas, 0, 0, copy.width, copy.height);
                            blob = await new Promise(resolve => copy.toBlob(resolve, 'image/webp', .7));
                        }
                        if (blob && blob.size <= 192 * 1024) broadcast('video', await blob.arrayBuffer());
                    }
                    finally { busy = false; }
                }, 'image/webp', .82);
            } catch { busy = false; }
        }, 50);
        return () => { stopped = true; clearInterval(timer); publisher.dispose(); };
    };
    class SpectatorSession {
        static async create(options) { return new SpectatorSession(options); }
        constructor(options) {
            Object.assign(this, options);
            this.running = false; this.failed = false; this.frame = 0;
            this.onMedia = event => {
                if (!this.running || this.failed || event.epoch !== this.epoch) return;
                this.socket.emit(mediaEvent(this.game) + '_ack', {epoch: this.epoch, sequence: event.sequence});
                if (!this.streaming) this.media?.(event);
            };
            this.socket.on(mediaEvent(this.game), this.onMedia);
        }
        bind(media, stream, active) {
            this.media = media; this.onStream = stream; this.onActive = active;
            this.socket.emit('loaded', {epoch: this.epoch, compatibility: this.game});
        }
        start() {
            if (this.running || this.failed) return;
            this.running = true;
            this.receiver = new PeakNet.SpectatorStream.Receiver(this, this.onStream, active => {
                if (this.streaming === active) return;
                this.streaming = active; this.onActive(active);
            });
        }
        latency() {}
        dispose() {
            this.receiver?.dispose(); this.running = false; this.failed = true;
            this.media = this.onStream = this.onActive = null;
            this.socket.off(mediaEvent(this.game), this.onMedia);
        }
    }
    PeakNet.backends.set('spectator-media-v1', SpectatorSession);
    const area = $('retro-spectator-area'), canvas = $('retro-spectator-canvas'), context = canvas.getContext('2d');
    const video = document.createElement('video');
    video.id = 'retro-spectator-video'; video.className = 'game-surface'; video.autoplay = true;
    video.playsInline = true; video.muted = true; video.hidden = true; video.setAttribute('aria-label', 'Live game');
    canvas.after(video);
    let generation = 0, audio, gain, nextAudio = 0, decoding = false, streaming = false, soundEnabled = false, videoCallback;
    const volume = $('retro-spectator-volume'), status = $('retro-spectator-status');
    const setVolume = () => { video.volume = Number(volume.value) / 100; if (gain) gain.gain.value = streaming ? 0 : Number(volume.value) / 100; };
    volume.addEventListener('input', setVolume);
    $('retro-spectator-sound').addEventListener('click', () => {
        soundEnabled = true; video.muted = false; if (video.srcObject) video.play().catch(() => {});
        if (!audio) { audio = new AudioContext(); gain = audio.createGain(); gain.connect(audio.destination); }
        setVolume(); audio.resume().catch(() => {});
        $('retro-spectator-sound').textContent = 'Sound enabled';
    });
    GameFullscreen.create({area: $('retro-spectator-screen'), button: $('retro-spectator-fullscreen'), status, focusGame: () => canvas.focus()});
    PeakNet.adapters.set('spectator-media', {
        present({name}) { $('retro-spectator-title').textContent = name + ' · Spectating'; },
        hostChanged() {},
        stop() {
            generation++; area.hidden = true; decoding = false; streaming = false;
            video.cancelVideoFrameCallback?.(videoCallback); video.ontimeupdate = null; video.pause(); video.srcObject = null; video.hidden = true;
            video.muted = true; soundEnabled = false; $('retro-spectator-sound').textContent = 'Enable sound';
            audio?.close().catch(() => {}); audio = gain = null; nextAudio = 0;
        },
        async launch({session}) {
            const current = ++generation; area.hidden = false; canvas.hidden = false;
            context.clearRect(0, 0, canvas.width, canvas.height);
            status.textContent = 'Connecting to the live game…';
            const onFrame = () => {
                if (current !== generation) return;
                session.frame++; session.receiver?.frame();
                videoCallback = video.requestVideoFrameCallback(onFrame);
            };
            if (video.requestVideoFrameCallback) videoCallback = video.requestVideoFrameCallback(onFrame);
            else video.ontimeupdate = () => {
                if (current === generation && video.readyState >= 2) { session.frame++; session.receiver?.frame(); }
            };
            session.bind(async event => {
                if (current !== generation || streaming) return;
                if (event.kind === 'video') {
                    if (decoding) return;
                    decoding = true;
                    try {
                        const picture = await createImageBitmap(new Blob([event.payload], {type: 'image/webp'}));
                        if (current === generation && !streaming) {
                            if (canvas.width !== picture.width || canvas.height !== picture.height) { canvas.width = picture.width; canvas.height = picture.height; }
                            context.drawImage(picture, 0, 0); session.frame++;
                            status.textContent = 'Watching live · connecting high-quality video…';
                        }
                        picture.close();
                    } catch {} finally { if (current === generation) decoding = false; }
                } else if (event.kind === 'audio' && audio?.state === 'running') {
                    const pcm = new Int16Array(event.payload), buffer = audio.createBuffer(1, pcm.length, 16000);
                    const samples = buffer.getChannelData(0);
                    for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i] / 32768;
                    const now = audio.currentTime;
                    if (nextAudio < now || nextAudio > now + .5) nextAudio = now + .08;
                    const source = audio.createBufferSource(); source.buffer = buffer; source.connect(gain);
                    source.start(nextAudio); nextAudio += buffer.duration;
                }
            }, stream => {
                if (current !== generation) return;
                if (video.srcObject !== stream) video.srcObject = stream;
                video.hidden = false; video.style.opacity = streaming ? '1' : '0'; video.muted = !soundEnabled;
                setVolume(); video.play().catch(() => {});
            }, active => {
                if (current !== generation) return;
                streaming = active; canvas.hidden = active; video.style.opacity = active ? '1' : '0';
                video.muted = !active || !soundEnabled; setVolume();
                status.textContent = active ? 'Watching live' : 'Reconnecting high-quality video…';
            });
        }
    });
})();
