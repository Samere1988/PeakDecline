const {chromium}=require('C:/Users/Plex/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 const pages=[],errors=[];
 try {
 for(let slot=0;slot<3;slot++){
  const context=await browser.newContext(),page=await context.newPage();pages.push(page);
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:8066/test-login/rollback-'+slot);
  await page.waitForFunction(()=>window.PeakNet?.RollbackSession);
  await page.evaluate(slot=>{
   let timer;
   PeakNet.adapters.set('mk64',{
    present(){},hostChanged(){},stop(){clearInterval(timer);},
    async launch({session}){
     clearInterval(timer);let state={x:[0,0],rng:123,frame:0},samples=0;
     window.fixtureState=()=>structuredClone(state);window.fixtureHashes={};
     session.bind({sampleInput:()=>({buttons:0,x:(++samples*(slot+3))%161-80,y:0}),
      saveState:()=>structuredClone(state),restoreState:s=>{state=structuredClone(s);},
      simulateFrame(pads,{frame}){state.frame=frame;state.rng=(Math.imul(state.rng,1664525)+1013904223)>>>0;pads.forEach((p,i)=>state.x[i]+=p.x);},
      hashState(){let h=state.rng;state.x.forEach(x=>h=Math.imul(h^x,16777619)>>>0);fixtureHashes[state.frame]=h;return h;}
     });
     // A whole peer runs behind, exercising prediction and eventual correction.
     const receive=session.receiveInput.bind(session);session.receiveInput=e=>setTimeout(()=>receive(e),slot===0?55:0);
     const rows=session.receive.bind(session);session.receive=e=>setTimeout(()=>rows(e),slot===0?55:0);
     timer=setInterval(()=>{if(session.frame<=360)session.advance();else session.engine.reconcile();},16);
    }
   });
  },slot);
 }
 const [host,guest,watcher]=pages;
 await host.locator('#retro-open-create').click();await host.locator('#retro-room-name').fill('Rollback integration');await host.locator('#retro-room-create').click();
 await host.locator('#retro-lobby').waitFor();const invite=await host.locator('#retro-invite').inputValue();
 // Join without navigation so the test adapter remains registered.
 const code=new URL(invite).searchParams.get('room');
 for(const page of [guest,watcher])await page.getByRole('button',{name:'Join room',exact:true}).click();
 await guest.locator('#retro-choose-player').click();
 for(const page of [host,guest])await page.locator('#retro-ready').click();
 await host.locator('#retro-start-race').click();
 await Promise.all(pages.map(p=>p.waitForFunction(()=>window.retroNetplay?.frame===361 || window.retroNetplay?.failed,null,{timeout:45000})));
 await host.waitForTimeout(300);
 for(const page of pages)assert.equal(await page.evaluate(()=>retroNetplay.failed),false,await page.locator('#retro-runtime-status').textContent());
 const states=await Promise.all(pages.map(p=>p.evaluate(()=>fixtureState())));assert.deepEqual(states[0],states[1]);assert.deepEqual(states[0],states[2]);
 const corrections=await host.evaluate(()=>retroNetplay.engine.rollbacks);assert.ok(corrections>0);
 assert.equal(await watcher.evaluate(()=>retroNetplay.sentThrough),0);
 assert.deepEqual(errors,[]);console.log('Real browser + Socket.IO: 360 synchronized frames, '+corrections+' corrections, spectator matched.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
