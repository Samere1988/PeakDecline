const assert=require('node:assert/strict'),path=require('node:path'),{spawn}=require('node:child_process');
const {chromium}=require('C:/Users/Plex/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root=path.resolve(__dirname,'../..');
(async()=>{
    const server=spawn(path.join(root,'.venv/Scripts/python.exe'),[path.join(__dirname,'catan_online_fixture.py')],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let errors='';server.stderr.on('data',d=>{errors=(errors+d.toString()).slice(-4000);});
    let browser;
    try{
        const port=await new Promise((resolve,reject)=>{
            const timer=setTimeout(()=>reject(new Error('Fixture did not start: '+errors)),15000);
            server.stdout.on('data',d=>{const m=d.toString().match(/CATAN_TEST_PORT=(\d+)/);if(m){clearTimeout(timer);resolve(Number(m[1]));}});
            server.on('exit',code=>{clearTimeout(timer);reject(new Error('Fixture exited '+code+': '+errors));});
        });
        const origin='http://127.0.0.1:'+port;
        browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
        const pages=[],issues=[];
        for(let i=0;i<6;i++){
            const context=await browser.newContext({viewport:{width:1366,height:1000}});
            // Exercise polling fallback independently from public CDN availability.
            await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.fulfill({body:''}));
            const page=await context.newPage();pages.push(page);page.on('pageerror',e=>issues.push(e.message));
            await page.goto(origin+'/test-login/'+i);await page.locator('#online-notice').filter({hasText:'Connected'}).waitFor();
        }
        await pages[0].locator('#open-create-room').click();
        assert.equal(await pages[0].locator('input[name="game-mode"][value="base"]').isChecked(),true);
        assert.equal(await pages[0].locator('input[name="game-mode"][value="cities-knights"]').isEnabled(),true);
        await pages[0].locator('#room-name').fill('First room');await pages[0].locator('#create-room').click();await pages[0].locator('#online-room').waitFor();
        assert.equal(await pages[0].locator('#room-mode-label').innerText(),'Base game');
        assert.equal(await pages[0].locator('.catan-layout').isVisible(),true,'Wait at the board');
        assert.equal(await pages[0].locator('.hex').count(),19);
        assert.equal(await pages[0].locator('.placement-target').count(),0,'No moves before start');
        assert.equal(await pages[0].locator('#chat-panel').isVisible(),true);
        await pages[5].locator('[data-room-card]').filter({hasText:'First room'}).locator('[data-role="spectate"]').click();await pages[5].locator('#online-room').waitFor();
        assert.equal(await pages[5].evaluate(()=>CatanClient.room.seat),null);
        assert.equal(await pages[5].locator('.chat-toggle').evaluate(element=>element.open),true,'Chat is visible beside move history');
        assert.equal(await pages[0].locator('.chat-toggle').evaluate(element=>element.open),true);
        await pages[5].locator('#chat-message').fill('Hello from spectator');await pages[5].locator('#chat-form button').click();
        await pages[0].locator('#room-chat').filter({hasText:'Hello from spectator'}).waitFor();
        for(const p of pages.slice(1,4)){await p.locator('[data-room-card]').filter({hasText:'First room'}).locator('[data-role="play"]').click();await p.locator('#online-room').waitFor();}
        // A second independent room is created while the first fills up.
        await pages[4].locator('#refresh-rooms').click();await pages[4].locator('[data-room-card]').first().waitFor();
        await pages[4].screenshot({path:path.join(__dirname,'catan-room-list.png'),fullPage:true});
        await pages[4].locator('#open-create-room').click();await pages[4].locator('#room-name').fill('Independent room');await pages[4].locator('#create-room').click();await pages[4].locator('#online-room').waitFor();
        for(const p of pages.slice(0,4)){
            await p.waitForFunction(()=>CatanClient.room?.members.filter(m=>m.seat!==null).length===4);
            await p.locator('#ready-room').click();
            await p.waitForFunction(()=>CatanClient.room.members.find(m=>m.id===CatanClient.room.me).ready);
        }
        await pages[0].screenshot({path:path.join(__dirname,'catan-waiting-room.png'),fullPage:true});
        await pages[0].locator('#start-room').click();
        for(const p of pages.slice(0,4))await p.waitForFunction(()=>!!CatanClient.room?.game);
        for(const width of [1366,390]){
            await pages[0].setViewportSize({width,height:1000});
            const controls=await pages[0].evaluate(()=>{
                const box=id=>document.querySelector(id).getBoundingClientRect();
                return {label:box('#turn-label').toJSON(),dice:box('#dice-display').toJSON(),rules:box('#base-rules-button').toJSON()};
            });
            assert.ok(controls.label.width>0&&controls.label.right<=controls.dice.left+1,'Turn label sits left of the dice');
            assert.ok(controls.label.left>=controls.rules.right,'Rulebook does not cover the turn label');
        }
        await pages[0].setViewportSize({width:1366,height:1000});
        const order=[0,1,2,3,3,2,1,0];
        for(let i=0;i<order.length;i++){
            const p=pages[order[i]];
            await p.waitForFunction(step=>CatanClient.room?.game.setup===step&&CatanClient.room.game.phase==='setup-settlement',i);
            const other=pages[(order[i]+1)%4];
            await other.waitForFunction(step=>CatanClient.room?.game.setup===step,i);
            assert.equal(await other.locator('.placement-target').count(),0,'Only active player can place');
            await p.locator('.placement-target').first().click();
            await p.locator('.road-target').first().waitFor();await p.locator('.road-target').first().click();
            await p.waitForFunction(step=>CatanClient.room.game.setup>step,i);
        }
        await pages[0].waitForFunction(()=>CatanClient.room?.game.phase==='roll');
        assert.equal(await pages[0].locator('.board-piece').count(),8);
        // Response-level privacy, not just hidden controls.
        const hidden=await pages[1].evaluate(async()=>{
            const room=await fetch('/api/catan/rooms/'+CatanClient.room.id).then(r=>r.json());
            return room.game.players.map(p=>p.resources);
        });
        assert.equal(hidden[0],null);assert.ok(hidden[1]);assert.equal(hidden[2],null);
        await pages[0].reload();await pages[0].waitForFunction(()=>CatanClient.room?.game?.phase==='roll');
        assert.equal(await pages[0].locator('.board-piece').count(),8);
        assert.equal(await pages[0].evaluate(()=>CatanClient.room.seat),0);
        await pages[0].locator('#roll-dice').click();
        await pages[0].waitForFunction(()=>!!CatanClient.room.game.dice);
        for(const p of pages.slice(0,4))await p.waitForFunction(()=>!!CatanClient.room.game.dice);
        const rolls=await Promise.all(pages.slice(0,4).map(p=>p.locator('#dice-display strong').innerText()));
        assert.ok(rolls.every(r=>r===rolls[0]),'All browsers show the same server dice');
        if(await pages[0].evaluate(()=>CatanClient.room.game.phase==='robber')){
            await pages[0].locator('.robber-target').first().click();
            await pages[0].waitForFunction(()=>CatanClient.room.game.phase!=='robber');
            if(await pages[0].locator('[data-steal]').count())await pages[0].locator('[data-steal]').first().click();
        }
        await pages[0].waitForFunction(()=>CatanClient.room.game.phase==='build');
        await pages[0].setViewportSize({width:2219,height:1174});
        if(process.env.BASE_VISUAL_PATH)await pages[0].screenshot({path:process.env.BASE_VISUAL_PATH});
        const layout=await pages[0].evaluate(()=>{
            const rect=selector=>document.querySelector(selector).getBoundingClientRect();
            return {sidebar:rect('.catan-sidebar').width/innerWidth,chat:rect('#chat-panel').height,moves:rect('.move-summary').height,card:rect('#resources .resource').width,action:rect('.action-tray .action-tile').width};
        });
        assert.ok(Math.abs(layout.sidebar-.21)<.01,'Base sidebar matches Cities & Knights width');
        assert.ok(Math.abs(layout.chat-layout.moves)<3,'Chat and moves split the activity area evenly');
        assert.ok(layout.card>=55&&layout.action>=100,'Base cards and actions match the expansion scale');
        assert.ok(await pages[0].evaluate(()=>{
            const panel=document.querySelector('#chat-panel').getBoundingClientRect();
            const form=document.querySelector('#chat-form').getBoundingClientRect();
            return panel.bottom-form.bottom<18;
        }),'Chat input stays at the bottom of its panel');
        await pages[0].setViewportSize({width:1366,height:1000});
        assert.equal(await pages[0].locator('.move-summary').evaluate(el=>{
            const history=el.querySelector('#room-history');return history.clientHeight>=el.clientHeight*.75;
        }),true,'Move history fills the available summary height');
        await pages[0].locator('#end-turn').click();await pages[1].waitForFunction(()=>CatanClient.room.game.current===1);
        assert.equal(await pages[4].evaluate(()=>CatanClient.room.status),'lobby');
        assert.equal(await pages[4].locator('.catan-layout').isVisible(),true);
        assert.equal(await pages[4].locator('.placement-target').count(),0);
        const roomId=await pages[1].evaluate(()=>CatanClient.room.id);
        await pages[1].request.post(origin+'/test-seed/'+roomId);
        await pages[1].waitForFunction(()=>CatanClient.room.game.phase==='build'&&CatanClient.room.game.players[1].resources.wood===4);
        await pages[1].locator('#buy-development').hover();
        assert.equal(await pages[1].locator('.catan-cost-tooltip:not([hidden]) .catan-cost-card').count(),3);
        assert.match(await pages[1].locator('[data-dev="monopoly"]').getAttribute('title'),/every other player/i);
        await pages[1].locator('[data-dev="monopoly"]').click();
        assert.equal(await pages[1].locator('#development-options .dev-choice-grid button').count(),5);
        const devText=await pages[1].locator('#development-options').evaluate(panel=>({
            background:getComputedStyle(panel).backgroundColor,
            title:getComputedStyle(panel.querySelector('h2')).color,
            description:getComputedStyle(panel.querySelector('p')).color
        }));
        assert.equal(devText.background,'rgb(33, 27, 40)');
        assert.equal(devText.title,'rgb(241, 244, 246)');
        assert.equal(devText.description,devText.title,'Development card explanation is readable on the dark panel');
        await pages[1].locator('#cancel-development').click();
        await pages[1].locator('#base-rules-button').click();
        assert.equal(await pages[1].locator('#base-rules-dialog').isVisible(),true);
        await pages[1].locator('[data-close-rules]').click();
        await pages[1].locator('#open-trade').click();
        await pages[1].evaluate(()=>{window.receivedAnimations=0;new MutationObserver(records=>{for(const r of records)for(const n of r.addedNodes)if(n.classList?.contains('received-card'))window.receivedAnimations++;}).observe(document.body,{childList:true});});
        await pages[1].emulateMedia({reducedMotion:'reduce'});
        await pages[1].locator('[data-mode="bank"]').click();
        await pages[1].locator('[data-pick="give"][data-resource="wood"]').click();
        await pages[1].locator('[data-pick="want"][data-resource="ore"]').click();
        await pages[1].locator('#submit-negotiated-trade').click();
        await pages[1].waitForFunction(()=>CatanClient.room.game.players[1].resources.ore===4);
        await pages[1].locator('.card-receipt.visible img').first().waitFor();
        assert.match(await pages[1].locator('#room-history').innerText(),/Player 1 received 1 ore/);
        await pages[1].emulateMedia({reducedMotion:'no-preference'});
        await pages[1].locator('[data-mode="players"]').click();
        await pages[1].locator('[data-pick="give"][data-resource="sheep"]').click();
        for(const r of ['brick','wheat'])await pages[1].locator(`[data-pick="want"][data-resource="${r}"]`).click();
        await pages[1].locator('#submit-negotiated-trade').click();
        await pages[0].locator('[data-respond="accept-trade"]').waitFor();
        for(const p of pages.slice(2,4)){
            await p.waitForFunction(()=>CatanClient.room.game.offers.length===1);
            await p.evaluate(()=>document.querySelector('.catan-app').classList.remove('trading'));
        }
        const beforeAccept=await pages[0].evaluate(()=>CatanClient.room.game.players[0].resources.sheep);
        await pages[0].locator('[data-respond="accept-trade"]').click();
        await pages[1].waitForFunction(()=>CatanClient.room.game.offers[0]?.responses?.['0']==='accepted');
        for(const p of pages.slice(2,4)){
            await p.waitForFunction(()=>CatanClient.room.game.offers[0]?.responses?.['0']==='accepted');
            assert.equal(await p.locator('.catan-app').evaluate(el=>el.classList.contains('trading')),false,'Accepting must not reopen trade for other players');
        }
        assert.equal(await pages[0].evaluate(()=>CatanClient.room.game.players[0].resources.sheep),beforeAccept,'Accept is consent, not immediate payment');
        await pages[1].locator('[data-confirm][data-target="0"]').click();
        await pages[1].waitForFunction(()=>!CatanClient.room.game.offers.length&&CatanClient.room.game.players[1].resources.wheat===3);
        // Wait for the previous exchange to reach the other browser before editing a new offer.
        await pages[0].waitForFunction(()=>CatanClient.room.game.offers.length===0);
        // Open-ended offers become concrete counteroffers; another player can join.
        await pages[1].locator('#open-trade').click();
        await pages[1].locator('[data-pick="give"][data-resource="brick"]').click();
        await pages[1].locator('#submit-negotiated-trade').click();
        await pages[0].waitForFunction(()=>CatanClient.room.game.offers.length===1&&!Object.values(CatanClient.room.game.offers[0].want).some(Boolean));
        await pages[0].locator('[data-edit]').first().click();
        await pages[0].locator('[data-pick="give"][data-resource="wood"]').click();
        await pages[0].locator('#submit-negotiated-trade').click();
        await pages[2].waitForFunction(()=>CatanClient.room.game.offers.length===2);
        await pages[3].waitForFunction(()=>CatanClient.room.game.offers.length===2);
        await pages[3].evaluate(()=>document.querySelector('.catan-app').classList.remove('trading'));
        await pages[2].locator('[data-respond="reject-trade"]').last().click();
        await pages[2].waitForFunction(()=>CatanClient.room.game.offers[1]?.responses?.['2']==='rejected');
        await pages[3].waitForFunction(()=>CatanClient.room.game.offers[1]?.responses?.['2']==='rejected');
        assert.equal(await pages[3].locator('.catan-app').evaluate(el=>el.classList.contains('trading')),false,'Declining must not reopen trade for other players');
        await pages[2].locator('#open-trade').click();
        await pages[2].locator('[data-respond="accept-trade"]').last().click();
        await pages[1].waitForFunction(()=>CatanClient.room.game.offers[1]?.responses?.['2']==='accepted');
        await pages[1].screenshot({path:path.join(__dirname,'catan-negotiated-trade.png'),fullPage:true});
        await pages[1].locator('[data-confirm][data-target="2"]').last().click();
        await pages[1].waitForFunction(()=>CatanClient.room.game.offers.length===0);
        assert.ok(await pages[1].evaluate(()=>window.receivedAnimations>0),'Received resource cards animate');
        await pages[1].locator('#buy-development').click();await pages[1].locator('[data-dev="knight"]').waitFor();
        assert.equal(await pages[1].locator('[data-dev="knight"]').isDisabled(),true,'New card cannot be played this turn');
        assert.equal(await pages[1].locator('.development-card img').count(),5,'All development-card types have artwork');
        assert.equal(await pages[1].locator('.development-card img').evaluateAll(images=>images.every(image=>image.complete&&image.naturalWidth>0)),true,'Development-card artwork loads');
        await pages[1].locator('[data-build="city"]').click();await pages[1].locator('.placement-target').first().click();
        await pages[1].waitForFunction(()=>CatanClient.room.game.players[1].city===3);
        await pages[1].locator('[data-dev="roadbuilding"]').click();
        await pages[1].locator('#confirm-development').click();
        for(let i=0;i<2;i++){
            await pages[1].locator('.road-target').first().waitFor();await pages[1].locator('.road-target').first().click();
            await pages[1].waitForFunction(n=>CatanClient.room.game.players[1].road===n,12-i);
        }
        await pages[1].waitForFunction(()=>CatanClient.room.game.phase==='build');
        await pages[1].screenshot({path:path.join(__dirname,'catan-development-cards.png'),fullPage:true});
        assert.equal(await pages[1].locator('.hex .number').count(),18);
        for(const [width,height] of [[1366,768],[1920,910]]){
            await pages[1].setViewportSize({width,height});
            const dock=await pages[1].evaluate(()=>{
                const bounds=s=>document.querySelector(s).getBoundingClientRect();
                const hand=bounds('.bottom-controls'),resources=bounds('#resources'),dev=bounds('#development-hand'),board=bounds('#board');
                return {height:hand.height,boardHeight:board.height,sameRow:Math.abs(resources.top-dev.top)<10,contained:dev.bottom<=hand.bottom&&dev.top>=hand.top,fits:document.documentElement.scrollHeight<=innerHeight};
            });
            const expectedDock=width>=1500&&height>=900?108:84;
            assert.ok(dock.height<=expectedDock+2&&dock.boardHeight>=height-expectedDock-45&&dock.sameRow&&dock.contained&&dock.fits,'Shared development-card dock '+width+': '+JSON.stringify(dock));
            await pages[1].screenshot({path:path.join(__dirname,`catan-board-first-${width}.png`),fullPage:true});
        }
        for(const [width,height] of [[320,640],[390,844],[768,1024],[1366,768],[1920,1080],[1536,864]]){
            await pages[0].setViewportSize({width,height});
            await pages[0].waitForTimeout(100);
            const fit=await pages[0].evaluate(()=>{
                const hand=document.querySelector('.bottom-controls').getBoundingClientRect(),board=document.querySelector('#board').getBoundingClientRect();
                const ports=[...document.querySelectorAll('.coastal-port')].every(p=>{const r=p.getBoundingClientRect();return r.top>=board.top&&r.bottom<=board.bottom&&r.left>=board.left&&r.right<=board.right;});
                return {ports,fits:document.documentElement.scrollWidth<=innerWidth&&document.documentElement.scrollHeight<=innerHeight,handVisible:hand.bottom<=innerHeight&&hand.top>=0,boardHeight:board.height};
            });
            assert.ok(fit.ports&&fit.fits&&fit.handVisible&&fit.boardHeight>100,'Viewport fits '+width+'x'+height+': '+JSON.stringify(fit));
            if(width===1366||width===390)await pages[0].screenshot({path:path.join(__dirname,`catan-fit-${width}.png`),fullPage:true});
        }
        await pages[0].screenshot({path:path.join(__dirname,'catan-online-1366.png'),fullPage:true});
        const solo=pages[4];
        await solo.locator('#back-lobby').click();await solo.locator('#open-create-room').click();
        await solo.locator('#test-room').check();await solo.locator('#room-name').fill('Test room');await solo.locator('#create-room').click();
        await solo.waitForFunction(()=>CatanClient.room?.testMode);
        await solo.locator('#start-room').click();await solo.waitForFunction(()=>!!CatanClient.room?.game);
        for(let move=0;move<12;move++){
            const current=await solo.evaluate(()=>CatanClient.room.game.current);
            const selected=await solo.evaluate(()=>CatanClient.room.seat);
            if(current!==selected){await solo.locator(`[data-test-seat="${current}"]`).click();await solo.waitForFunction(i=>CatanClient.room.seat===i,current);}
            const revision=await solo.evaluate(()=>CatanClient.room.gameRevision);
            await solo.locator('.placement-target, .road-target').first().click();
            await solo.waitForFunction(v=>CatanClient.room.gameRevision>v,revision);
        }
        assert.equal(await solo.evaluate(()=>CatanClient.room.game.phase),'roll');
        await solo.reload();await solo.waitForFunction(()=>CatanClient.room?.testMode&&!!CatanClient.room.game);
        assert.equal(await solo.locator('#test-seat-options button').count(),3);
        assert.equal(await solo.locator('.card-receipt.visible').count(),0,'Reload does not replay card gains');
        await solo.locator('[data-test-seat="1"]').click();await solo.waitForFunction(()=>CatanClient.room.seat===1);
        assert.equal(await solo.locator('.card-receipt.visible').count(),0,'Switching seat does not invent card gains');
        await solo.setViewportSize({width:390,height:844});await solo.locator('#toggle-sidebar').click();
        assert.equal(await solo.locator('#test-seat-options').isVisible(),true);
        await solo.locator('#close-sidebar').click();
        assert.equal(await solo.locator('.bottom-controls').isVisible(),true);
        await solo.setViewportSize({width:1366,height:768});
        await solo.screenshot({path:path.join(__dirname,'catan-three-player-test.png'),fullPage:true});
        const summaryRoom=await solo.evaluate(()=>CatanClient.room.id);
        await solo.request.post(origin+'/test-finish/'+summaryRoom);
        await solo.waitForFunction(()=>CatanClient.room?.game?.phase==='finished');
        await solo.locator('#game-summary-overlay:visible').waitFor();
        assert.equal(await solo.locator('.roll-column').count(),11);
        assert.equal(await solo.locator('.roll-history li').count(),4);
        assert.deepEqual(await solo.locator('.roll-column .roll-bar-area strong').allTextContents(),['1','0','0','0','0','2','0','0','0','0','1']);
        assert.match(await solo.locator('.roll-history').innerText(),/Test Blue/);
        await solo.screenshot({path:path.join(__dirname,'catan-game-summary.png'),fullPage:true});
        await solo.locator('#close-game-summary').click();
        assert.equal(await solo.locator('#game-summary-overlay').isVisible(),false);
        await solo.locator('#show-game-summary').click();
        assert.equal(await solo.locator('#game-summary-overlay').isVisible(),true);
        await solo.setViewportSize({width:390,height:844});
        assert.equal(await solo.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Game summary fits a narrow screen');
        assert.deepEqual(issues,[]);
        console.log('PASS: four players and isolated second room; setup, private HTTP hands, refresh, shared dice, turns, bank/player trades, development purchase, city upgrade, free roads and responsive UI.');
    }finally{if(browser)await browser.close();server.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});
