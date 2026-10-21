/* Shared fullscreen controls for canvas and same-origin iframe games. */
(() => {
    'use strict';
    window.GameFullscreen = {create({area, button, status, focusGame}) {
        let timer;
        function reveal() {
            clearTimeout(timer);
            button.classList.remove('game-control-idle');
            timer = setTimeout(() => button.classList.add('game-control-idle'), 2000);
        }
        function bindSurface(surface, signal) {
            for (const event of ['pointermove', 'pointerdown', 'pointerenter'])
                surface.addEventListener(event, reveal, {passive: true, ...(signal ? {signal} : {})});
        }
        bindSurface(area);
        button.addEventListener('focus', reveal);
        button.addEventListener('blur', reveal);
        button.addEventListener('click', async event => {
            try {
                if (document.fullscreenElement === area) await document.exitFullscreen();
                else await area.requestFullscreen();
                // Mouse/touch clicks should not pin the control via keyboard focus.
                if (event.detail) focusGame?.();
            } catch {
                status.textContent = 'Fullscreen is unavailable in this browser.';
            }
            reveal();
        });
        document.addEventListener('fullscreenchange', () => {
            const active = document.fullscreenElement === area;
            button.textContent = active ? '⛶ Exit fullscreen' : '⛶ Fullscreen';
            button.setAttribute('aria-label', active ? 'Exit fullscreen' : 'Enter fullscreen');
            button.title = button.getAttribute('aria-label');
            reveal();
        });
        // Games start hidden; reveal on launch as well as initial page load.
        const observer = new MutationObserver(reveal);
        const section = area.closest('.mk64-play-area');
        if (section) observer.observe(section, {attributes:true, attributeFilter:['hidden']});
        reveal();
        return {bindSurface};
    }};
})();
