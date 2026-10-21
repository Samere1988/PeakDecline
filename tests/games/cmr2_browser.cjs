const {chromium,firefox}=require(process.env.PLAYWRIGHT_MODULE||require('node:path').join(process.env.HOME,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const assert=require('node:assert/strict');
const path=require('node:path');
(async()=>{
 const engine=process.env.CMR2_MULTIPLAYER_BROWSER||'firefox';
 const b=engine==='firefox'?await firefox.launch({headless:true,executablePath:process.env.FIREFOX_PATH||path.join(process.env.HOME,'.cache/ms-playwright/firefox-1543/firefox/firefox'),firefoxUserPrefs:{'dom.webgpu.enabled':true,'media.autoplay.default':0}}):await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||path.join(process.env.HOME,'.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'),args:['--enable-unsafe-webgpu','--enable-gpu','--disable-gpu-sandbox','--use-angle=gl','--enable-features=Vulkan','--use-vulkan=native','--disable-vulkan-surface','--ignore-gpu-blocklist','--autoplay-policy=no-user-gesture-required','--disable-background-timer-throttling','--disable-renderer-backgrounding']});
 try {
 const contexts=[await b.newContext(),await b.newContext(),await b.newContext()],pages=[];
 for(const context of contexts)await context.addInitScript(()=>{
  window.cmrCaptureCount=0;
  const original=HTMLCanvasElement.prototype.toBlob;
  HTMLCanvasElement.prototype.toBlob=function(...args){cmrCaptureCount++;return original.apply(this,args);};
 });
 for(let i=0;i<3;i++){const p=await contexts[i].newPage();p.on('console',m=>console.log(i,m.type(),m.text()));p.on('pageerror',e=>console.log(i,'ERROR',e.stack));await p.goto('http://127.0.0.1:8088/test-login/cmr-multi-'+i);pages.push(p);}
 const p=pages[0];await p.locator('#retro-open-create').click();await p.locator('#retro-game-select').selectOption('cmr2');await p.locator('#retro-room-name').fill('Two-player rally');await p.locator('#retro-room-create').click();await p.waitForTimeout(500);
 const invite=await p.locator('#retro-invite').inputValue();await pages[1].goto(invite);await pages[1].locator('#retro-choose-player').click();
 await pages[2].goto(invite);await pages[2].locator('#retro-choose-spectator').click();for(const page of pages.slice(0,2))await page.locator('#retro-ready').click();await p.locator('#retro-start-race').click();await p.waitForTimeout(2500);
 const frames=pages.slice(0,2).map(p=>p.frames().find(f=>f.url().includes('/runtime/cmr2')));if(frames.some(f=>!f))throw new Error('Missing frames');
 await pages[2].evaluate(()=>{window.cmrAudioSamples=0;const session=retroNetplay,original=session.media;session.media=event=>{if(event.kind==='audio'&&new Int16Array(event.payload).some(n=>n!==0))cmrAudioSamples++;original?.(event);};});
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
   await frames[0].locator('#canvas').focus();await pages[0].keyboard.down('ArrowUp');
   await p.waitForTimeout(8000);await pages[0].keyboard.up('ArrowUp');driven=true;
   const movement=await Promise.all(frames.map(f=>f.evaluate(()=>({state:Module.cmr2State,cars:Module.cmr2Cars}))));console.log('MOVEMENT',JSON.stringify(movement));
   assert(movement.every(s=>s.cars?.some(c=>c.speed>0)), 'Both browsers must observe the moving car');
   assert(await pages[1].evaluate(()=>cmrDroppedCarStates>20),'Loss recovery must exercise missing car snapshots');
   const captures=await Promise.all(frames.map(f=>f.evaluate(()=>cmrCaptureCount)));
   assert(await pages[0].evaluate(()=>retroNetplay.spectatorPublisher.live()),'Coordinator must publish spectator video');
   assert.equal(captures[1],0,'Other racers must not encode discarded spectator video');
   await pages[2].waitForFunction(()=>{const v=document.querySelector('#retro-spectator-video');return v?.videoWidth>0&&v.getVideoPlaybackQuality().totalVideoFrames>=80;},null,{timeout:60000});
   const audio=await pages[2].evaluate(async()=>{const stats=await retroNetplay.receiver.peer.pc.getStats();return [...stats.values()].filter(s=>s.type==='inbound-rtp'&&(s.kind==='audio'||s.mediaType==='audio')).reduce((n,s)=>n+(s.bytesReceived||0),0);});
   assert(audio>0,'Spectator must receive audio packets');

   await pages[0].locator('#retro-return').click();left=true;await pages[1].waitForTimeout(5000);
   console.log('SURVIVOR',await frames[1].evaluate(()=>({state:Module.cmr2State,cars:Module.cmr2Cars,coordinator:Module.cmr2Transport.coordinator,running:Module.cmr2Transport.running})));
   await pages[1].evaluate(()=>{window.cmrPadReads=0;window.originalCMRReadPad=peakCMR2Bridge.readPad;peakCMR2Bridge.readPad=()=>{cmrPadReads++;return {buttons:0x8000,x:0,y:0};};});await pages[1].waitForTimeout(5000);await pages[1].evaluate(()=>peakCMR2Bridge.readPad=originalCMRReadPad);
   const padReads=await pages[1].evaluate(()=>cmrPadReads);
   assert(padReads>80,'Native controller reads must not be limited to the 10 Hz UI timer: '+padReads);
   assert(await pages[1].evaluate(()=>retroNetplay.spectatorPublisher.live()),'Spectator publication must follow coordinator migration');
   await pages[2].waitForFunction(()=>retroNetplay.receiver?.peer?.pc.connectionState==='connected'&&performance.now()-retroNetplay.receiver.lastFrame<2000,null,{timeout:30000});
   console.log('INPUT_AND_CAPTURE',JSON.stringify({padReads,captures}));
   const survivor=await frames[1].evaluate(()=>({state:Module.cmr2State,cars:Module.cmr2Cars,coordinator:Module.cmr2Transport.coordinator,running:Module.cmr2Transport.running}));console.log('SURVIVOR_DRIVE',survivor);assert.equal(survivor.coordinator,1);assert.equal(survivor.running,true);assert(survivor.cars[0].speed>0,'Mapped controller must accelerate the remaining local car');break;
  }
  if(!started&&states.every(s=>s.state?.menu===62)){
   await frames[0].evaluate(()=>Module.cmr2MenuRequest={menu:Module.cmr2State.menu,index:3});await frames[0].locator('#canvas').focus();await p.keyboard.down('Enter');await p.waitForTimeout(250);await p.keyboard.up('Enter');started=true;
  }
  if(states.every(s=>s.state?.mode===2))for(let j=0;j<2;j++){await frames[j].evaluate(()=>Module.cmr2MenuRequest={menu:Module.cmr2State.menu,index:3});await frames[j].locator('#canvas').focus();await pages[j].keyboard.down('Enter');await p.waitForTimeout(160);await pages[j].keyboard.up('Enter');}
 }
 await pages[1].screenshot({path:'.tmp/opencmr2/accept-survivor.png'});
 if(!driven||!left)throw new Error("Acceptance did not reach driving and creator departure");await require('./cmr2_saves_browser.cjs').check(b);
 console.log('PASS CMR2 native join, remote car movement, spectator video/audio, creator departure, mapped pad, profile restoration and isolation');
 const fs=require('node:fs'),crypto=require('node:crypto'),directory='.tmp/opencmr2/browser-build/game';
 const names=['opencmr2.js','opencmr2.wasm','assets.json','sources.json','LICENSE'];
 const sha256=Object.fromEntries(names.map(name=>[name,crypto.createHash('sha256').update(fs.readFileSync(directory+'/'+name)).digest('hex')]));
 fs.writeFileSync(directory+'/verified.json',JSON.stringify({passed:true,checkedAt:new Date().toISOString(),checks:['native driving','two native players','remote car movement','spectator video/audio','creator departure','mapped controller','native profile restoration','account isolation'],sha256},null,2)+'\n');
 } finally {await b.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
