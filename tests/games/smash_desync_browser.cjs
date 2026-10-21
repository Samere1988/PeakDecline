/* Real WASM, two accounts and a media spectator. Inject one bad transmitted
 * checksum, then prove everyone can start another match in the same room.
 * Run retro_test.py --serve --smash --port 8068 first. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {chromium,firefox} = require(process.env.PLAYWRIGHT_MODULE || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const base = process.env.SMASH_URL || 'http://127.0.0.1:8068';
assert.equal(new URL(base).hostname, '127.0.0.1');
const output = path.resolve(process.env.SMASH_DESYNC_OUTPUT || '.tmp/smash-desync-handling');
const failureMode=process.env.SMASH_FAILURE_MODE || 'desync';
assert.ok(['desync','runtime_failure'].includes(failureMode));
fs.mkdirSync(output, {recursive:true});
(async () => {
    const browser = await chromium.launch({headless:true,
        executablePath:process.env.BROWSER_EXECUTABLE || path.join(os.homedir(), '.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'),
        args:['--enable-unsafe-swiftshader','--autoplay-policy=no-user-gesture-required']});
    const errors = [], pages = [], browsers = [browser];
    try {
        const guestBrowser = process.env.SMASH_MIXED_BROWSERS ? await firefox.launch({headless:true,
            executablePath:process.env.FIREFOX_EXECUTABLE || undefined,
            firefoxUserPrefs:{'webgl.force-enabled':true,'gfx.webrender.software':true}}) : browser;
        if (guestBrowser!==browser) browsers.push(guestBrowser);
        for (let seat=0; seat<3; ++seat) {
            const page = await (await (seat===1?guestBrowser:browser).newContext({viewport:{width:seat===1?390:1280,height:900}})).newPage();
            pages.push(page);
            page.on('pageerror', error => errors.push(error.message));
            // Only the isolated fixture skips menus; use the real hybrid runtime.
            await page.route('**/games/retro/runtime/smash64', async route => {
                const response = await route.fetch();
                let body = await response.text();
                assert.ok(body.includes("ENV.SSB64_START_SCENE = '27'"));
                body = body.replace("ENV.SSB64_START_SCENE = '27'", "ENV.SSB64_START_SCENE = '22'")
                    .replace(/ENV.SSB64_BOOT_BATTLE = [^;]+;/, "ENV.SSB64_BOOT_BATTLE = '8,6,4,0,1,-1';")
                    .replace(/ENV.SSB64_BOOT_SLOTS = [^;]+;/, "ENV.SSB64_BOOT_SLOTS = 'hhco';");
                await route.fulfill({response,body});
            });
            await page.goto(base+'/test-login/desync-'+seat, {timeout:90000});
            await page.waitForFunction(() => window.PeakNet?.adapters.has('smash64'));
            await page.evaluate(({seat,failureMode}) => {
                const host = PeakNet.adapters.get('smash64'), launch = host.launch;
                host.launch = options => {
                    const s = options.session, bind = s.bind.bind(s);
                    window.testSessions ??= [];
                    testSessions.push(s);
                    s.bind = adapter => {
                        adapter.sampleInput = () => {
                            if(failureMode==='runtime_failure' && seat===1 && s.epoch===0 && s.frame>=360)
                                throw Error('Injected runtime failure');
                            return {buttons:0,x:0,y:0};
                        };
                        if (seat===1 && s.epoch===0) {
                            const destroy = adapter.destroy;
                            adapter.destroy = () => { destroy(); throw Error('Injected destructor failure'); };
                        }
                        bind(adapter);
                    };
                    if (!window.injectedEmit) {
                        window.injectedEmit = true;
                        const emit = s.socket.emit.bind(s.socket);
                        s.socket.emit = (name,data,...args) => {
                            if (name==='hash' && data.epoch===1 && data.frame===480) window.healthyChecksum = data.hash;
                            if (failureMode==='desync' && seat===1 && name==='hash' && data.epoch===0 && data.frame===360) {
                                data = {...data,hash:(data.hash^1)>>>0};
                                window.badChecksumSent = data;
                            }
                            return emit(name,data,...args);
                        };
                    }
                    return launch(options);
                };
            },{seat,failureMode});
        }
        const [host,guest,watcher] = pages;
        await host.locator('#retro-open-create').click();
        await host.locator('#retro-game-select').selectOption('smash64');
        await host.locator('#retro-room-name').fill('Desync recovery check');
        await host.locator('#retro-room-create').click();
        await host.locator('#retro-lobby').waitFor();
        const invite = await host.locator('#retro-invite').inputValue();
        for (const page of [guest,watcher]) await page.getByRole('button',{name:'Join room',exact:true}).click();
        await guest.locator('#retro-choose-player').click();
        await watcher.locator('#retro-choose-spectator').click();
        for (const page of [host,guest]) await page.locator('#retro-ready').click();
        await host.locator('#retro-start-race').click();
        await host.waitForFunction(() => window.retroNetplay?.frame>60, {}, {timeout:120000});
        await host.locator('#smash64-play-area [data-game-fullscreen]').focus();
        await host.locator('#smash64-play-area [data-game-fullscreen]').click();
        await host.waitForFunction(() => !!document.fullscreenElement);
        for (const page of pages) {
            await page.locator('#retro-interruption').waitFor({timeout:60000});
            await page.locator('#retro-lobby').waitFor();
            await page.waitForFunction(() => !window.retroNetplay && !document.querySelector('#smash64-play-area iframe'));
            assert.equal(await page.locator('#retro-invite').inputValue(),invite);
            assert.equal(await page.evaluate(() => document.fullscreenElement===null),true);
            assert.equal(await page.locator('#retro-close-game').isHidden(),true);
            assert.equal(await page.locator('#retro-return').isHidden(),true);
            assert.match(await page.locator('#retro-interruption-message').textContent(),/Mark ready/);
            // Emulate delivery of an already queued stop from the discarded epoch.
            if (page!==watcher) await page.evaluate(() => testSessions[0].socket.emitEvent(['stopped',{epoch:0,message:'stale stop'}]));
            assert.equal(await page.locator('#retro-return').isHidden(),true);
            const downloadPromise = page.waitForEvent('download');
            await page.locator('#retro-download-report').click();
            const download = await downloadPromise;
            const seat = pages.indexOf(page), file = path.join(output,'seat-'+seat+'.json');
            await download.saveAs(file);
            const report = JSON.parse(fs.readFileSync(file,'utf8'));
            assert.equal(report.reason,failureMode);
            assert.equal(report.epoch,0);
            if(failureMode==='desync')assert.equal(report.frame,360);
            else assert.ok(report.frame>=354 && report.frame<=380);
            assert.equal(report.game.id,'smash64');
            if(failureMode==='desync'){
                assert.equal(report.checksums.length,2);
                assert.equal(new Set(report.checksums.map(p=>p.hash)).size,2);
            }
            assert.equal(report.spectator,seat===2);
            assert.equal(JSON.stringify(report).includes('Desync recovery check'),false);
            assert.equal(JSON.stringify(report).includes('desync-'+seat),false);
            if (seat===1 && failureMode==='desync') assert.equal(report.cleanupError,'Injected destructor failure');
            if (seat<2) {
                if(failureMode==='desync' || seat===0)assert.ok(report.diagnostics.frame>=354);
                assert.equal(await page.evaluate(() => testSessions[0].engine.disposed),true);
                assert.equal(await page.locator('#retro-ready').getAttribute('aria-pressed'),'false');
            }
            assert.equal(await page.locator(seat===2?'#retro-choose-spectator':'#retro-choose-player').getAttribute('aria-pressed'),'true');
        }
        assert.equal(await guest.evaluate(() => document.documentElement.scrollWidth<=innerWidth+1),true);
        await host.screenshot({path:path.join(output,'lobby-desktop.png'),fullPage:true});
        await guest.screenshot({path:path.join(output,'lobby-mobile.png'),fullPage:true});
        // Same accounts, same invite, no navigation/reload: start a healthy epoch.
        for (const page of [host,guest]) await page.locator('#retro-ready').click();
        await host.locator('#retro-start-race').click();
        for (const page of [host,guest]) {
            await page.waitForFunction(() => window.retroNetplay?.epoch===1 && retroNetplay.frame>480 && !retroNetplay.failed && Number.isInteger(window.healthyChecksum), {}, {timeout:120000});
            assert.equal(await page.locator('#retro-interruption').isHidden(),true);
            await page.evaluate(() => retroNetplay.socket.emitEvent(['stopped',{epoch:0,message:'late stop during new match'}]));
            assert.equal(await page.evaluate(() => retroNetplay.running && !retroNetplay.failed),true);
        }
        const healthy = await Promise.all([host,guest].map(page=>page.evaluate(()=>window.healthyChecksum)));
        assert.ok(Number.isInteger(healthy[0]));
        assert.equal(healthy[0],healthy[1],'Fresh match must also agree at a common checkpoint');
        await host.locator('#retro-close-game').click();
        for (const page of pages) await page.locator('#retro-lobby').waitFor();
        assert.deepEqual(errors,[]);
        fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,
            browsers:browsers.map(b=>({engine:b.browserType().name(),version:b.version()})),
            failureMode,mismatchFrame:failureMode==='desync'?360:null,nextEpoch:1,nextMatchFrames:480,healthyChecksum:healthy[0],destructorFailureContained:true,
            staleStopIgnored:true,preservedPlayers:2,preservedSpectators:1},null,2)+'\n');
        console.log('PASS: real Smash mismatch, diagnostic download, fullscreen exit, destructor failure, stale stop, preserved roster and fresh match.');
    } finally { await Promise.all(browsers.map(b=>b.close())); }
})().catch(error => {console.error(error);process.exitCode=1;});
