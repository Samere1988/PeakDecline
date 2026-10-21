const assert=require('node:assert/strict'), path=require('node:path'), {spawn}=require('node:child_process');
const {chromium}=require('C:/Users/Plex/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root=path.resolve(__dirname,'../..');

(async()=>{
    const server=spawn(path.join(root,'.venv/Scripts/python.exe'),[path.join(__dirname,'catan_online_fixture.py')],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let stderr='',browser;
    server.stderr.on('data',chunk=>stderr=(stderr+chunk.toString()).slice(-3000));
    try{
        const port=await new Promise((resolve,reject)=>{
            const timer=setTimeout(()=>reject(new Error('Fixture did not start: '+stderr)),15000);
            server.stdout.on('data',chunk=>{const match=chunk.toString().match(/CATAN_TEST_PORT=(\d+)/);if(match){clearTimeout(timer);resolve(Number(match[1]));}});
            server.on('exit',code=>{clearTimeout(timer);reject(new Error('Fixture exited '+code+': '+stderr));});
        });
        browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
        const context=await browser.newContext({viewport:{width:1920,height:1080}});
        const origin='http://127.0.0.1:'+port;
        await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.fulfill({body:''}));
        const page=await context.newPage(),errors=[];
        page.on('pageerror',error=>errors.push(error.message));
        await page.goto(origin+'/test-login/0');
        await page.locator('#online-notice').filter({hasText:'Connected'}).waitFor();
        await page.locator('#open-create-room').click();
        assert.equal(await page.locator('#room-name').inputValue(),'');
        assert.equal(await page.locator('#room-name').getAttribute('placeholder'),'Enter a game name');
        assert.equal(await page.locator('#room-name').evaluate(input=>getComputedStyle(input,'::placeholder').opacity),'1');
        await page.locator('#room-name').focus();
        assert.equal(await page.locator('#room-name').evaluate(input=>getComputedStyle(input,'::placeholder').opacity),'0');
        assert.deepEqual(await page.locator('#base-map-choices strong').allInnerTexts(),['Base map 3-4 players','Base map 5-6 players']);
        await page.locator('input[name="game-map"][value="base-56"]').check();
        await page.locator('#test-room').check();
        await page.locator('#room-name').fill('Base 5-6');
        await page.locator('#create-room').click();
        await page.locator('#online-room').waitFor();
        await page.waitForFunction(()=>CatanClient.room?.map==='base-56');
        assert.equal(await page.locator('.hex').count(),30);
        assert.equal(await page.locator('.coastal-port').count(),11);
        assert.deepEqual(await page.locator('.coastal-port').evaluateAll(ports=>ports.map(port=>Number(port.dataset.portEdge))),[5,15,27,67,84,97,104,101,89,73,34]);
        assert.equal(await page.locator('[data-test-seat]').count(),5);
        await page.locator('#start-room').click();
        await page.waitForFunction(()=>CatanClient.room?.game?.players.length===5);
        assert.equal(await page.locator('.hex').count(),30);
        assert.equal(await page.locator('#players .player-row').count(),5);
        assert.ok(await page.locator('.placement-target').count()>0);
        const dimensions=await page.evaluate(()=>{
            const board=document.querySelector('.hex-board').getBoundingClientRect();
            const panel=document.querySelector('.board-panel').getBoundingClientRect();
            const sidebar=document.querySelector('.catan-sidebar').getBoundingClientRect();
            return {board:{width:board.width,height:board.height},panel:{width:panel.width,height:panel.height},sidebar:{width:sidebar.width,height:sidebar.height}};
        });
        if(process.env.CATAN_MAP_SCREENSHOT)await page.screenshot({path:process.env.CATAN_MAP_SCREENSHOT});
        assert.ok(dimensions.board.width<dimensions.panel.width && dimensions.board.height<dimensions.panel.height,JSON.stringify(dimensions));
        assert.ok(dimensions.sidebar.width>=360,JSON.stringify(dimensions));
        const order=[0,1,2,3,4,4,3,2,1,0];
        for(let step=0;step<order.length;step++){
            const seat=order[step];
            if(await page.evaluate(()=>CatanClient.room.seat)!==seat){
                await page.locator(`[data-test-seat="${seat}"]`).click();
                await page.waitForFunction(seat=>CatanClient.room.seat===seat,seat);
            }
            await page.waitForFunction(step=>CatanClient.room.game.setup===step&&CatanClient.room.game.phase==='setup-settlement',step);
            await page.locator('.placement-target').first().click();
            await page.locator('.road-target').first().waitFor();
            await page.locator('.road-target').first().click();
            await page.waitForFunction(step=>CatanClient.room.game.setup>step,step);
        }
        await page.waitForFunction(()=>CatanClient.room.game.phase==='roll');
        await page.locator('#roll-dice').click();
        await page.waitForFunction(()=>CatanClient.room.game.phase!=='roll');
        if(await page.evaluate(()=>CatanClient.room.game.phase==='robber')){
            await page.locator('.robber-target').first().click();
            await page.waitForFunction(()=>CatanClient.room.game.phase!=='robber');
            if(await page.locator('[data-steal]').count())await page.locator('[data-steal]').first().click();
        }
        await page.waitForFunction(()=>CatanClient.room.game.phase==='build');
        await page.locator('[data-test-seat="2"]').click();
        await page.waitForFunction(()=>CatanClient.room.seat===2);
        await page.locator('[data-special-build-flag]').click();
        await page.waitForFunction(()=>CatanClient.room.game.specialFlags.includes(2));
        await page.locator('[data-test-seat="0"]').click();
        await page.waitForFunction(()=>CatanClient.room.seat===0);
        await page.locator('#end-turn').click();
        await page.waitForFunction(()=>CatanClient.room.game.phase==='special-build');
        assert.equal(await page.evaluate(()=>CatanClient.room.game.current),2);
        await page.locator('[data-test-seat="2"]').click();
        await page.waitForFunction(()=>CatanClient.room.seat===2);
        assert.equal(await page.locator('#end-turn span').innerText(),'Finish build');
        assert.equal(await page.locator('#open-trade').isDisabled(),true);
        await page.locator('#end-turn').click();
        await page.waitForFunction(()=>CatanClient.room.game.phase==='roll'&&CatanClient.room.game.current===1);
        // The fixture uses one account to control every test seat; let its action window reset.
        await page.waitForTimeout(10000);
        await page.goto(origin+'/games/catan');
        await page.locator('#online-notice').filter({hasText:'Connected'}).waitFor();
        await page.locator('#open-create-room').click();
        await page.locator('input[name="game-mode"][value="cities-knights"]').check();
        assert.equal(await page.locator('#base-map-choices').isVisible(),true);
        await page.locator('input[name="game-map"][value="base-56"]').check();
        await page.locator('#test-room').check();
        await page.locator('#room-name').fill('Knights 5-6');
        await page.locator('#create-room').click();
        await page.waitForFunction(()=>CatanClient.room?.mode==='cities-knights'&&CatanClient.room?.map==='base-56');
        assert.equal(await page.locator('#room-mode-label').innerText(),'Cities & Knights · 5–6 player');
        await page.locator('#start-room').click();
        await page.waitForFunction(()=>CatanClient.room?.game?.players.length===5);
        assert.equal(await page.locator('.hex').count(),30);
        assert.equal(await page.locator('.ck-seat').count(),5);
        assert.equal(await page.evaluate(()=>CatanClient.room.game.commodityBank.paper),18);
        assert.equal(await page.locator('.ck-seat-avatar-bg').last().evaluate(image=>image.complete&&image.naturalWidth>0),true);
        const ckRoom=await page.evaluate(()=>CatanClient.room.id);
        await page.request.post(origin+'/test-seed-ck-56/'+ckRoom);
        await page.waitForFunction(()=>CatanClient.room.game.phase==='build'&&CatanClient.room.game.turn===4);
        await page.locator('[data-test-seat="1"]').click();
        await page.waitForFunction(()=>CatanClient.room.seat===1);
        await page.locator('[data-special-build-flag]').click();
        await page.waitForFunction(()=>CatanClient.room.game.specialFlags.includes(1));
        await page.locator('[data-test-seat="0"]').click();
        await page.waitForFunction(()=>CatanClient.room.seat===0);
        await page.locator('#end-turn').click();
        await page.waitForFunction(()=>CatanClient.room.game.phase==='special-build');
        await page.locator('[data-test-seat="1"]').click();
        await page.waitForFunction(()=>CatanClient.room.seat===1);
        assert.equal(await page.locator('#turn-label').innerText().then(text=>text.includes('Special Build')),true);
        assert.equal(await page.locator('#open-trade').isDisabled(),true);
        await page.locator('#ck-knight-actions').click();
        await page.locator('[data-ck-option="build-knight"]').click();
        await page.locator('.ck-build-target[data-ck-build-target="1"]').click();
        await page.waitForFunction(()=>Object.keys(CatanClient.room.game.knightPieces).length===1);
        assert.equal(await page.evaluate(()=>CatanClient.room.game.knightPieces['1'].owner),1);
        assert.deepEqual(errors,[]);
        console.log(JSON.stringify({ok:true,dimensions}));
    }finally{if(browser)await browser.close();server.kill();}
})().catch(error=>{console.error(error);process.exitCode=1;});
