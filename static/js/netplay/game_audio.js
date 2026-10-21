/* Local master volume for isolated SDL/Web Audio game runtimes. Spectators tap
 * the full-rate mix before this gain, independent of the player's volume. */
(() => {
    'use strict';
    let level = 1;
    const gains = new Map();
    const connect = AudioNode.prototype.connect;
    const disconnect = AudioNode.prototype.disconnect;
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(kind, options) {
        return getContext.call(this, kind, kind.includes('webgl') ? {...options, preserveDrawingBuffer: true} : options);
    };
    function output(context) {
        if (!gains.has(context)) {
            const gain = context.createGain(), mix = context.createGain();
            gain.gain.value = level;
            connect.call(gain, context.destination); connect.call(mix, gain);
            gains.set(context, {gain, mix});
        }
        return gains.get(context).mix;
    }
    window.peakSpectatorAudioSource = () => {
        for (const [context, {mix}] of gains) if (context.state !== 'closed') return mix;
    };
    AudioNode.prototype.connect = function(destination, ...args) {
        const target = destination === this.context.destination ? output(this.context) : destination;
        const result = connect.call(this, target, ...args);
        return result === target ? destination : result;
    };
    AudioNode.prototype.disconnect = function(...args) {
        if (args[0] === this.context.destination && gains.has(this.context)) args[0] = gains.get(this.context).mix;
        return disconnect.apply(this, args);
    };
    window.setPeakGameVolume = value => {
        if (!Number.isFinite(value)) return;
        level = Math.max(0, Math.min(1, value));
        for (const [context, {gain}] of gains) gain.gain.setTargetAtTime(level, context.currentTime, 0.01);
    };
    window.addEventListener('pagehide', () => {
        for (const context of gains.keys()) context.close().catch(() => {});
        gains.clear();
    });
})();
