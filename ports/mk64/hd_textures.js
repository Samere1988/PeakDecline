/* Injected into the native JS build with a pinned, generated texture manifest. */
(() => {
    'use strict';
    const manifest = Module.mk64HDManifest;
    if (!manifest || Module.mk64Headless === true || Module.mk64GraphicsBaseline === true) return;
    const base = new URL(Module.mk64HDBase || '/static/mk64-hd/' + manifest.assetId + '/',
        typeof location === 'object' ? location.href : 'http://localhost/');
    const cache = new Map(), pending = new Map(), bindings = new WeakMap();
    const queue = [], controller = new AbortController();
    const budget = 64 * 1024 * 1024;
    let active = 0, bytes = 0, disposed = false, serial = 0;
    const stats = {matched: 0, applied: 0, cacheHits: 0, requests: 0, failed: 0,
        bitmapBytes: 0, peakBitmapBytes: 0, firstApplied: [], groups: {}, pack: manifest.pack, release: manifest.release};
    function drain() {
        while (!disposed && active < 6 && queue.length) {
            const job = queue.shift(); active++;
            job.run().finally(() => { active--; drain(); });
        }
    }
    function trim() {
        while (bytes > budget && cache.size > 1) {
            const [name, entry] = cache.entries().next().value;
            cache.delete(name); bytes -= entry.bytes; entry.image.close();
        }
        stats.bitmapBytes = bytes;
        stats.peakBitmapBytes = Math.max(stats.peakBitmapBytes, bytes);
    }
    function image(filename) {
        const existing = cache.get(filename);
        if (existing) {
            cache.delete(filename); cache.set(filename, existing); stats.cacheHits++;
            return Promise.resolve(existing.image);
        }
        if (pending.has(filename)) return pending.get(filename);
        const promise = new Promise((resolve, reject) => {
            queue.push({reject, run: async () => {
                try {
                    stats.requests++;
                    const response = await fetch(new URL(filename, base), {cache: 'force-cache', signal: controller.signal});
                    if (!response.ok) throw new Error('HD texture unavailable (' + response.status + ').');
                    const bitmap = await createImageBitmap(await response.blob(),
                        {premultiplyAlpha: 'none', colorSpaceConversion: 'none'});
                    if (disposed) { bitmap.close(); throw new Error('Game stopped.'); }
                    const entry = {image: bitmap, bytes: bitmap.width * bitmap.height * 4};
                    cache.set(filename, entry); bytes += entry.bytes; trim();
                    resolve(bitmap);
                } catch (error) {
                    if (!disposed) stats.failed++;
                    reject(error);
                } finally { pending.delete(filename); }
            }});
            drain();
        });
        pending.set(filename, promise);
        return promise;
    }
    function upload(context, texture, token, bitmap, entry) {
        if (disposed || bindings.get(texture) !== token || context.isContextLost() || !context.isTexture(texture)) return;
        const previous = context.getParameter(context.TEXTURE_BINDING_2D);
        context.bindTexture(context.TEXTURE_2D, texture);
        context.texImage2D(context.TEXTURE_2D, 0, context.RGBA, context.RGBA, context.UNSIGNED_BYTE, bitmap);
        context.bindTexture(context.TEXTURE_2D, previous);
        stats.applied++;
        const group = entry[2].split('/')[1];
        stats.groups[group] = (stats.groups[group] || 0) + 1;
        if (stats.firstApplied.length < 12) stats.firstApplied.push(entry[1]);
    }
    function replace(context, width, height, crc, adler) {
        if (disposed) return;
        const texture = context.getParameter(context.TEXTURE_BINDING_2D);
        if (!texture) return;
        const key = width + 'x' + height + ':' + (crc >>> 0).toString(16).padStart(8, '0') +
            ':' + (adler >>> 0).toString(16).padStart(8, '0');
        const token = {serial: ++serial, key};
        bindings.set(texture, token);
        const entry = manifest.textures[key];
        if (!entry) return;
        stats.matched++;
        const cached = cache.get(entry[0]);
        if (cached) {
            cache.delete(entry[0]); cache.set(entry[0], cached); stats.cacheHits++;
            upload(context, texture, token, cached.image, entry);
        } else {
            image(entry[0]).then(bitmap => upload(context, texture, token, bitmap, entry)).catch(error => {
                if (!disposed) console.warn('MK64 HD:', error.message);
            });
        }
    }
    function dispose() {
        if (disposed) return;
        disposed = true; controller.abort();
        for (const job of queue.splice(0)) job.reject(new Error('Game stopped.'));
        pending.clear();
        for (const entry of cache.values()) entry.image.close();
        cache.clear(); bytes = 0; stats.bitmapBytes = 0;
    }
    const preload = Array.from(new Set(Object.values(manifest.textures)
        .filter(entry => /startup_logo|texture_tkmk00|common_texture_(portrait|item_window|hud)/.test(entry[2]))
        .slice(0, 96).map(entry => entry[0])));
    Module.mk64HD = {replace, dispose, stats, ready: null};
    const hook = () => {
        addRunDependency('mk64-hd-bootstrap');
        Module.mk64HD.ready = Promise.all(preload.map(image)).finally(() => removeRunDependency('mk64-hd-bootstrap'));
        // Asset failures remain visible and original texels are a safe temporary
        // fallback. Successful replacements never modify the game's RAM.
        Module.mk64HD.ready.catch(error => console.warn('MK64 HD bootstrap:', error.message));
    };
    Module.preRun = Array.isArray(Module.preRun) ? Module.preRun : Module.preRun ? [Module.preRun] : [];
    Module.preRun.push(hook);
})();
