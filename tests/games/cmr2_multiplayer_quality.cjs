const {chromium,firefox}=require(process.env.PLAYWRIGHT_MODULE||require('node:path').join(process.env.HOME,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const assert=require('node:assert/strict');
const path=require('node:path');
(async()=>{
 const count=Number(process.env.CMR2_PLAYERS||4);assert.ok(Number.isInteger(count)&&count>=2&&count<=8);
 const quality=[],errors=[];
 const engine=process.env.CMR2_MULTIPLAYER_BROWSER||'firefox';
 const b=engine==='firefox'?await firefox.launch({headless:true,executablePath:process.env.FIREFOX_PATH||path.join(process.env.HOME,'.cache/ms-playwright/firefox-1543/firefox/firefox'),firefoxUserPrefs:{'dom.webgpu.enabled':true,'media.autoplay.default':0}}):await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||path.join(process.env.HOME,'.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'),args:['--enable-unsafe-webgpu','--enable-gpu','--disable-gpu-sandbox','--use-angle=gl','--enable-features=Vulkan','--use-vulkan=native','--disable-vulkan-surface','--ignore-gpu-blocklist','--autoplay-policy=no-user-gesture-required','--disable-background-timer-throttling','--disable-renderer-backgrounding']});
 try {
 const contexts=await Promise.all(Array.from({length:count+1},()=>b.newContext())),pages=[];
 for(const context of contexts)await context.addInitScript(()=>{
  window.cmrCaptureCount=0;
  const original=HTMLCanvasElement.prototype.toBlob;
  HTMLCanvasElement.prototype.toBlob=function(...args){cmrCaptureCount++;return original.apply(this,args);};
 });
 for(let i=0;i<count+1;i++){const p=await contexts[i].newPage();p.on('console',m=>console.log(i,m.type(),m.text()));p.on('pageerror',e=>errors.push(e.message));await p.goto('http://127.0.0.1:8088/test-login/cmr-multi-'+i);pages.push(p);}
 const p=pages[0];await p.locator('#retro-open-create').click();await p.locator('#retro-game-select').selectOption('cmr2');await p.locator('#retro-room-name').fill('Two-player rally');await p.locator('#retro-room-create').click();await p.waitForTimeout(500);
 const invite=await p.locator('#retro-invite').inputValue();for(const player of pages.slice(1,count)){await player.goto(invite);await player.locator('#retro-choose-player').click();}
 await pages[count].goto(invite);await pages[count].locator('#retro-choose-spectator').click();for(const page of pages.slice(0,count))await page.locator('#retro-ready').click();await p.locator('#retro-start-race').click();await p.waitForTimeout(2500);
 const frames=pages.slice(0,count).map(p=>p.frames().find(f=>f.url().includes('/runtime/cmr2')));if(frames.some(f=>!f))throw new Error('Missing frames');
 await pages[count].evaluate(()=>{window.cmrAudioSamples=0;const session=retroNetplay,original=session.media;session.media=event=>{if(event.kind==='audio'&&new Int16Array(event.payload).some(n=>n!==0))cmrAudioSamples++;original?.(event);};});
 let started=false,driven=false,left=false;
 for(let i=0;i<70;i++){
  await p.waitForTimeout(1500);
  const states=await Promise.all(frames.map(f=>f.evaluate(()=>({state:Module.cmr2State,menu:Module.cmr2Menu,cars:Module.cmr2Cars,frames:Module.cmr2Frames,session:{created:Module.cmr2Transport.created,description:Module.cmr2Transport.description,queue:Module.cmr2Transport.queue.length}}))));console.log('STATES',JSON.stringify(states));
  if(!driven&&states.every(s=>s.state?.race===8)){
   // Lose car snapshots for longer than the old 100-tick decoder limit.
   // The room stays connected; a later full snapshot must restore movement.
   await pages[1].evaluate(()=>{
    const session=retroNetplay,original=session.onEvent;
    window.cmrDropCarState=true;window.cmrDroppedCarStates=0;
    session.socket.off('cmr2_event',original);
    session.onEvent=event=>{
     if(cmrDropCarState&&!event.type&&new Uint8Array(event.payload||[])[0]===11){cmrDroppedCarStates++;return;}
     original(event);
    };
    session.socket.on('cmr2_event',session.onEvent);
    setTimeout(()=>window.cmrDropCarState=false,6000);
   });
   const initialCars=await Promise.all(frames.map(f=>f.evaluate(()=>Module.cmr2Cars)));
   await frames[0].locator('#canvas').focus();await pages[0].keyboard.down('ArrowUp');
   await p.waitForTimeout(8000);
   // Native frame boundaries, not animation callbacks, measure actual presentation.
   await Promise.all(frames.map(f=>f.evaluate(()=>{
    window.qualityTimes=[];window.qualityStart={frame:Module.cmr2Frames,time:performance.now()};
    const original=Module.cmr2ProfileFrame;
    Module.cmr2ProfileFrame=phase=>{original?.(phase);if(phase===3)qualityTimes.push(performance.now());};
   })));
   await pages[1].evaluate(()=>{
    const session=retroNetplay,original=session.onEvent;window.qualityDropped=0;window.qualityDelayed=0;let n=0;
    session.socket.off('cmr2_event',original);
    session.onEvent=event=>{
     if(!event.type&&event.reliable===false&&new Uint8Array(event.payload||[])[0]===11){
      if(++n%4===0){qualityDropped++;return;}
      qualityDelayed++;setTimeout(()=>original(event),50+(n%5)*25);return;
     }
     original(event);
    };session.socket.on('cmr2_event',session.onEvent);
   });
   await p.waitForTimeout(30000);await pages[0].keyboard.up('ArrowUp');driven=true;
   for(const f of frames) quality.push(await f.evaluate(()=>{
    const gaps=qualityTimes.slice(1).map((t,i)=>t-qualityTimes[i]).sort((a,b)=>a-b);
    return {fps:(Module.cmr2Frames-qualityStart.frame)*1000/(performance.now()-qualityStart.time),
     p95Ms:gaps[Math.floor(gaps.length*.95)],p99Ms:gaps[Math.floor(gaps.length*.99)],maxMs:gaps.at(-1),
     queue:Module.cmr2Transport.queue.length,running:Module.cmr2Transport.running,failed:Module.cmr2Transport.failed};
   }));
   console.log('MULTIPLAYER_QUALITY',JSON.stringify(quality));
   assert(quality.every(peer=>peer.running&&!peer.failed&&peer.queue<2048),JSON.stringify(quality));
   assert(await pages[1].evaluate(()=>qualityDropped>20&&qualityDelayed>60));
   const movement=await Promise.all(frames.map(f=>f.evaluate(()=>({state:Module.cmr2State,cars:Module.cmr2Cars}))));console.log('MOVEMENT',JSON.stringify(movement));
   assert(movement.every((s,i)=>s.cars?.some((c,j)=>c.speed>0||Math.abs(c.x-initialCars[i][j].x)+Math.abs(c.z-initialCars[i][j].z)>100000)), 'Every browser must observe car movement');
   assert(await pages[1].evaluate(()=>cmrDroppedCarStates>20),'Loss recovery must exercise missing car snapshots');
   const captures=await Promise.all(frames.map(f=>f.evaluate(()=>cmrCaptureCount)));
   assert(await pages[0].evaluate(()=>retroNetplay.spectatorPublisher.live()),'Coordinator must publish spectator video');
   assert.equal(captures[1],0,'Other racers must not encode discarded spectator video');
   await pages[count].waitForFunction(()=>{const v=document.querySelector('#retro-spectator-video');return v?.videoWidth>0&&v.getVideoPlaybackQuality().totalVideoFrames>=80;},null,{timeout:60000});
   const audio=await pages[count].evaluate(async()=>{const stats=await retroNetplay.receiver.peer.pc.getStats();return [...stats.values()].filter(s=>s.type==='inbound-rtp'&&(s.kind==='audio'||s.mediaType==='audio')).reduce((n,s)=>n+(s.bytesReceived||0),0);});
   assert(audio>0,'Spectator must receive audio packets');

   await contexts[0].close();left=true;await pages[1].waitForTimeout(5000);
   console.log('SURVIVOR',await frames[1].evaluate(()=>({state:Module.cmr2State,cars:Module.cmr2Cars,coordinator:Module.cmr2Transport.coordinator,running:Module.cmr2Transport.running})));
   await pages[1].evaluate(()=>{window.cmrPadReads=0;window.originalCMRReadPad=peakCMR2Bridge.readPad;peakCMR2Bridge.readPad=()=>{cmrPadReads++;return {buttons:0x8000,x:0,y:0};};});await pages[1].waitForTimeout(5000);await pages[1].evaluate(()=>peakCMR2Bridge.readPad=originalCMRReadPad);
   const padReads=await pages[1].evaluate(()=>cmrPadReads);
   assert(padReads>80,'Native controller reads must not be limited to the 10 Hz UI timer: '+padReads);
   assert(await pages[1].evaluate(()=>retroNetplay.spectatorPublisher.live()),'Spectator publication must follow coordinator migration');
   await pages[count].waitForFunction(()=>retroNetplay.receiver?.peer?.pc.connectionState==='connected'&&performance.now()-retroNetplay.receiver.lastFrame<2000,null,{timeout:30000});
   console.log('INPUT_AND_CAPTURE',JSON.stringify({padReads,captures}));
   const survivor=await frames[1].evaluate(()=>({state:Module.cmr2State,cars:Module.cmr2Cars,coordinator:Module.cmr2Transport.coordinator,running:Module.cmr2Transport.running}));console.log('SURVIVOR_DRIVE',survivor);assert.equal(survivor.coordinator,1);assert.equal(survivor.running,true);assert(survivor.cars[0].speed>0,'Mapped controller must accelerate the remaining local car');
   for(const frame of frames.slice(1))assert(await frame.evaluate(()=>Module.cmr2Transport.running&&!Module.cmr2Transport.failed));
   break;
  }
  if(!started&&states.every(s=>s.state?.menu===62)){
   await frames[0].evaluate(()=>Module.cmr2MenuRequest={menu:Module.cmr2State.menu,index:3});await frames[0].locator('#canvas').focus();await p.keyboard.down('Enter');await p.waitForTimeout(250);await p.keyboard.up('Enter');started=true;
  }
  if(states.every(s=>s.state?.mode===2))for(let j=0;j<count;j++){await frames[j].evaluate(()=>Module.cmr2MenuRequest={menu:Module.cmr2State.menu,index:3});await frames[j].locator('#canvas').focus();await pages[j].keyboard.down('Enter');await p.waitForTimeout(160);await pages[j].keyboard.up('Enter');}
 }
 await pages[1].screenshot({path:'.tmp/opencmr2/accept-survivor.png'});
 if(!driven||!left)throw new Error("Acceptance did not reach driving and creator departure");assert.deepEqual(errors,[]);
 const fs=require('node:fs');fs.mkdirSync('.tmp/cmr2-audit',{recursive:true});
 fs.writeFileSync('.tmp/cmr2-audit/multiplayer-'+count+'.json',JSON.stringify({players:count,meets30fps:quality.every(p=>p.fps>=30&&p.p95Ms<70),quality,hostDisconnectSurvived:true,carLossMs:6000,delayMs:[50,150],dropEvery:4},null,2));
 console.log('PASS CMR2 '+count+' racers connectivity: measured driving FPS, 6-second snapshot loss, 50–150 ms delay/25% loss, actual host disconnect, coordinator migration and spectator continuation.');

 assert(quality.every(p=>p.fps>=30&&p.p95Ms<70),'Connectivity passed, but the shared-host 30 FPS target failed: '+JSON.stringify(quality));
 } finally {await b.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
