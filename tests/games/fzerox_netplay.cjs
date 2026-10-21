const {chromium} = require('C:/Users/Plex/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
(async () => {
    const browser = await chromium.launch({headless:true, executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', args:['--enable-unsafe-swiftshader']});
    const pages = [], messages = [];
    const playerCount = Number(process.env.FZERO_PLAYERS || 2);
    try {
        for (let i=0;i<playerCount+1;i++) {
            const context = await browser.newContext(i === 0 ? {isMobile:true, hasTouch:true, viewport:{width:844,height:390}, userAgent:'Mozilla/5.0 iPhone'} : {});
            const page = await context.newPage();
            pages.push(page);
            page.on('pageerror', error => messages.push(`${i}: ${error.stack}`));
            page.on('console', item => { messages.push(`${i}: ${item.type()}: ${item.text()}`); fs.appendFileSync('.tmp/fzerox/netplay-live.log', `${i}: ${item.text()}\n`); });
            page.on('requestfailed', request => messages.push(`${i}: request ${request.url()} ${request.failure()?.errorText}`));
            await page.route('**/wasm_frame_adapter.js*', async route => {
                const response = await route.fetch();
                await route.fulfill({response, body:(await response.text()).replace('hashes.set(number, hash);', 'hashes.set(number, hash); (window.testHashes ||= {})[number] = hash;')});
            });
            await page.goto(`http://127.0.0.1:8066/test-login/fzero-${i}`);
        }
        const [host,guest] = pages;
        const watcher = pages.at(-1), players = pages.slice(0,playerCount);
        await host.locator('#retro-open-create').click();
        await host.locator('#retro-game-select').selectOption('fzerox');
        await host.locator('#retro-room-name').fill('F-Zero verification');
        await host.locator('#retro-room-create').click();
        await host.locator('#retro-lobby').waitFor();
        const invite = await host.locator('#retro-invite').inputValue();
        for (const page of pages.slice(1)) await page.goto(invite);
        for (const page of players.slice(1)) await page.locator('#retro-choose-player').click();
        for (const page of players) await page.locator('#retro-ready').click();
        await host.locator('#retro-start-race').click();
        await Promise.all(pages.map(page=>page.waitForFunction(()=>window.testHashes?.[600],null,{timeout:120000})));
        const hashes=await Promise.all(pages.map(page=>page.evaluate(()=>Object.fromEntries(Object.entries(testHashes).filter(([n])=>n<=600)))));
        for (const hash of hashes.slice(1)) assert.deepEqual(hashes[0], hash);
        console.log(`600 synchronized frames: ${playerCount} players and spectator.`);
        async function advance(count) {
            const target = await host.evaluate(count=>retroNetplay.frame+count,count);
            await host.waitForFunction(target=>retroNetplay.failed || retroNetplay.frame>=target,target,{timeout:90000});
            assert.equal(await host.evaluate(()=>retroNetplay.failed),false,await host.locator('#retro-runtime-status').textContent());
        }
        async function tap(key, targets=[host]) {
            for (const page of targets) await page.keyboard.down(key);
            await advance(10);
            for (const page of targets) await page.keyboard.up(key);
            await advance(45);
        }
        const mode=()=>host.frames().at(-1).evaluate(()=>window.fzeroState.mode & 31);
        await tap('Enter'); await advance(150);
        assert.equal(await mode(),7);
        for(let i=0;i<3;i++) await tap('ArrowRight');
        await tap('KeyX'); await advance(60);
        for(let i=2;i<playerCount;i++) await tap('ArrowDown');
        let racing=false;
        for(let i=0;i<18;i++) {
            const current=await mode();
            console.log('Menu',i,current);
            if(current>=3 && current<=5) { racing=true;break; }
            await tap('KeyX', players); await advance(60);
        }
        assert.ok(racing,'VS race did not start');
        assert.equal(await mode(),playerCount+1);
        const gameFrame=host.frames().at(-1);
        await gameFrame.evaluate(()=>{
            const audio=Module.SDL2;
            window.testAudio={peak:0,buffers:0};
            const node=audio.audio.scriptProcessorNode, process=node.onaudioprocess;
            node.onaudioprocess=event=>{
                process(event); ++testAudio.buffers;
                for(const sample of event.outputBuffer.getChannelData(0)) testAudio.peak=Math.max(testAudio.peak,Math.abs(sample));
            };
            if (audio.audioContext.state !== 'running') throw new Error('Game input did not activate browser audio');
        });
        for (const page of players) await page.keyboard.down('KeyX');
        await guest.keyboard.down('ArrowRight');
        await guest.evaluate(()=>{
            const emit=retroNetplay.socket.emit.bind(retroNetplay.socket);
            retroNetplay.socket.emit=(event,...args)=>event==='input'?setTimeout(()=>emit(event,...args),100):emit(event,...args);
        });
        await advance(600);
        const raceState=await gameFrame.evaluate(()=>window.fzeroState);
        assert.equal(raceState.racers.length,playerCount);
        assert.ok(raceState.racers.some(racer=>racer.time>0 && racer.speed>0));
        assert.notDeepEqual(raceState.racers[0],raceState.racers[1]);
        const audio=await gameFrame.evaluate(()=>window.testAudio);
        console.log('Audio:',audio);
        assert.ok(audio.buffers>0 && audio.peak>0,'No PCM reached the browser audio output');
        const finalFrame=await host.evaluate(()=>retroNetplay.frame-10);
        const raceHashes=await Promise.all(pages.map(page=>page.evaluate(end=>Object.fromEntries(Object.entries(testHashes).filter(([n])=>n<=end)),finalFrame)));
        for(const hash of raceHashes.slice(1)) assert.deepEqual(raceHashes[0],hash);
        console.log(`VS racing stayed synchronized through frame ${finalFrame}, including 100 ms added input delay.`);
        for(let i=0;i<pages.length;i++) await pages[i].locator('#fzerox-play-area').screenshot({path:`.tmp/fzerox/netplay-${playerCount}-${i}.png`});
        assert.equal(await watcher.evaluate(()=>retroNetplay.sentThrough),0);
        for(const page of players) await page.keyboard.up('KeyX');
        await guest.keyboard.up('ArrowRight');
        await host.locator('#fzerox-play-area [data-game-restart]').click();
        await Promise.all(pages.map(page=>page.waitForFunction(()=>retroNetplay.epoch===1 && retroNetplay.frame>350,null,{timeout:120000})));
        const restartHashes=await Promise.all(pages.map(page=>page.evaluate(()=>retroNetplay.adapter.hashForFrame(300))));
        assert.ok(restartHashes.every(hash=>hash===restartHashes[0]));
        const gamepadInput=await host.evaluate(()=>{
            const pad={id:'Fixture standard pad',index:0,mapping:'standard',connected:true,
                axes:[0.7,0,0,0],buttons:Array.from({length:17},(_,i)=>({pressed:i===0,value:i===0?1:0}))};
            Object.defineProperty(navigator,'getGamepads',{configurable:true,value:()=>[pad]});
            const input=retroNetplay.adapter.sampleInput();
            delete navigator.getGamepads;
            return input;
        });
        assert.ok((gamepadInput.buttons & 0x8000)!==0 && gamepadInput.x>0);
        
        const touch=host.locator('#fzerox-play-area [data-n64-button="a"]');
        await touch.scrollIntoViewIfNeeded();
        const bounds=await touch.boundingBox();
        await host.mouse.move(bounds.x+bounds.width/2,bounds.y+bounds.height/2); await host.mouse.down();
        assert.ok(await host.evaluate(()=>(retroNetplay.adapter.sampleInput().buttons & 0x8000)!==0));
        await host.mouse.up();
        await watcher.locator('#retro-return').click();
        await advance(90);
        await guest.close();
        await host.waitForFunction(()=>retroNetplay.failed);
        console.log('Restart, spectator departure, and player disconnect passed.');
    } catch(error) {
        for (let i=0;i<pages.length;i++) console.log(i, await pages[i].evaluate(()=>({status:document.getElementById('retro-runtime-status')?.textContent,failed:window.retroNetplay?.failed,frame:window.retroNetplay?.frame})).catch(()=>null));
        throw error;
    } finally {
        fs.writeFileSync('.tmp/fzerox/netplay-browser.log',messages.join('\n'));
        await browser.close();
    }
})().catch(error=>{console.error(error);process.exitCode=1;});
