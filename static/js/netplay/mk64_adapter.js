/* The only shared-framework module that knows MK64's existing browser bridge. */
(() => {
    'use strict';
    PeakNet.adapters.set('mk64', {
        spectatorSurface: () => document.getElementById('mk64-canvas'),
        spectatorAudioSource: () => window.mk64SpectatorAudioSource?.(),
        present({name, spectator, requestRestart}) {
            document.getElementById('mk64-play-title').textContent = `${name} · ${spectator ? 'Spectating' : 'Mario Kart 64'}`;
            window.mk64RequestRestart = requestRestart;
        },
        hostChanged(isHost) { document.getElementById('mk64-restart').hidden = !isHost; },
        async launch({session, slot, players, canRestart, restart, initialSave}) {
            const authority = session.game.backend === 'mk64-server-authority-v1';
            const bridge = {
                spectator: session.spectator, initialSave, saveOwner:!authority && !session.spectator && slot===0,
                externallyStepped:authority,
                initialized: (module, input) => authority ? session.bindNative(module, input) : undefined,
                bind(module, input) {
                    if (authority) return;
                    session.bind({deferLoaded: true, sampleInput: () => ({buttons: input.buttons, x: input.x, y: input.y}),
                        hashForFrame: frame => module._web_hash_for_frame(frame)});
                },
                frameReady: frame => session.frameReady(frame),
                getFrame: frame => session.getFrame(frame),
                catchingUp: () => session.catchingUp(),
                fail: message => session.fail(message)
            };
            const launch = restart ? window.mk64RestartOnline : window.mk64StartOnline;
            await launch({slot, players, canRestart, network: bridge});
            if (!session.adapter || session.failed) throw new Error('Mario Kart 64 could not be loaded.');
        },
        async stop() {
            await window.mk64StopOnline?.();
            document.getElementById('mk64-play-area').hidden = true;
            document.getElementById('mk64-restart').hidden = true;
        }
    });
})();
