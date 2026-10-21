const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('C:/Users/Plex/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
(async()=>{
    const info=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../../.tmp/catan-playtest/connection.json'),'utf8'));
    const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
    try{
        const context=await browser.newContext(),errors=[],pages=[];
        await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.fulfill({body:''}));
        for(let i=0;i<4;i++){
            const page=await context.newPage();pages.push(page);page.on('pageerror',e=>errors.push(e.message));
            await page.goto(info.links[i].url);
            await page.waitForFunction(()=>window.CatanClient?.room?.members.length===4);
            assert.equal(await page.evaluate(()=>CatanClient.room.seat),i);
            assert.equal(await page.evaluate(()=>CatanClient.room.id),info.room);
        }
        // All four tabs share one browser context, but retain independent identities.
        await pages[0].reload();await pages[0].waitForFunction(()=>window.CatanClient?.room?.seat===0);
        assert.equal(await pages[0].locator('#start-room').isEnabled(),true);
        await pages[0].setViewportSize({width:1366,height:1000});
        await pages[0].screenshot({path:path.join(__dirname,'catan-playtest-waiting.png'),fullPage:true});
        for(const width of [320,390,768]){
            await pages[0].setViewportSize({width,height:1000});
            assert.ok(await pages[0].evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Waiting room fits '+width);
        }
        await pages[0].locator('#back-lobby').click();await pages[0].locator('#online-rooms').waitFor();
        await pages[0].setViewportSize({width:320,height:1000});
        assert.ok(await pages[0].evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Room cards fit mobile');
        await pages[0].locator('#open-create-room').click();
        assert.equal(await pages[0].locator('#create-room-dialog').isVisible(),true);
        assert.equal(await pages[0].locator('#public-room').count(),0);
        await pages[0].locator('#cancel-create-room').click();
        assert.deepEqual(errors,[]);
        console.log('PASS: four test seats in one browser, independent identities, saved shared room, host ready to start; no game moves made.');
    }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
