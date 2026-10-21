/* Real native menus, results and rematches. Isolated --perfectdark fixture.
 * All mutations use controller commands; no startCombat or memory injection. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {createHash}=require('node:crypto');
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const withReplay=process.argv.includes('--replay');
const url=process.env.PD_TEST_URL || 'http://127.0.0.1:8066';
const withoutPresentation=process.argv.includes('--no-present');
const output='.tmp/perfectdark/'+(withoutPresentation?'flow-no-present':'flow');
fs.mkdirSync(output,{recursive:true});
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:{})});
 const pages=[],errors=[],checkpoints=[],trace=[];
 try{
  async function launchEngine(i){
   const page=await browser.newPage();pages.push(page);
   page.on('pageerror',e=>errors.push(e.message));
   await page.addInitScript(()=>window.peakPdLaunchOptions={controlled:true,players:2,seed:12345});
   await page.request.get(url+'/test-login/pd-flow-'+i);
   await page.goto(url+'/games/retro/preview/perfectdark');
   await page.locator('#start').click();
   await page.waitForFunction(()=>window.peakPdEngine||window.peakPdError,null,{timeout:120000});
   assert.equal(await page.evaluate(()=>window.peakPdError||null),null);
   if(i>0 && withoutPresentation)await page.evaluate(()=>peakPdEngine.setPresentation(false));
   await page.evaluate(()=>{
    // Keep identities to prove that stage transitions never replace the engine.
    window.flowOriginalModule=Module;window.flowOriginalEngine=peakPdEngine;
    window.flowAdvance=(count,slot,buttons,x,y)=>{
     for(let i=0;i<count;i++){
      peakPdEngine.step([0,1].map(s=>({buttons:s===slot?buttons:0,moveX:s===slot?x:0,moveY:s===slot?y:0,lookX:0,lookY:0})));
      peakPdEngine.drainEvents();
     }
     return {state:peakPdEngine.observe(),flow:peakPdEngine.observeFlow(),epoch:peakPdEngine.captureEntities().meta.epoch,
      components:peakPdEngine.captureComponents(),random:Array.from({length:4},(_,n)=>Module._peakPdRandomWord(n))};
    };
   });
  }
  for(let i=0;i<2;i++)await launchEngine(i);
  const startedAt=Date.now();
  let current;
  async function advance(count,slot=0,buttons=0,x=0,y=0){
   const values=await Promise.all(pages.map(p=>p.evaluate(args=>flowAdvance(...args),[count,slot,buttons,x,y])));
   assert.deepEqual(values[0],values[1],'Independent native flow/state must match');
   trace.push({commands:[count,slot,buttons,x,y],hash:digest(values[0])});
   const {components,random,...observation}=values[0];current=observation;return current;
  }
  async function press(buttons=0,x=0,y=0,slot=0,settle=30){await advance(1,slot,buttons,x,y);return advance(settle);}
  async function down(count=1,slot=0){for(let i=0;i<count;i++)await press(0,0,-127,slot,15);}
  async function checkpoint(name){
   assert.deepEqual(errors,[]);checkpoints.push({name,...current});
   await pages[0].locator('#canvas').screenshot({path:output+'/'+name+'.png'});
   fs.writeFileSync(output+'/report.json',JSON.stringify(checkpoints,null,2));
   console.log(name,JSON.stringify(current));
  }
  await advance(601);
  await advance(20,0,128);await advance(100);
  await advance(20,0,128);await advance(200);
  await advance(20,0,128);await advance(120);
  assert.equal(current.flow.menus[0].title,'Perfect Dark');
  await press(256); // New agent, original name keyboard.
  assert.equal(current.flow.menus[0].title,'Enter Agent Name');
  await press(128,0,0,0,60); // Native keyboard's default-name confirmation.
  assert.equal(current.flow.menus[0].title,'Select Location');
  assert.ok(current.flow.saveSpaces>0);
  assert.equal(current.flow.menus[0].focused,2,'Game Pak must be visible/focusable (WASM callback table regression)');
  await checkpoint('save-location');
  await press(256,0,0,0,120); // Save to the in-memory game pak.
  await press(256,0,0,0,120); // Load the new agent.
  assert.equal(current.flow.menus[0].title,'Perfect Menu');
  await down(2);await press(256,0,0,0,90);
  assert.equal(current.flow.menus[0].title,'Combat Simulator');
  await down(3);await press(256,0,0,0,60); // Advanced Setup.
  await press(128,0,0,1,60); // Second controller joins through the game.
  assert.equal(current.flow.seats&15,3);
  assert.ok(current.flow.menus.every(m=>m.title==='Game Setup'));
  await down(4);await press(256,0,0,0,45); // Limits.
  assert.equal(current.flow.menus[0].title,'Limits');
  await press(256,0,0,0,20);await advance(120,0,0,-127);await advance(15);await press(256,0,0,0,20);
  assert.equal(current.flow.timeLimit,0,'Original one-minute limit');
  await press(512);await checkpoint('native-setup');
  for(let match=1;match<=2;match++){
   await press(128,0,0,0,45);await press(128,0,0,1,160);
   assert.equal(current.flow.multiplayer,true);assert.equal(current.flow.root,0);
   assert.ok(current.state.players.every(p=>p.health>0));
   await checkpoint('match-'+match);
   await press(128,0,0,1,60);
   assert.equal(current.flow.root,4);assert.ok(current.flow.menus[1].depth>0);
   await press(0,127,0,1); // Native pause-menu sibling navigation.
   await press(128,0,0,1);
   assert.equal(current.flow.menus[1].depth,0);
   for(let n=0;n<42 && current.flow.root!==5;n++)await advance(100);
   assert.equal(current.flow.root,5,'Time limit must reach native results');
   await checkpoint('results-'+match);
   for(let slot=0;slot<2;slot++)if(current.flow.menus[slot].title==='Save Player')await press(512,0,0,slot);
   assert.ok(current.flow.menus.every(m=>m.title==='Game Over'));
   await checkpoint('game-over-'+match);
   await press(128,0,0,0,60);await press(128,0,0,1,120);
   assert.equal(current.flow.root,3,'Return to native setup without a website restart');
   assert.equal(current.flow.multiplayer,false);
   assert.equal(current.flow.timeLimit,0,'Match settings survive results');
   await checkpoint('return-to-setup-'+match);
   if(match===1){
    const previousArena=current.flow.arena;
    for(let n=0;n<16 && current.flow.menus[0].focused!==2;n++)await down();
    assert.equal(current.flow.menus[0].focused,2);
    await press(256);assert.equal(current.flow.menus[0].title,'Arena');
    await down();await press(256,0,0,0,60);
    assert.notEqual(current.flow.arena,previousArena,'Native arena selection changes the next match');
   }
  }
  for(const page of pages)assert.ok(await page.evaluate(()=>Module===flowOriginalModule&&peakPdEngine===flowOriginalEngine));
  if(withoutPresentation){
   assert.equal(await pages[1].evaluate(()=>peakPdEngine.present()),false);
   await pages[1].evaluate(()=>peakPdEngine.setPresentation(true));
   await advance(1);
   assert.equal(await pages[1].evaluate(()=>peakPdEngine.present()),true);
   await pages[1].locator('#canvas').screenshot({path:output+'/presentation-resumed.png'});
  }
  if(withReplay){
   fs.writeFileSync(output+'/input-trace.json',JSON.stringify({seed:12345,players:2,trace}));
   await launchEngine(2);
   const replayStart=Date.now();
   for(let i=0;i<trace.length;i++){
    const state=await pages[2].evaluate(args=>flowAdvance(...args),trace[i].commands);
    assert.equal(digest(state),trace[i].hash,'Fresh-engine replay diverged at batch '+i);
   }
   console.log('Fresh engine replay matched every recorded batch.',{ticks:current.state.tick,elapsedMs:Date.now()-replayStart});
  }
  assert.deepEqual(errors,[]);
  console.log('Perfect Dark native session flow passed.',{withoutPresentation,elapsedMs:Date.now()-startedAt});
 }catch(error){
  for(let i=0;i<pages.length;i++){
   console.error('Failure state',await pages[i].evaluate(()=>({state:peakPdEngine.observe(),flow:peakPdEngine.observeFlow()})).catch(String));
   await pages[i].screenshot({path:output+'/failure-'+i+'.png'}).catch(()=>{});
  }
  throw error;
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
