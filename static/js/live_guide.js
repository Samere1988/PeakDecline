(() => {
    const panel = document.getElementById('live-guide');
    let selected = null, sequence = 0, pending = false, refreshed = 0;
    const format = seconds => new Date(seconds * 1000).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'});
    async function update() {
        const id = currentChannelId;
        if (id !== selected) { selected = id; sequence++; pending = false; refreshed = 0; panel.textContent = id ? 'Loading programme listings…' : 'Select a channel for programme listings'; }
        if (!id || pending || Date.now() - refreshed < 60000) return;
        const token = sequence;
        pending = true;
        try {
            const response = await fetch(`/api/channels/${id}/guide`);
            if (!response.ok) throw new Error('Guide unavailable');
            const data = await response.json();
            if (token !== sequence || id !== currentChannelId) return;
            panel.replaceChildren();
            for (const key of ['now', 'next']) {
                const programme = data[key];
                const line = document.createElement('div');
                line.textContent = programme ? `${key === 'now' ? 'Now' : 'Next'}: ${programme.title} · ${format(programme.start)}–${format(programme.stop)}` : (key === 'now' ? 'Schedule unavailable' : '');
                line.title = line.textContent;
                panel.appendChild(line);
            }
            if (data.now) {
                const progress = document.createElement('progress');
                progress.max = data.now.stop - data.now.start;
                progress.value = Math.max(0, Math.min(progress.max, Date.now() / 1000 - data.now.start));
                progress.setAttribute('aria-label', 'Programme progress');
                panel.appendChild(progress);
            }
            panel.title = 'Programme listings: EPG.PW • Times shown in your local timezone';
        } catch (_) { if (token === sequence) panel.textContent = 'Schedule unavailable'; }
        finally { if (token === sequence) { pending = false; refreshed = Date.now(); } }
    }
    setInterval(update, 1000);
    update();
})();
