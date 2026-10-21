/* Real Smash WASM through the shared host and Socket.IO relay. Run the isolated
 * retro_test.py --serve --smash fixture after ports/smash64/stage_fixture.py. */
const {chromium,firefox}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const playerCount=process.env.SMASH_SOLO ? 1 : Number(process.env.SMASH_PLAYERS || 2);
assert.ok([1,2,3,4].includes(playerCount));

const fullIntro=!!process.env.SMASH_FULL_INTRO;
const scenario=process.env.SMASH_SCENARIO || 'stock';
assert.ok(['stock','quit','teams','timed','sudden','rules'].includes(scenario));
const nativeFlow=!!process.env.SMASH_NATIVE_FLOW || !!process.env.SMASH_SCENARIO;
const pauseSlot=Number(process.env.SMASH_PAUSE_SLOT || 0);
assert.ok(Number.isInteger(pauseSlot) && pauseSlot>=0 && pauseSlot<playerCount);
const delayMs=Number(process.env.SMASH_DELAY_MS ?? 85), jitterMs=Number(process.env.SMASH_JITTER_MS || 0), burstMs=Number(process.env.SMASH_BURST_MS || 0);
for(const n of [delayMs,jitterMs,burstMs])assert.ok(Number.isFinite(n) && n>=0 && n<=5000);
const minMatches=Number(process.env.SMASH_MIN_MATCHES || (['timed','sudden'].includes(scenario)?1:2));
const reportPath=process.env.SMASH_REPORT;
const reports=[];
const trace=!!process.env.SMASH_TRACE;
const rtcRecovery=!!process.env.SMASH_RTC_RECOVERY;
const dropEvery=Number(process.env.SMASH_DROP_EVERY || 0);
assert.ok(Number.isInteger(dropEvery) && (dropEvery===0 || dropEvery>=2));
const cpuRate=Number(process.env.SMASH_CPU_RATE || 1);
assert.ok(Number.isFinite(cpuRate) && cpuRate>=1 && cpuRate<=8);
if(rtcRecovery)assert.ok(playerCount>1,'RTC recovery needs two or more players');
const baseUrl=process.env.SMASH_URL || 'http://127.0.0.1:8066';
assert.equal(new URL(baseUrl).hostname,'127.0.0.1','Gameplay fixtures must remain on loopback');
const frameLimit=Number(process.env.SMASH_FRAMES || (nativeFlow ? 3600 : fullIntro ? 5400 : 1500));
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE || undefined,args:['--enable-unsafe-swiftshader','--autoplay-policy=no-user-gesture-required']});
 const browsers=[browser];
 const pages=[],errors=[];
 try {
 const alternate=process.env.SMASH_MIXED_BROWSERS ? await firefox.launch({headless:true,
  executablePath:process.env.FIREFOX_EXECUTABLE || undefined,
  firefoxUserPrefs:{'webgl.force-enabled':true,'gfx.webrender.software':true}}) : browser;
 if(alternate!==browser)browsers.push(alternate);
 for(let slot=0;slot<playerCount+1;slot++) {
  const context=await (slot<playerCount && slot%2 ? alternate : browser).newContext(),page=await context.newPage();pages.push(page);
  if(slot===0 && cpuRate>1){const cdp=await context.newCDPSession(page);await cdp.send('Emulation.setCPUThrottlingRate',{rate:cpuRate});}
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(m.text().startsWith('SMASH scene'))console.log(slot,m.text());});
  await page.goto(baseUrl+'/test-login/smash-'+slot,{timeout:90000});
  await page.waitForFunction(()=>PeakNet.adapters.has('smash64'));
  await page.evaluate(({slot,frameLimit,fullIntro,nativeFlow,scenario,delayMs,jitterMs,burstMs,pauseSlot,trace,rtcRecovery,dropEvery})=>{
   const host=PeakNet.adapters.get('smash64'),launch=host.launch;
   host.launch=async options=>{
    const session=options.session,bind=session.bind.bind(session);
    if(dropEvery && session.inputTransport){
     const transport=session.inputTransport,receivePacket=transport.receivePacket.bind(transport);
     let packets=0;window.smashDroppedPackets=0;
     transport.receivePacket=(peer,data)=>{if(++packets%dropEvery===0){++window.smashDroppedPackets;return;}receivePacket(peer,data);};
    }
    session.socket.on('lobby_returned', room=>{
     if(room.interruption?.epoch===session.epoch)
      window.smashFailure='Match returned to lobby: '+JSON.stringify(room.interruption);
    });
    const fail=session.fail.bind(session);session.fail=message=>{window.smashFailure=String(message);return fail(message);};
    session.bind=adapter=>{
     window.smashMetrics={start:0,end:0,attempts:0,stalls:0,inputLatency:[],checkpoints:[],battles:[],sudden:false,resets:0,phases:{}};
     // Rendering opportunities and simulation progression are separate clocks.
     const display=smashMetrics.display={callbacks:0,changedFrames:0,gaps:[],memory:[]};
     let displayAt=0,lastDisplayFrame=0;
     const displayTick=now=>{
      if(session.failed || session.frame>frameLimit)return;
      if(displayAt)display.gaps.push(now-displayAt);
      displayAt=now;++display.callbacks;
      if(session.frame!==lastDisplayFrame){++display.changedFrames;lastDisplayFrame=session.frame;}
      if(display.callbacks%600===0){const w=document.querySelector('#smash64-play-area iframe')?.contentWindow;
       display.memory.push({frame:session.frame,heap:w?.HEAPU8?.buffer.byteLength || null,allocated:window.smashReadDiagnostics?.().allocated});}
      requestAnimationFrame(displayTick);
     };
     requestAnimationFrame(displayTick);
     let phaseClock=null;
     // Charge wall time between attempts as well as successful updates: waiting
     // for remote input is precisely what a frame-only timing sample misses.
     window.smashAccountPhase=()=>{
      const now=performance.now(),m=smashMetrics;
      if(phaseClock)m.phases[phaseClock.key].elapsedMs+=now-phaseClock.time;
      else m.start=now;
      const module=document.querySelector('#smash64-play-area iframe').contentWindow.Module;
      const scene=module._peak_rb_scene(),status=module._peak_rb_status();
      const key=scene===22?'battle-status-'+status:'scene-'+scene;
      m.phases[key]||={scene,status:scene===22?status:null,elapsedMs:0,frames:0,attempts:0,stalls:{}};
      phaseClock={key,time:now};
      return m.phases[key];
     };
     const sampledAt=new Map();
     const queue=adapter.queueFrame;
     adapter.queueFrame=next=>{
      const when=sampledAt.get(next.frame);
      if(when!==undefined){smashMetrics.inputLatency.push(performance.now()-when);sampledAt.delete(next.frame);}
      return queue(next);
     };
     window.smashScenes=[]; window.smashBattleVisits=0; window.smashStatuses=[];
     window.smashTrace={};
     const hash=adapter.hashState;
     let observedScene, observedSince=0;
     window.smashReadDiagnostics=()=>{
      const w=document.querySelector('#smash64-play-area iframe').contentWindow;
      if(!w.Module._peak_native_diagnostics)throw Error('Rebuild Smash for native-flow diagnostics.');
      const p=w.Module._peak_native_diagnostics()>>>2;
      const [scene,status,sudden,rules,stocks,minutes,timer,teams,allocated,cpu,reset,stage]=Array.from(w.HEAPU32.subarray(p,p+12));
      return {scene,status,sudden,rules,stocks,minutes,timer,teams,allocated,cpu,reset,stage,memory:w.HEAPU8.buffer.byteLength};
     };
     // Scene/status coverage must not depend on production checksum cadence.
     const observeFrame=()=>{
      const scene=document.querySelector('#smash64-play-area iframe').contentWindow.Module._peak_rb_scene();
      if(smashScenes.at(-1)!==scene){smashScenes.push(scene);console.log('SMASH scene',scene,'frame',session.frame);if(scene===22)++window.smashBattleVisits;}
     const status=document.querySelector('#smash64-play-area iframe').contentWindow.Module._peak_rb_status();
     if(smashStatuses.at(-1)!==status)smashStatuses.push(status);
      if(rtcRecovery && slot===0 && !smashMetrics.rtcFailureFrame && scene===22 && status===1 && session.frame>300){
       const channel=session.inputTransport?.peers.get(1)?.channel;
       if(channel?.readyState==='open'){
        smashMetrics.rtcFailureFrame=session.frame;
        channel.close(); // Real channel failure during battle; relay stays active.
       }
      }
      if(nativeFlow){
       const d=smashReadDiagnostics();
       if(observedScene!==scene){observedScene=scene;observedSince=session.frame;}
       if(scene===22 && session.frame-observedSince===300){smashMetrics.battles.push({...d,frame:session.frame});smashMetrics.checkpoints.push(d.allocated);}
       if(d.sudden)smashMetrics.sudden=true;
       if(scene===24 && d.reset)smashMetrics.resets++;
      }
      if(!smashMetrics.start)smashMetrics.start=performance.now();
      smashMetrics.end=performance.now();
     };
     const complete=session.completeAdvance.bind(session);
     session.completeAdvance=()=>{
      const phase=smashAccountPhase(),advanced=complete();
      if(advanced){++phase.frames;observeFrame();}
      smashAccountPhase();
      return advanced;
     };
     adapter.hashState=()=>{
      const value=hash();
      if(trace){
       const w=document.querySelector('#smash64-play-area iframe').contentWindow,m=w.Module;
       const p=m._peak_rb_digest()>>>2,d=Array.from(w.HEAPU32.subarray(p,p+60));
       const q=m._peak_rb_fighter_details()>>>2;d.push(...w.HEAPU32.subarray(q,q+64));
       smashTrace[d[0]]={hash:value,digest:d};
       for(const f of Object.keys(smashTrace))if(Number(f)<d[0]-240)delete smashTrace[f];
      }
      return value;
     };
     let inputScene, sceneFrame=0;
     adapter.sampleInput=({frame}={})=>{
      const f=session.frame; sampledAt.set(frame ?? f+session.delay,performance.now());
      const scene=document.querySelector('#smash64-play-area iframe').contentWindow.Module._peak_rb_scene();
      if(scene!==inputScene){inputScene=scene;sceneFrame=f;}
      const age=f-sceneFrame, tap=(at)=>age>=at && age<at+3;
      if(slot===0 && scene===28 && !fullIntro && tap(60))return {buttons:4096,x:0,y:0};
      if(slot===0 && scene===1 && (tap(90) || tap(210)))return {buttons:4096,x:0,y:0};
      if(slot===0 && scene===7 && tap(30))return {buttons:0,x:0,y:-80};
      if(slot===0 && scene===7 && tap(60))return {buttons:32768,x:0,y:0};
      if(nativeFlow && slot===0 && scene===9) {
       // All rule edits use the original menu, never direct state writes.
       const timed=['timed','sudden'].includes(scenario);
       const editingAgain=scenario==='rules' && smashScenes.filter(s=>s===9).length>=2;
       if(tap(30))return {buttons:0,x:0,y:-80};
       if(timed && tap(60))return {buttons:0,x:-80,y:0};
       if(scenario==='teams' && (tap(60)||tap(90)))return {buttons:0,x:80,y:0};
       if(tap(120))return {buttons:0,x:0,y:-80};
       if(timed && tap(150))return {buttons:0,x:80,y:0}; // infinite -> one minute
       if(editingAgain && tap(150))return {buttons:0,x:80,y:0};
       if(!timed && !editingAgain && (tap(150)||tap(180)||tap(210)||tap(240)))return {buttons:0,x:-80,y:0};
       if(tap(270)||tap(300))return {buttons:0,x:0,y:80};
       if(tap(330))return {buttons:32768,x:0,y:0};
      }
      if(!nativeFlow && slot===0 && scene===9 && tap(40))return {buttons:32768,x:0,y:0};
      if(scenario==='rules' && scene===16 && smashBattleVisits===1 && smashScenes.filter(s=>s===9).length<2){
       if(slot===0 && (tap(30)||(age>=70 && age<130)))return {buttons:16384,x:0,y:0};
       return {buttons:0,x:0,y:0};
      }
      if(scene===16 && (!nativeFlow || !smashBattleVisits || (scenario==='rules' && slot===0 && smashBattleVisits===1 && smashScenes.filter(s=>s===9).length>=2)) && age>=30 && age<58)return {buttons:0,x:0,y:80};
      if(scene===16 && (!nativeFlow || !smashBattleVisits || (scenario==='rules' && slot===0 && smashBattleVisits===1 && smashScenes.filter(s=>s===9).length>=2)) && tap(70))return {buttons:32768,x:0,y:0};
      if(slot===0 && scene===16 && tap(100))return {buttons:4096,x:0,y:0};
      if(slot===0 && scene===21){
       if(scenario==='rules' && smashBattleVisits && tap(30))return {buttons:0,x:80,y:0};
       if(scenario==='sudden'){
        if(tap(30))return {buttons:0,x:0,y:-80};
        if(tap(60)||tap(90))return {buttons:0,x:80,y:0};
        if(tap(150))return {buttons:32768,x:0,y:0};
       }else if(tap(60))return {buttons:32768,x:0,y:0};
      }
      if(nativeFlow && slot===0 && scene===24 && age>240 && age%60<3)return {buttons:4096,x:0,y:0};
      if(nativeFlow && scene===22) {
       const d=smashReadDiagnostics();
       if(scenario==='sudden' && !d.sudden)return {buttons:0,x:0,y:0};
       if(scenario==='quit'){
        if(slot===pauseSlot && tap(400))return {buttons:4096,x:0,y:0};
        if(slot===pauseSlot && tap(440))return {buttons:0xe010,x:0,y:0}; // native A+B+Z+R abort
        return {buttons:0,x:0,y:0};
       }
       // Native pause/resume, then finish by walking the remote fighter off stage.
       if(slot===pauseSlot && (tap(400) || tap(440)))return {buttons:4096,x:0,y:0};
       if((slot>0 || (session.players===1 && slot===0)) && age>500)return {buttons:0,x:age%24<12?-80:-79,y:0};
       return {buttons:0,x:0,y:0};
      }
      if(scene===22 && age>150)return {buttons:f%60<10?32768:0,x:(f+slot*30)%120<60?45:-45,y:0};
      return {buttons:0,x:0,y:0};
     };
     bind(adapter);
    };
    const begin=session.beginAdvance.bind(session);
    session.beginAdvance=()=>{
     if(session.frame<=frameLimit){
      const phase=window.smashAccountPhase?.();
      if(phase)++phase.attempts;
      if(window.smashMetrics)++smashMetrics.attempts;
      const pending=begin();
      if(!pending && window.smashMetrics){
       ++smashMetrics.stalls;
       if(phase){const reason=session.engine?.lastStallReason||'other';phase.stalls[reason]=(phase.stalls[reason]||0)+1;}
      }
      return pending;
     }
     session.engine.reconcile();session.publishHashes();return false;
    };
    const receive=session.receiveInput.bind(session),rows=session.receive.bind(session);
    let deliveryAt=0;
    const deliver=(fn,e)=>{
     // Preserve reliable transport order, including burst-induced head-of-line blocking.
     const extra=slot===0?delayMs+(e.frame*17%31)/30*jitterMs+(e.frame%240===0?burstMs:0):0;
     deliveryAt=Math.max(deliveryAt,performance.now()+extra);
     if(extra===0 && deliveryAt<=performance.now())return fn(e);
     setTimeout(()=>fn(e),Math.max(0,deliveryAt-performance.now()));
    };
    session.receiveInput=e=>deliver(receive,e);
    session.receive=e=>deliver(rows,e);
    return launch(options);
   };
  },{slot,frameLimit,fullIntro,nativeFlow,scenario,delayMs,jitterMs,burstMs,pauseSlot,trace,rtcRecovery,dropEvery});
 }
 const host=pages[0],watcher=pages.at(-1),simulations=pages.slice(0,playerCount);
 await host.locator('#retro-open-create').click();
 await host.locator('#retro-game-select').selectOption('smash64');
 assert.equal(await host.locator('#retro-match-settings select').count(),0);
 await host.locator('#retro-room-name').fill('Smash integration');
 await host.locator('#retro-room-create').click();
 await host.locator('#retro-lobby').waitFor();
 for(const page of pages.slice(1))await page.getByRole('button',{name:'Join room',exact:true}).click();
 for(const page of pages.slice(1,playerCount))await page.locator('#retro-choose-player').click();
 for(const page of pages.slice(0,playerCount))await page.locator('#retro-ready').click();
 await host.locator('#retro-start-race').click();
 for(let epoch=0;epoch<Number(process.env.SMASH_EPOCHS || (fullIntro?1:2));epoch++) {
 if(epoch)await host.locator('#smash64-play-area [data-game-restart]').click();
 await Promise.all(simulations.map(p=>p.waitForFunction(epoch=>window.retroNetplay?.epoch===epoch,epoch,{timeout:30000})));
 await watcher.evaluate(()=>{
  const video=document.getElementById('retro-spectator-video');
  window.smashVideo={count:0,first:0,last:0,gaps:[],width:0,height:0};
  const observe=(now,meta)=>{
   const v=smashVideo;if(!v.first)v.first=now;
   if(v.last)v.gaps.push(now-v.last);
   v.last=now;++v.count;v.width=meta.width;v.height=meta.height;
   window.smashVideoCallback=video.requestVideoFrameCallback(observe);
  };
  window.smashVideoCallback=video.requestVideoFrameCallback(observe);
 });
 if(!epoch) {
  await host.waitForFunction(()=>window.retroNetplay?.frame>=15 || window.retroNetplay?.failed,null,{timeout:120000});
  await host.locator('#smash64-play-area').screenshot({path:'.tmp/smash-menu.png'});
 }
 if(!epoch && process.env.SMASH_FREEZE_MS){
  const duration=Number(process.env.SMASH_FREEZE_MS);
  assert.ok(duration>0 && duration<=15000);
  const frozen=simulations[0],cdp=await frozen.context().newCDPSession(frozen);
  await frozen.waitForFunction(()=>window.retroNetplay?.frame>=1200);
  const before=await frozen.evaluate(()=>retroNetplay.frame);
  await cdp.send('Debugger.enable');
  const paused=new Promise(resolve=>cdp.once('Debugger.paused',resolve));
  await cdp.send('Debugger.pause');await paused;
  try{
   const peer=simulations[1];
   const peerBefore=peer?await peer.evaluate(()=>retroNetplay.frame):0;
   await new Promise(resolve=>setTimeout(resolve,duration));
   if(peer)assert.ok(await peer.evaluate(()=>retroNetplay.frame)-peerBefore<=32,
    'Other peer must stop at bounded prediction while the renderer is suspended');
  }finally{await cdp.send('Debugger.resume');await cdp.send('Debugger.disable');}
  await frozen.waitForFunction(f=>window.retroNetplay?.frame>f+120,before,{timeout:60000});
  await cdp.detach();
  console.log('PASS: suspended page resumed after',duration,'ms at frame',before);
 }
 await Promise.all(simulations.map(p=>p.waitForFunction(limit=>window.smashFailure || window.retroNetplay?.failed || (window.retroNetplay?.frame===limit+1 && retroNetplay.engine.confirmed>=limit && retroNetplay.engine.dirty===null),frameLimit,{timeout:Number(process.env.SMASH_TIMEOUT_MS || 1200000)})));
 await host.waitForTimeout(500);
 for(const page of simulations) {
  assert.equal(await page.evaluate(()=>window.smashFailure),undefined,await page.evaluate(()=>window.smashFailure));
  if(await page.evaluate(()=>retroNetplay.failed))console.log('Failure details:',await Promise.all(simulations.map(p=>p.evaluate(()=>({frame:retroNetplay.frame,scenes:smashScenes,error:window.smashFailure})))));
  assert.equal(await page.evaluate(()=>retroNetplay.failed),false,await page.locator('#retro-runtime-status').textContent());
  assert.equal(await page.evaluate(()=>retroNetplay.epoch),epoch,'Native rematches must keep the same room epoch');
 }
 const results=await Promise.all(simulations.map(p=>p.evaluate(limit=>{
  const m=document.querySelector('#smash64-play-area iframe').contentWindow.Module;
  // Production hashes only checkpoints. Read the exact final state explicitly
  // so non-checkpoint test lengths cannot pass by comparing undefined values.
  return {build:retroNetplay.game.build,hash:retroNetplay.adapter.hashState(),hashFrame:retroNetplay.frame-1,confirmed:retroNetplay.engine.confirmed,rollbacks:retroNetplay.engine.rollbacks,sent:retroNetplay.sentThrough,
   transport:retroNetplay.inputTransport?.diagnostics?.(),droppedPackets:window.smashDroppedPackets || 0,
   nativeTimings:retroNetplay.adapter.nativeTimings?.(),costs:retroNetplay.diagnostics().costs,
   barriers:m._peak_rb_barrier_count?.()||0,predicted:m._peak_rb_predicted_count?.()||0};
 },frameLimit)));
 for(const result of results){assert.ok(Number.isInteger(result.hash));assert.equal(result.hashFrame,frameLimit);assert.equal(results[0].hash,result.hash);}
 if(process.env.SMASH_REQUIRE_RTC && playerCount>1)for(const result of results.slice(0,playerCount)){
  assert.equal(result.transport?.openPeers,playerCount-1,'Real room signaling must connect every player');
  assert.ok(result.transport.receivedInputs>0,'Actual gameplay inputs must arrive through RTC');
  assert.equal(result.transport.invalidPackets,0,'Gameplay transport packets must remain valid');
 }
 if(rtcRecovery){
  assert.ok(await host.evaluate(()=>smashMetrics.rtcFailureFrame>0),'Close RTC during a real battle');
  for(const result of results.slice(0,2))assert.ok(result.transport.recoveredPeers>0,'Both seats must recover RTC');
 }
 if(dropEvery)assert.ok(results.every(r=>r.droppedPackets>100),'Loss must affect sustained gameplay, not only startup');

 const hybrid=await host.locator('#smash64-play-area iframe').evaluate(e=>!!e.contentWindow.Module.peakHybridRollback);
 if(hybrid && delayMs>0 && playerCount>1)assert.ok(results.some(r=>r.rollbacks>0),'Delayed hybrid battles must exercise real correction');
 else if(!hybrid)assert.ok(results.every(r=>r.rollbacks===0), 'Confirmed native flow must never replay scene updates.');
 await watcher.waitForFunction(()=>window.retroNetplay?.spectator && retroNetplay.frame>3,{}, {timeout:30000});
 assert.equal(await watcher.locator('#retro-spectator-area').isVisible(),true);
 const colors=await watcher.evaluate(()=>{
  const video=document.getElementById('retro-spectator-video');
  const source=retroNetplay.streaming?video:document.getElementById('retro-spectator-canvas');
  const c=document.createElement('canvas');c.width=160;c.height=120;
  const context=c.getContext('2d');context.drawImage(source,0,0,c.width,c.height);
  const p=context.getImageData(0,0,c.width,c.height).data;
  const set=new Set();for(let i=0;i<p.length;i+=64)set.add(p[i]+','+p[i+1]+','+p[i+2]);return set.size;
 });
 assert.ok(colors>10,'Spectator must receive rendered game pixels');
 assert.deepEqual(errors,[]);
 if(!nativeFlow)for(const page of simulations)assert.equal(await page.locator('#smash64-play-area iframe').evaluate(e=>e.contentWindow.Module._peak_rb_in_battle()),1);
 if(nativeFlow) {
  for(const page of simulations) {
   const scenes=await page.evaluate(()=>smashScenes);
   const statuses=await page.evaluate(()=>smashStatuses);
   if(scenario==='quit')assert.ok(statuses.includes(2), 'Native pause must work');
   else if(scenario!=='sudden')assert.ok(statuses.includes(2) && statuses.includes(3), 'Native pause and resume must work: '+statuses);
   assert.ok(scenes.includes(24), 'Native results screen must run: '+scenes);
   assert.ok(scenes.filter(scene=>scene===24).length>=minMatches,'Required completed match count: '+scenes);
   await page.locator('#smash64-play-area').screenshot({path:'.tmp/smash-native-'+pages.indexOf(page)+'.png'});
   assert.ok(await page.evaluate(n=>smashBattleVisits>=n,minMatches), 'Required match count without a website restart: '+scenes);
   assert.equal(await page.locator('[data-game-result]').count(),0);
  }
 } else for(const page of simulations)assert.deepEqual(await page.evaluate(()=>smashScenes),fullIntro ? [27,28,29,30,31,34,32,35,37,33,36,38,40,42,45,39,44,41,43,46,1,7,9,16,21,22] : [27,28,1,7,9,16,21,22], 'Original startup, title, menus and battle must all run.');
 const metrics=await Promise.all(simulations.map(p=>p.evaluate(()=>smashMetrics)));
 for(const m of metrics){
  if(scenario==='rules'){
   assert.equal(m.battles[0].stocks,0);assert.equal(m.battles[1].stocks,1,'Stock rule must change between matches');
   assert.notEqual(m.battles[0].stage,m.battles[1].stage,'Choose a different stage for the rematch');
  }
  if(scenario==='teams')assert.ok(m.battles.every(b=>b.teams===1),'Native teams rule must be enabled');
  if(['timed','sudden'].includes(scenario))assert.ok(m.battles.some(b=>b.rules===1 && b.minutes===1),'Native one-minute timer must be selected');
  if(scenario==='sudden')assert.equal(m.sudden,true,'Tied timed match must enter sudden death');
  if(scenario==='timed')assert.equal(m.sudden,false,'Non-tied timed match must finish normally');
  if(scenario==='quit')assert.ok(m.resets>0,'Native pause-menu quit must produce no-contest results');
  if(playerCount===1 && nativeFlow)assert.ok(m.battles.every(b=>b.cpu===1),'Solo must retain its CPU opponent');
  if(m.checkpoints.length>=5){
   const warm=m.checkpoints.slice(2);
   assert.ok(Math.max(...warm)-Math.min(...warm)<8*1024*1024,'Live allocations must stabilize across repeated battles: '+warm);
  }
 }
 const percentile=(a,p)=>a.length?[...a].sort((a,b)=>a-b)[Math.floor((a.length-1)*p)]:null;
 const video=await watcher.evaluate(async()=>{
  document.getElementById('retro-spectator-video').cancelVideoFrameCallback(smashVideoCallback);
  const reports=await window.retroNetplay?.receiver?.peer?.pc?.getStats();
  return {...smashVideo,transport:reports?[...reports.values()].filter(s=>s.type==='inbound-rtp' && s.kind==='video')
   .map(s=>({decoded:s.framesDecoded,dropped:s.framesDropped,fps:s.framesPerSecond,width:s.frameWidth,height:s.frameHeight})):[]};
 });
 const inputDelay=await host.evaluate(()=>retroNetplay.delay);
 const confirmedInputDelay=await host.evaluate(()=>retroNetplay.confirmedDelay);
 const summary={scenario,playerCount,epoch,frameLimit,delayMs,jitterMs,burstMs,inputDelay,confirmedInputDelay,rtcRecovery,dropEvery,cpuRate,
  browsers:browsers.map(b=>({engine:b.browserType().name(),version:b.version()})),freezeMs:Number(process.env.SMASH_FREEZE_MS || 0),results,clients:metrics.map(m=>({
  elapsedMs:m.end-m.start,fps:frameLimit*1000/(m.end-m.start),stallRatio:m.stalls/Math.max(1,m.attempts),
  inputMs:{median:percentile(m.inputLatency,.5),p95:percentile(m.inputLatency,.95)},
  display:{callbacks:m.display.callbacks,changedFrames:m.display.changedFrames,
   callbackFps:m.display.callbacks*1000/(m.end-m.start),progressFps:m.display.changedFrames*1000/(m.end-m.start),
   gapMs:{median:percentile(m.display.gaps,.5),p95:percentile(m.display.gaps,.95),p99:percentile(m.display.gaps,.99),max:Math.max(0,...m.display.gaps)},memory:m.display.memory},
  phases:Object.fromEntries(Object.entries(m.phases).map(([key,p])=>[key,{...p,fps:p.elapsedMs?p.frames*1000/p.elapsedMs:null}])),
  battles:m.battles,sudden:m.sudden,nativeQuit:m.resets>0,rtcFailureFrame:m.rtcFailureFrame||null
 })),spectatorVideo:{frames:video.count,fps:(video.count-1)*1000/(video.last-video.first),width:video.width,height:video.height,
  gapMs:{median:percentile(video.gaps,.5),p95:percentile(video.gaps,.95),p99:percentile(video.gaps,.99)},transport:video.transport}};
 reports.push(summary);
 if(reportPath)fs.writeFileSync(reportPath,JSON.stringify(reports,null,2));
 console.log('Smash metrics',JSON.stringify(summary));
 console.log('Smash WASM + shared lobby + real relay: '+frameLimit+' frames, '+playerCount+' players matched and spectator stream active, epoch '+epoch,results);
 }
 if(process.env.SMASH_SCREENSHOT){
  await host.locator('#smash64-play-area').scrollIntoViewIfNeeded();
  await host.locator('#smash64-play-area').screenshot({path:'.tmp/smash-netplay.png',timeout:15000});
 }
 }catch(error){
  if(trace)fs.writeFileSync('.tmp/smash-trace-'+scenario+'.json',JSON.stringify(await Promise.all(pages.slice(0,playerCount).map(p=>p.evaluate(()=>window.smashTrace).catch(()=>null)))));
  console.error('Scenario failure diagnostics',JSON.stringify(await Promise.all(pages.slice(0,playerCount).map(p=>p.evaluate(()=>({
   frame:window.retroNetplay?.frame,scenes:window.smashScenes,statuses:window.smashStatuses,
   current:document.querySelector('#smash64-play-area iframe')?window.smashReadDiagnostics?.():null,metrics:window.smashMetrics?{...smashMetrics,inputLatency:undefined,display:{...smashMetrics.display,gaps:undefined}}:null,error:window.smashFailure
  })).catch(e=>({error:String(e)}))))));
  if(pages[0])await pages[0].screenshot({path:'.tmp/smash-failure-'+scenario+'.png',timeout:5000}).catch(()=>{});
  throw error;
 }finally {await Promise.all(browsers.map(b=>b.close()));}
})().catch(e=>{console.error(e);process.exitCode=1;});
