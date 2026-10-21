/* Real installed engines and disposable accounts: initial spectator, leave, two live rejoins. */
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const {chromium, firefox} = require(process.env.PLAYWRIGHT_PATH || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const base = process.env.LOBBY_TEST_URL || 'http://127.0.0.1:8079';
assert.equal(new URL(base).hostname, '127.0.0.1');
const output = process.env.SPECTATOR_RESULTS || '.tmp/all-spectator-rejoin';
fs.mkdirSync(output, {recursive: true});
const report = [];
(async () => {
    const useFirefox = process.env.SPECTATOR_BROWSER === 'firefox';
    const browser = useFirefox ? await firefox.launch({headless:true,
        executablePath: process.env.BROWSER_PATH || path.join(os.homedir(), '.cache/ms-playwright/firefox-1543/firefox/firefox'),
        firefoxUserPrefs: {'dom.webgpu.enabled':true, 'media.autoplay.default':0}}) : await chromium.launch({headless: true,
        executablePath: process.env.BROWSER_PATH || path.join(os.homedir(), '.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'),
        args: ['--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required']});
    let hardwareBrowser;
    try {
        const catalogPage = await browser.newPage();
        await catalogPage.goto(base + '/test-login/catalog-rejoin');
        const catalog = await catalogPage.evaluate(() => JSON.parse(document.getElementById('retro-catalog').textContent));
        await catalogPage.close();
        const selected = process.env.SPECTATOR_GAMES?.split(',');
        for (const game of catalog.filter(game => !selected || selected.includes(game.id))) {
            const result = {id: game.id, title: game.title, backend: game.backend, cycles: []};
            const contexts = [], pages = [], errors = [];
            if (!game.available) { result.status = 'unavailable'; report.push(result); continue; }
            console.log('START', game.id);
            try {
                // Chromium headless selects software WebGPU on this Linux host;
                // CMR2 requires the hardware renderer provided by Firefox.
                if (game.id === 'cmr2' && !useFirefox && !hardwareBrowser)
                    hardwareBrowser = await firefox.launch({headless:true,
                        executablePath:process.env.FIREFOX_PATH || path.join(os.homedir(), '.cache/ms-playwright/firefox-1543/firefox/firefox'),
                        firefoxUserPrefs:{'dom.webgpu.enabled':true,'media.autoplay.default':0}});
                const gameBrowser = game.id === 'cmr2' && !useFirefox ? hardwareBrowser : browser;
                for (let i = 0; i < 2; i++) {
                    const context = await gameBrowser.newContext({viewport: {width:1280, height:900}});
                    contexts.push(context);
                    await context.addInitScript(() => {
                        window.spectatorFrames = [];
                        const requestFrame = HTMLVideoElement.prototype.requestVideoFrameCallback;
                        if (requestFrame) HTMLVideoElement.prototype.requestVideoFrameCallback = function(callback) {
                            return requestFrame.call(this, (now, meta) => {
                                if (window === top && this.id === 'retro-spectator-video') {
                                    const sample = document.createElement('canvas'); sample.width=64; sample.height=48;
                                    const ctx=sample.getContext('2d'); ctx.drawImage(this,0,0,64,48);
                                    const pixels=ctx.getImageData(0,0,64,48).data;
                                    let lit=0,hash=2166136261;
                                    for(let at=0;at<pixels.length;at+=4){
                                        if(Math.max(pixels[at],pixels[at+1],pixels[at+2])>8)lit++;
                                        hash=Math.imul(hash^(pixels[at]|pixels[at+1]<<8|pixels[at+2]<<16),16777619)>>>0;
                                    }
                                    spectatorFrames.push({lit,hash,at:performance.now(),rtc:true,width:meta.width,height:meta.height});
                                }
                                callback(now,meta);
                            });
                        };
                        const drawImage = CanvasRenderingContext2D.prototype.drawImage;
                        CanvasRenderingContext2D.prototype.drawImage = function(...args) {
                            const value = drawImage.apply(this, args);
                            // Only observe decoded spectator pictures in the main page; do not alter capture.
                            if (window === top && args[0] instanceof ImageBitmap && this.canvas.isConnected) {
                                const pixels = this.getImageData(0, 0, this.canvas.width, this.canvas.height).data;
                                let lit = 0, hash = 2166136261;
                                for (let at = 0; at < pixels.length; at += 64) {
                                    if (pixels[at+3] && Math.max(pixels[at],pixels[at+1],pixels[at+2]) > 8) lit++;
                                    hash = Math.imul(hash ^ (pixels[at] | pixels[at+1] << 8 | pixels[at+2] << 16), 16777619) >>> 0;
                                }
                                spectatorFrames.push({lit, hash, at:performance.now()});
                            }
                            return value;
                        };
                    });
                    const page = await context.newPage(); page.setDefaultTimeout(30000);
                    page.on('pageerror', e => errors.push(e.message));
                    await page.goto(base + '/test-login/' + game.id + '-rejoin-' + Date.now() + '-' + i);
                    pages.push(page);
                }
                const [host, watcher] = pages;
                const roomName = game.id + ' continuity ' + Date.now();
                await host.locator('#retro-open-create').click();
                await host.locator('#retro-game-select').selectOption(game.id);
                await host.locator('#retro-room-name').fill(roomName);
                await host.locator('#retro-room-create').click();
                await host.locator('#retro-lobby').waitFor();
                const invite = await host.locator('#retro-invite').inputValue();
                await watcher.goto(invite); await watcher.locator('#retro-lobby').waitFor();
                await host.locator('#retro-ready').click(); await host.locator('#retro-start-race').click();
                for (const page of pages) {
                    await page.waitForFunction(() => window.retroNetplay?.running || window.retroNetplay?.failed, null, {timeout:240000});
                    assert.equal(await page.evaluate(() => retroNetplay.failed), false, await page.locator('#retro-runtime-status').textContent());
                }
                const runtime = host.frames().find(frame => frame.url().includes('/runtime/')) || host.mainFrame();
                const surface = runtime.locator(game.id === 'mk64' ? '#mk64-canvas' : 'canvas').first();
                if (game.id === 'devilutionx') {
                    // Native game ticks start only after choosing/creating a hero.
                    await surface.click({position:{x:10,y:10}}); await host.waitForTimeout(1500);
                    for (const key of ['Escape','Enter','Enter']) {
                        await host.keyboard.press(key); await host.waitForTimeout(1500);
                    }
                    await host.keyboard.type('Host', {delay:100}); await host.keyboard.press('Enter');
                    await runtime.waitForFunction(() => Module._peakDiabloState() === 3, null, {timeout:30000});
                }
                await host.waitForFunction(() => window.retroNetplay?.frame > 180 || window.retroNetplay?.failed, null, {timeout:120000});
                assert.equal(await host.evaluate(() => retroNetplay.failed), false);
                // Enter a stable menu where possible; no synthetic pixels or runtime replacements.
                if (game.id === 'mk64') { await surface.focus(); await host.keyboard.press('Enter', {delay:150}); }
                if (game.id === 'sm64') {
                    await surface.focus(); await host.keyboard.press('Enter', {delay:150}); await host.waitForTimeout(2500);
                }
                if (game.id === 'driver2') {
                    await surface.click({position:{x:20,y:20}});
                    for (const key of ['Enter','x','x','Enter','Enter']) {
                        await host.keyboard.press(key, {delay:150}); await host.waitForTimeout(1800);
                    }
                }
                if (game.id === 'marioparty' || game.id === 'marioparty2') {
                    const presses = game.id === 'marioparty' ? [900,1090] : [1000,1330,1636];
                    for (const frame of presses) {
                        await host.waitForFunction(frame => retroNetplay.frame >= frame, frame, {timeout:90000});
                        await surface.focus(); await host.keyboard.down('Enter');
                        const held = await host.evaluate(() => retroNetplay.frame);
                        await host.waitForFunction(frame => retroNetplay.frame >= frame+10,held);
                        await host.keyboard.up('Enter');
                    }
                    await host.waitForFunction(frame => retroNetplay.frame >= frame, presses.at(-1)+360, {timeout:90000});
                }
                if (game.id === 'fzerox') {
                    await host.waitForFunction(() => retroNetplay.frame >= 600, null, {timeout:90000});
                    await surface.focus(); await host.keyboard.down('Enter');
                    const held = await host.evaluate(() => retroNetplay.frame);
                    await host.waitForFunction(frame => retroNetplay.frame >= frame + 10, held);
                    await host.keyboard.up('Enter');
                    await runtime.waitForFunction(() => (window.fzeroState?.mode & 31) === 7);
                }
                if (game.id === 'cmr2') {
                    // Skip the real startup movies, whose fades intentionally
                    // contain black frames, and sample a populated game menu.
                    let lastMovie;
                    for (let i=0;i<90;i++) {
                        const state=await runtime.evaluate(()=>({menu:Module.cmr2State?.menu,movie:Module.cmr2Movie}));
                        if (state.menu===0 || state.menu===1) break;
                        if(state.menu===-1 && state.movie && state.movie.count!==lastMovie){
                            lastMovie=state.movie.count;await runtime.evaluate(()=>Module.cmr2SkipMovie=true);
                        }
                        await host.waitForTimeout(500);
                    }
                    await runtime.waitForFunction(()=>[0,1].includes(Module.cmr2State?.menu));
                }
                if (game.id === 'oot') {
                    for (let i=0;i<10 && !(await runtime.evaluate(() => Module._peak_oot_mode() === 2));i++) {
                        await surface.focus(); await host.keyboard.press('Enter',{delay:150}); await host.waitForTimeout(1000);
                    }
                }
                await host.waitForTimeout(2000);
                result.context = await surface.evaluate(canvas => {
                    for (const kind of ['webgl2','webgl','2d','webgpu']) {
                        const context = canvas.getContext(kind); if (context) return {kind, width:canvas.width,height:canvas.height,attributes:context.getContextAttributes?.(),renderer:context.getParameter?.(context.getExtension?.('WEBGL_debug_renderer_info')?.UNMASKED_RENDERER_WEBGL || context.RENDERER)};
                    }
                    return {kind:'unknown'};
                });
                await surface.screenshot({path:path.join(output, game.id + '-host.png')});
                console.log('BOOTED', game.id, result.context.kind);
                for (let cycle = 0; cycle < 2; cycle++) {
                    await watcher.locator('#retro-return').click(); await watcher.locator('#retro-room-browser').waitFor();
                    assert.equal(await watcher.evaluate(code => sessionStorage.getItem('retro-resume:' + code), new URL(invite).searchParams.get('room')), null, 'Intentional leave must discard the old membership token');
                    // Check the running room is discoverable, then rejoin using the public listing.
                    const room = watcher.locator('#retro-room-browser article').filter({hasText:roomName});
                    await room.getByRole('button',{name:'Spectate',exact:true}).click();
                    await watcher.waitForFunction(() => window.retroNetplay?.running || window.retroNetplay?.failed, null, {timeout:120000});
                    assert.equal(await watcher.evaluate(() => retroNetplay.failed), false);
                    assert.equal(await watcher.evaluate(() => retroNetplay.spectator), true);
                    if (game.backend === 'sync-input-v1') {
                        await watcher.waitForFunction(() => retroNetplay.live && !retroNetplay.replaying, null, {timeout:120000});
                        const start = await watcher.evaluate(() => retroNetplay.frame);
                        await watcher.waitForFunction(frame => retroNetplay.frame > frame+120, start, {timeout:30000});
                        const frame = watcher.frames().find(frame => frame.url().includes('/runtime/'));
                        await frame.locator('canvas').screenshot({path:path.join(output,game.id+'-rejoin-'+(cycle+1)+'.png')});
                        result.cycles.push({live:true, frames:await watcher.evaluate(() => retroNetplay.frame)-start});
                    } else {
                        await watcher.waitForFunction(() => retroNetplay.streaming, null, {timeout:30000});
                        await watcher.evaluate(() => { spectatorFrames.length = 0; });
                        await watcher.waitForFunction(() => spectatorFrames.filter(f=>f.rtc).length >= 120, null, {timeout:30000});
                        const stats = await watcher.evaluate(() => ({frames:spectatorFrames.length,
                            rtcFrames:spectatorFrames.filter(f=>f.rtc).length,
                            width:spectatorFrames.at(-1).width,height:spectatorFrames.at(-1).height,
                            fps:1000*(spectatorFrames.length-1)/(spectatorFrames.at(-1).at-spectatorFrames[0].at),
                            blank:spectatorFrames.filter(f=>!f.lit).length,
                            isolatedBlank:spectatorFrames.filter((f,i,a)=>!f.lit && a[i-1]?.lit && a[i+1]?.lit).length,
                            unique:new Set(spectatorFrames.map(f=>f.hash)).size,
                            maxGap:Math.max(...spectatorFrames.slice(1).map((f,i)=>f.at-spectatorFrames[i].at))}));
                        result.cycles.push(stats);
                        console.log('REJOIN',game.id,cycle+1,JSON.stringify(stats));
                        await watcher.screenshot({path:path.join(output,game.id+'-rejoin-'+(cycle+1)+'.png')});
                        assert.equal(stats.blank,0,'Spectator video contains blank frames in a populated scene');
                        assert.ok(stats.maxGap<2000,'Spectator video stalled');
                        assert.ok(stats.rtcFrames>=120,'The high-quality stream did not deliver video');
                        const rtc=await watcher.evaluate(async()=>{const result=[];for(const s of (await retroNetplay.receiver.peer.pc.getStats()).values())if(s.type==='inbound-rtp')result.push({kind:s.kind,framesPerSecond:s.framesPerSecond,frameWidth:s.frameWidth,frameHeight:s.frameHeight,bytesReceived:s.bytesReceived,packetsLost:s.packetsLost,totalAudioEnergy:s.totalAudioEnergy});return result;});
                        result.cycles.at(-1).rtc=rtc;
                        result.cycles.at(-1).sender=await host.evaluate(async()=>{
                            const publisher=retroNetplay.spectatorPublisher,peer=[...publisher.peers.values()][0];
                            return {track:publisher.capture?.getVideoTracks()[0].getSettings(),parameters:peer.video.getParameters(),
                                stats:[...(await peer.pc.getStats()).values()].filter(s=>s.type==='outbound-rtp'||s.type==='media-source').map(s=>({type:s.type,kind:s.kind,framesPerSecond:s.framesPerSecond,frameWidth:s.frameWidth,frameHeight:s.frameHeight,qualityLimitationReason:s.qualityLimitationReason,qualityLimitationDurations:s.qualityLimitationDurations}))};
                        });
                    }
                    assert.equal(await host.evaluate(() => retroNetplay.failed),false);
                }
                // The same people return together, retain roles, and can take an open seat.
                await host.locator('#retro-close-game').click();
                for (const page of pages) await page.locator('#retro-lobby').waitFor();
                assert.equal(await host.locator('#retro-invite').inputValue(),invite);
                assert.equal(await host.locator('#retro-choose-player').getAttribute('aria-pressed'),'true');
                assert.equal(await watcher.locator('#retro-choose-spectator').getAttribute('aria-pressed'),'true');
                await host.locator('#retro-choose-spectator').click();
                await watcher.locator('#retro-choose-player').click();
                await watcher.waitForFunction(()=>document.getElementById('retro-choose-player').getAttribute('aria-pressed')==='true');
                assert.deepEqual(errors,[]);
                result.status='passed';console.log('PASS',game.id);
            } catch(error) {
                result.status='failed';result.error=error.stack;result.pageErrors=errors;
                for(let i=0;i<pages.length;i++)try{result['page'+i]=await pages[i].locator('body').innerText();await pages[i].screenshot({path:path.join(output,game.id+'-failure-'+i+'.png')});}catch{}
                console.error('FAIL',game.id,error.message);
            } finally {
                for(const context of contexts)await context.close();
                report.push(result);fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(report,null,2));
            }
        }
    } finally { await hardwareBrowser?.close(); await browser.close(); }
    assert.ok(report.length,'No games selected');
    assert.equal(report.filter(r=>r.status!=='passed').length,0,'Some games did not pass; see results.json');
})().catch(error=>{console.error(error);process.exitCode=1;});
