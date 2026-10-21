/* Spectator recovery regressions against mk64_retro_server.py, never production. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {chromium} = require(process.env.MK64_PLAYWRIGHT || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const base = process.env.MK64_TEST_URL || 'http://127.0.0.1:8068';
assert.equal(new URL(base).hostname, '127.0.0.1', 'Integration fixture must be local');
const output = path.resolve(__dirname, '../../.tmp/mk64-netplay-20261013');
fs.mkdirSync(output, {recursive:true});

(async()=>{
    const browsers=[],active=[],errors=[],report={checks:[]};
    const launch = () => chromium.launch({headless:true,
        executablePath:process.env.MK64_BROWSER || path.join(os.homedir(), '.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'),
        args:['--enable-unsafe-swiftshader','--autoplay-policy=no-user-gesture-required']});
    async function pair(label, blockedRom=false) {
        const pages=[],contexts=[];
        for(let index=0;index<2;index++){
            if(!browsers[index])browsers[index]=await launch();
            const context=await browsers[index].newContext(),page=await context.newPage();
            contexts.push(context);pages.push(page);active.push(page);
            page.on('pageerror',error=>errors.push({label,index,message:error.message}));
            if(index===1&&blockedRom)await page.route('**/*.z64',route=>route.fulfill({status:503,body:'Intentional spectator ROM failure'}));
            await page.goto(base+'/test-login/mk64-spectator-'+label+'-'+index);
        }
        const [host,spectator]=pages,roomName='MK64 spectator '+label+' '+Date.now();
        await host.locator('#retro-open-create').click();
        await host.locator('#retro-game-select').selectOption('mk64');
        await host.locator('#retro-room-name').fill(roomName);
        await host.locator('#retro-room-create').click();
        await spectator.locator('.room-card').filter({hasText:roomName}).getByRole('button',{name:'Join room',exact:true}).click();
        await host.locator('#retro-choose-player').click();
        await spectator.locator('#retro-choose-spectator').click();
        await host.locator('#retro-ready').click();
        await host.locator('#retro-start-race').click();
        async function close(){
            // Explicit leave avoids retaining disconnected fixture rooms for the grace period.
            for(const page of pages)await page.evaluate(()=>{window.retroNetplay?.socket?.emit('leave')}).catch(()=>{});
            await host.waitForTimeout(150);
            await Promise.all(contexts.map(context=>context.close()));
            for(const page of pages)active.splice(active.indexOf(page),1);
        }
        return {host,spectator,close};
    }
    async function state(page){return page.evaluate(()=>({frame:mk64._web_frame(),next:retroNetplay.frame,
        received:retroNetplay.receivedThrough,buffered:retroNetplay.frames.size,failed:retroNetplay.failed,
        paused:retroNetplay.transportSuspended,status:document.querySelector('#retro-runtime-status').textContent}));}
    async function equalHashes(host,spectator,length=60){
        const through=Math.min((await state(host)).frame,(await state(spectator)).frame)-3;
        const hashes=await Promise.all([host,spectator].map(page=>page.evaluate(({through,length})=>
            Array.from({length},(_,index)=>mk64._web_hash_for_frame(through-index)>>>0),{through,length})));
        assert(hashes.every(row=>row.every(Boolean)),'Completed hashes must exist');
        assert.deepEqual(hashes[0],hashes[1],'Spectator must match the racer after recovery');
        return {through,length};
    }
    try{
        {
            const {host,spectator,close}=await pair('recovery');
            try{
                await Promise.all([host,spectator].map(page=>page.waitForFunction(()=>window.mk64?._web_frame()>=250,null,{timeout:90000})));
                report.initialHashes=await equalHashes(host,spectator);
                await spectator.evaluate(()=>{
                    const bridge=mk64.mk64Network,ready=bridge.frameReady,catchingUp=bridge.catchingUp;
                    window.holdSpectator=true;window.catchupChecks=0;
                    bridge.frameReady=frame=>window.holdSpectator?0:ready(frame);
                    bridge.catchingUp=()=>{const value=catchingUp();if(value)window.catchupChecks++;return value};
                });
                const before=await state(host);
                await host.waitForTimeout(1600);
                const during=await state(spectator),after=await state(host);
                report.lag={racerProgress:after.frame-before.frame,spectator:during};
                assert(after.frame-before.frame>=35,'The racer continues during a delayed spectator');
                assert(during.received-during.next>32,'Regression must exceed the old receive window');
                assert.equal(during.failed,false);
                await spectator.evaluate(()=>{window.holdSpectator=false});
                await spectator.waitForFunction(()=>retroNetplay.receivedThrough-retroNetplay.frame<=4&&!retroNetplay.failed,null,{timeout:20000});
                assert(await spectator.evaluate(()=>catchupChecks>0),'Native pacing must invoke accelerated catch-up');
                assert(await spectator.evaluate(()=>retroNetplay.sentThrough===0&&retroNetplay.pendingInputs.size===0),'Spectators never submit controller inputs');
                report.recoveredHashes=await equalHashes(host,spectator);
                report.checks.push('spectator exceeds 32-frame backlog, catches up and retains matching hashes');

                const reconnectAt=(await state(host)).frame;
                await spectator.evaluate(()=>{window.beforeReconnectModule=mk64;retroNetplay.socket.io.engine.close()});
                await spectator.waitForFunction(()=>retroNetplay.socket.connected&&!retroNetplay.transportSuspended&&!retroNetplay.failed,null,{timeout:20000});
                await spectator.waitForFunction(frame=>mk64._web_frame()>=frame+60,reconnectAt,{timeout:20000});
                assert(await spectator.evaluate(()=>mk64===beforeReconnectModule),'Reconnect retains the original native simulation');
                assert.equal((await state(host)).failed,false);
                report.reconnectHashes=await equalHashes(host,spectator);
                report.checks.push('spectator retained reconnect');

                await spectator.locator('#retro-return').click();
                const leavingAt=(await state(host)).frame;
                await host.waitForFunction(frame=>mk64._web_frame()>=frame+35,leavingAt,{timeout:10000});
                assert.equal((await state(host)).failed,false);
                report.checks.push('spectator departure leaves racer running');
            }finally{await close()}
        }
        {
            const {host,spectator,close}=await pair('failed-download',true);
            try{
                await spectator.waitForFunction(()=>window.retroNetplay?.failed,null,{timeout:20000});
                await host.waitForFunction(()=>window.mk64?._web_frame()>=100&&!retroNetplay.failed,null,{timeout:60000});
                const failure=await spectator.locator('#retro-runtime-status').textContent();
                assert.match(failure,/Game data is unavailable/i,'Spectator receives the actual startup failure');
                const before=(await state(host)).frame;
                await host.waitForFunction(frame=>mk64._web_frame()>=frame+35,before,{timeout:10000});
                assert.equal((await state(host)).failed,false);
                report.downloadFailure={spectatorStatus:failure,racer:await state(host)};
                report.checks.push('failed spectator ROM download is isolated during loading');
            }finally{await close()}
        }
        assert.deepEqual(errors,[]);
        report.result='passed';console.log(JSON.stringify(report,null,2));
    }catch(error){
        report.result='failed';report.error=error.stack;report.errors=errors;
        report.states=await Promise.all(active.map(page=>state(page).catch(()=>null)));
        throw error;
    }finally{
        fs.writeFileSync(path.join(output,'spectator-report.json'),JSON.stringify(report,null,2)+'\n');
        await Promise.all(browsers.map(browser=>browser.close()));
    }
})().catch(error=>{console.error(error);process.exitCode=1});
