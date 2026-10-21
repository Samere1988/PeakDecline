const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {chromium} = require(process.env.WATCH_PLAYWRIGHT || 'C:/Users/Plex/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root = path.join(__dirname, '../..');
const template = fs.readFileSync(path.join(root, 'templates/live_tv.html'), 'utf8');
const content = template.split('{% block content %}')[1].split('{% endblock %}')[0].replace(/\{\{[\s\S]*?\}\}/g, '');
const css = ['style.css', 'live_tv.css', 'player_controls.css'].map(file => fs.readFileSync(path.join(root, 'static/css', file), 'utf8')).join('\n');
const messages = ['Switching to International Sports Championship Channel…', 'Loading Sports…',
    'Now playing International Sports Championship Channel', 'Buffering… Waiting for more video.',
    'Taking longer than expected. Still trying — check your connection or try another channel.',
    'Unable to switch to Sports. Try again or choose another channel.', 'Press Play to join live',
    'Playing — live sync temporarily unavailable', 'Select a channel to start',
    'No active stream. Select a channel to start.', 'Playback interrupted. Press Play to reconnect.',
    'Playback interrupted. Reconnecting…', 'LIVE', 'Catching up to live…', 'Joining live…',
    'Paused. Press Play to return to live.', 'Unable to load this channel. Try another channel or refresh to retry.',
    'Playing muted — use the speaker button for sound', 'Unable to check live TV. Refresh to try again.',
    'Stream ended. Select a channel or refresh to retry.'];
(async () => {
    const browser = await chromium.launch({headless:true, executablePath:process.env.WATCH_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
    try {
        const page = await browser.newPage();
        await page.setContent(`<style>${css}</style><div class="main-wrapper">${content}</div>`);
        const failures = [];
        for (const [width, height] of [[1920,1080],[1366,768],[1024,768],[768,1024],[390,844],[360,640],[320,568],[844,390]]) {
            await page.setViewportSize({width,height});
            for (const message of messages) {
                await page.locator('#current-status-text').evaluate((el, text) => el.textContent = text, message);
                await page.locator('#current-channel-name').evaluate(el => el.textContent = 'International Sports Championship Channel');
                await page.locator('#current-status-text').scrollIntoViewIfNeeded();
                const size = await page.locator('.now-playing-bar').evaluate(el => ({width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height}));
                assert.ok(size.height < 200, `Status bar remains compact at ${width}px`);
                const result = await page.locator('#current-status-text').evaluate(el => {
                    const r = el.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(el);
                    const lines = [...range.getClientRects()];
                    let clipped = r.left < -1 || r.right > innerWidth + 1 || r.top < -1 || r.bottom > innerHeight + 1;
                    for (let p = el.parentElement; p; p = p.parentElement) {
                        const style = getComputedStyle(p), b = p.getBoundingClientRect();
                        if (/(hidden|clip)/.test(style.overflowX) && (r.left < b.left - 1 || r.right > b.right + 1)) clipped = true;
                        if (/(hidden|clip)/.test(style.overflowY) && (r.top < b.top - 1 || r.bottom > b.bottom + 1)) clipped = true;
                    }
                    return {clipped, contained:lines.every(l => l.left >= r.left - 1 && l.right <= r.right + 1 && l.bottom <= r.bottom + 1)};
                });
                if (result.clipped || !result.contained) failures.push({width,height,message,...result});
            }
        }
        assert.deepEqual(failures, [], 'Status text must be fully visible at every viewport');
        for (const width of [320,390,768,1366]) {
            await page.setViewportSize({width,height:844});
            const visible = await page.locator('.plex-controls-row').evaluate(row => {
                const shell = document.getElementById('live-player-shell').getBoundingClientRect();
                return [...row.children].every(el => {const r=el.getBoundingClientRect();return r.left>=shell.left && r.right<=shell.right && r.top>=shell.top && r.bottom<=shell.bottom;});
            });
            assert.equal(visible,true,`Controls fit at ${width}px`);
            const cog = await page.locator('#live-quality-cog').boundingBox();
            const sync = await page.locator('#live-go-live').boundingBox();
            assert.ok(cog.x + cog.width <= sync.x && Math.abs(cog.y + cog.height / 2 - sync.y - sync.height / 2) < 1, `Cog sits left of Sync at ${width}px`);
        }
        assert.equal(await page.locator('#live-go-live').textContent(),'Sync');
        await page.setViewportSize({width:1892,height:909});
        await page.locator('#current-status-text').evaluate(el => el.textContent = 'Playing � live sync temporarily unavailable');
        await page.locator('#current-channel-name').evaluate(el => el.textContent = 'HEVC HD Comedy Central');
        await page.evaluate(() => scrollTo(0,0));
        const playerSize = await page.locator('#live-player-shell').boundingBox();
        const statusSize = await page.locator('.now-playing-bar').boundingBox();
        assert.ok(statusSize.height < 100 && playerSize.height > 600, 'Desktop favors the video over the status bar');
        await page.screenshot({path:path.join(root,'.tmp/live-compact.png')});
        await page.setViewportSize({width:1366,height:844});
        assert.equal(await page.locator('#video-player').getAttribute('controls'),null);
        assert.equal(await page.locator('input[type=range]').count(),1,'Only volume has a slider');
        const room = await browser.newPage({viewport:{width:1366,height:844}});
        try {
            const roomTemplate=fs.readFileSync(path.join(root,'templates/room.html'),'utf8');
            assert.ok(roomTemplate.includes("filename='css/player_controls.css'"));
            const controls=roomTemplate.match(/<button id="plex-play-toggle"[\s\S]*?<\/button>/)[0];
            await room.setContent(`<style>${fs.readFileSync(path.join(root,'static/css/room.css'),'utf8')}\n${fs.readFileSync(path.join(root,'static/css/player_controls.css'),'utf8')}</style>${controls}`);
            const appearance=el=>{const s=getComputedStyle(el);return [s.width,s.height,s.borderRadius,s.backgroundColor,s.color,s.fontSize];};
            assert.deepEqual(await room.locator('#plex-play-toggle').evaluate(appearance),await page.locator('#live-play-toggle').evaluate(appearance),'Watch Together and Live TV share button appearance');
        } finally { await room.close(); }
        await page.evaluate(() => { window.io = () => ({on(){},emit(){}}); window.fetch = () => new Promise(() => {}); });
        await page.addScriptTag({content:fs.readFileSync(path.join(root, 'static/js/tv_player.js'), 'utf8')});
        await page.addScriptTag({content:fs.readFileSync(path.join(root, 'static/js/live_controls.js'), 'utf8')});
        await page.addScriptTag({content:fs.readFileSync(path.join(root, 'static/js/live_quality.js'), 'utf8')});
        assert.equal(await page.locator('#live-quality-select option').count(),4);
        assert.equal(await page.locator('#live-quality-select').inputValue(),'native');
        assert.equal(await page.locator('#live-quality-cog').textContent(),'⚙');
        await page.evaluate(() => { hls={levels:[{height:1080},{height:720},{height:480}],currentLevel:-1,nextLevel:-1}; window.dispatchEvent(new CustomEvent('live-quality-levels', {detail:{supported:true,levels:hls.levels}})); });
        await page.locator('#live-quality-cog').click();
        assert.equal(await page.locator('#live-quality-panel').evaluate(el => getComputedStyle(el).display),'flex');
        await page.locator('#live-quality-select').selectOption('720');
        assert.equal(await page.evaluate(() => hls.currentLevel),1);
        await page.evaluate(async () => {
            const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90;
            const ctx = canvas.getContext('2d');
            window.paintTimer = setInterval(() => {ctx.fillStyle = `hsl(${Date.now()%360} 100% 50%)`;ctx.fillRect(0,0,160,90);}, 40);
            currentChannelId = 1; video.muted = true; video.srcObject = canvas.captureStream(25);
            showPlayerStatus('loading', 'Loading Sports…'); await video.play();
        });
        await page.waitForFunction(() => video.currentTime > 0.2 && playerPhase === 'playing');
        await page.evaluate(() => {successUntil=0; clockSample=null; enforceLiveSync();});
        assert.equal(await page.locator('#current-status-text').textContent(), 'Playing — live sync temporarily unavailable');
        const before = await page.evaluate(() => video.currentTime);
        await page.waitForFunction(t => video.currentTime > t + 0.3, before);
        await page.evaluate(() => {
            clockSample={fresh:true,received:performance.now(),rtt:0,max_extrapolation:3,
                target_pdt:1000+video.currentTime,edge_pdt:1010+video.currentTime,session:'test'};
            hls={latestLevelDetails:{fragments:[{programDateTime:1000000,start:0,relurl:'test_001.ts'}]}};
            enforceLiveSync();
        });
        assert.equal(await page.locator('#current-status-text').textContent(), 'LIVE');
        await page.locator('#live-play-toggle').click();
        assert.equal(await page.evaluate(()=>video.paused),true);
        await page.locator('#live-go-live').click();
        await page.waitForFunction(()=>!video.paused);
        const previousMuted = await page.evaluate(()=>video.muted);
        await page.locator('#live-mute-toggle').click();
        assert.equal(await page.evaluate(()=>video.muted),!previousMuted);
        await page.locator('#live-volume').fill('0.4');
        assert.equal(await page.evaluate(()=>video.volume),0.4);
        await page.locator('#live-fullscreen-toggle').click();
        await page.waitForFunction(()=>document.fullscreenElement?.id==='live-player-shell');
        await page.locator('#live-fullscreen-toggle').click();
        await page.waitForFunction(()=>!document.fullscreenElement);
        await page.evaluate(() => {video.pause(); clearInterval(window.paintTimer);video.srcObject.getTracks().forEach(t=>t.stop());});
        await page.waitForFunction(()=>playerPhase==='paused');
        assert.match(await page.locator('#current-status-text').textContent(), /Paused/);
        console.log(`PASS ${messages.length * 8} responsive text checks, shared Watch Together appearance, control layout, play/pause, Go Live, volume, fullscreen, clock loss and recovery`);
    } finally { await browser.close(); }
})().catch(error => {console.error(error);process.exitCode=1;});
