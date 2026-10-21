const {chromium} = require('C:/Users/Plex/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert = require('node:assert/strict');
(async () => {
    const browser = await chromium.launch({headless:true, executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', args:['--enable-unsafe-swiftshader']});
    const errors = [];
    try {
        const pages = [];
        for (let i=0; i<3; i++) {
            const context = await browser.newContext({viewport:{width:i===2?390:1280,height:900}});
            const page = await context.newPage();
            page.on('pageerror', e => errors.push(e.message));
            await page.goto('http://127.0.0.1:8066/test-login/' + i);
            pages.push(page);
        }
        const [host, guest, watcher] = pages;
        await host.locator('#retro-open-create').click();
        await host.locator('#retro-room-name').fill('Friends race');
        await host.locator('#retro-room-create').click();
        await host.locator('#retro-lobby').waitFor();
        const invite = await host.locator('#retro-invite').inputValue();
        await guest.goto(invite);
        await guest.locator('#retro-lobby').waitFor();
        await watcher.getByRole('button',{name:'Join room',exact:true}).click();
        await watcher.locator('#retro-lobby').waitFor();
        assert.equal(await watcher.locator('#retro-choose-spectator').getAttribute('aria-pressed'),'true');
        assert.equal(await watcher.locator('#retro-start-race').isHidden(),true);
        await watcher.screenshot({path:'.tmp/retro/mobile-lobby.png',fullPage:true});
        assert.ok(await watcher.evaluate(() => document.documentElement.scrollWidth <= innerWidth+1));
        await guest.locator('#retro-choose-player').click();
        await host.locator('#retro-ready').click();
        await guest.locator('#retro-ready').click();
        await host.locator('#retro-start-race').click();
        await Promise.all(pages.map(page => page.waitForFunction(() => window.mk64?._web_frame() > 260, {}, {timeout:90000})));
        const hashes = await Promise.all(pages.map(page => page.evaluate(() => Array.from({length:100},(_,i)=>mk64._web_hash_for_frame(150+i)>>>0))));
        assert.deepEqual(hashes[0],hashes[1]); assert.deepEqual(hashes[0],hashes[2]);
        assert.equal(await watcher.evaluate(()=>retroNetplay.spectator),true);
        assert.equal(await watcher.evaluate(()=>retroNetplay.sentThrough),0);
        await watcher.locator('#retro-return').click();
        const before=await host.evaluate(()=>mk64._web_frame());
        await host.waitForFunction(frame=>mk64._web_frame()>frame+30,before);
        assert.deepEqual(errors,[]);
        console.log('Invite, mobile layout, spectator synchronization and spectator departure passed.');
    } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
