// Compatibility adapter: MK64 alone enables the race acceleration latch.
(function (root) {
    const api = typeof module === 'object' && module.exports ? require('./n64_touch.js') : root.N64Touch;
    const adapter = {isMobile: api.isMobile, create: ({raceState, ...options}) =>
        api.create({...options, canLatchA: () => raceState() === 3})};
    if (typeof module === 'object' && module.exports) module.exports = adapter;
    if (root) root.mk64Touch = adapter;
})(typeof window !== 'undefined' ? window : null);
