/* Real WASM health correction and atomic rejection; not whole-world restore. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:{})});
 const pages=[],errors=[];
 try {
  for(let i=0;i<2;i++){
   const p=await browser.newPage();pages.push(p);p.on('pageerror',e=>errors.push(e.message));
   await p.addInitScript(()=>window.peakPdLaunchOptions={controlled:true,players:2,seed:12345});
   await p.request.get('http://127.0.0.1:8066/test-login/vitals-'+i);
   await p.goto('http://127.0.0.1:8066/games/retro/preview/perfectdark');
   await p.locator('#start').click();
   await p.waitForFunction(()=>window.peakPdEngine||window.peakPdError,null,{timeout:120000});
   assert.equal(await p.evaluate(()=>window.peakPdError||null),null);
   await p.evaluate(()=>{
    const n=window.vitalsNeutral={buttons:0,moveX:0,moveY:0,lookX:0,lookY:0};
    for(let i=0;i<601;i++)peakPdEngine.step([{...n,buttons:i%100===0?128:0},n]);
    peakPdEngine.startCombat(37);
    for(let i=0;i<120;i++)peakPdEngine.step([n,n]);
    peakPdEngine.drainEvents();
   });
  }
  const capture=p=>p.evaluate(()=>peakPdEngine.captureVitalsState());
  const baseline=await capture(pages[0]);
  assert.deepEqual(await capture(pages[1]),baseline);
  await pages[1].evaluate(baseline=>{
   const edited=structuredClone(baseline);
   edited.players[0].vitals[0]=0.5;edited.players[0].vitals[14]=4;
   peakPdEngine.restoreVitalsState(edited);
   if(peakPdEngine.observe().players[0].health!==0.5)throw new Error('Health correction was not applied');
   const after=peakPdEngine.captureVitalsState();
   if(after.players[0].vitals[14]!==4)throw new Error('Shield correction was not applied');
   const before=JSON.stringify(after);
   const invalid=structuredClone(baseline);
   invalid.players[0].vitals[0]=0.75;
   invalid.players[1].vitals[7]=6; // Native indexed health mode must be 0..5.
   let rejected=false;
   try{peakPdEngine.restoreVitalsState(invalid);}catch{rejected=true;}
   if(!rejected||JSON.stringify(peakPdEngine.captureVitalsState())!==before)
    throw new Error('Invalid second-player field changed the first player');
   const lethal=structuredClone(baseline);lethal.players[0].vitals[0]=0;
   rejected=false;try{peakPdEngine.restoreVitalsState(lethal);}catch{rejected=true;}
   if(!rejected||JSON.stringify(peakPdEngine.captureVitalsState())!==before)
    throw new Error('Health-only correction must not invent a death transition');
   peakPdEngine.restoreVitalsState(baseline);
   if(peakPdEngine.drainEvents().length)throw new Error('State restore emitted gameplay effects');
  },baseline);
  assert.deepEqual(await capture(pages[1]),baseline);
  for(let batch=0;batch<10;batch++){
   const states=await Promise.all(pages.map(p=>p.evaluate(()=>{
    for(let i=0;i<10;i++){peakPdEngine.step([vitalsNeutral,vitalsNeutral]);peakPdEngine.drainEvents();}
    return {vitals:peakPdEngine.captureVitalsState(),components:peakPdEngine.captureComponents(),flow:peakPdEngine.observeFlow()};
   })));
   assert.deepEqual(states[0],states[1],'Health correction must preserve subsequent native simulation');
  }
  assert.equal(await pages[1].evaluate(old=>{
   try{peakPdEngine.restoreVitalsState(old);return false;}catch{return true;}
  },baseline),true,'An earlier tick must not masquerade as a health-only world rewind');
  assert.deepEqual(errors,[]);
  console.log('Real WASM: health/shield restoration, atomic rejection, no duplicate effects and 100 subsequent ticks passed.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
