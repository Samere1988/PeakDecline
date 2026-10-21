/* Analyze already-loaded local artwork; no additional downloads. */
(() => {
    const selector = '.ch-logo, .fav-icon, #current-channel-logo';
    const backgrounds = new Map();
    function apply(img) {
        if (!img.matches(selector) || !img.naturalWidth) return;
        const source = img.currentSrc || img.src;
        if (backgrounds.has(source)) {
            img.dataset.logoBackground = backgrounds.get(source);
            return;
        }
        // Remote images without CORS cannot be sampled. Keep the existing tile.
        if (new URL(source, location.href).origin !== location.origin) return;
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 48;
        const context = canvas.getContext('2d', {willReadFrequently: true});
        if (!context) return;
        try {
            context.drawImage(img, 0, 0, 48, 48);
            const pixels = context.getImageData(0, 0, 48, 48).data;
            let weight = 0, brightness = 0, transparent = 0;
            for (let i = 0; i < pixels.length; i += 4) {
                const alpha = pixels[i + 3] / 255;
                if (alpha < .95) transparent++;
                if (alpha < .15) continue;
                weight += alpha;
                brightness += alpha * (.2126 * pixels[i] + .7152 * pixels[i + 1] + .0722 * pixels[i + 2]);
            }
            // Solid-background artwork already supplies its own contrast.
            const background = transparent > 23 && weight && brightness / weight > 145 ? 'dark' : 'light';
            backgrounds.set(source, background);
            img.dataset.logoBackground = background;
        } catch (_) { /* Unsupported/tainted images retain the default styling. */ }
    }
    document.addEventListener('load', event => {
        if (event.target instanceof HTMLImageElement) apply(event.target);
    }, true);
    document.querySelectorAll(selector).forEach(apply);
})();
