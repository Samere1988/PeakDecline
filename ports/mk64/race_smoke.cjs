const {chromium}=require(process.env.MK64_PLAYWRIGHT||'C:/Users/Plex/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const output=path.resolve(__dirname,'../../.tmp/mk64');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.MK64_BROWSER||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',args:['--enable-unsafe-swiftshader']});
 const logs=[],errors=[];
 try{
  const page=await browser.newPage();page.setDefaultTimeout(5000);
  if(process.env.MK64_ASSET_TOUR||process.env.MK64_SHELL_PALETTE_CHECK) await page.addInitScript(()=>{
   for(const name of ['instantiate','instantiateStreaming']) {
    const original=WebAssembly[name];
    WebAssembly[name]=async function(...args){const result=await original.apply(this,args);window.testMemory=(result.instance||result).exports.memory;return result;};
   }
  });
  page.on('console',m=>logs.push(m.text()));
  page.on('pageerror',e=>{logs.push(e.stack);errors.push(e.message);console.log('BROWSER ERROR',e.stack);});
  await page.goto(process.env.MK64_HARNESS_URL || 'http://127.0.0.1:8064/');await page.waitForTimeout(11000);
  for(let step=0;step<9;step++){
   await page.keyboard.down(step===0?'Enter':'KeyX');await page.waitForTimeout(150);await page.keyboard.up(step===0?'Enter':'KeyX');
   await page.waitForTimeout(1800);
   console.log('Step',step,await page.evaluate(()=>({frame:window.mk64?._web_frame(),menu:window.mk64?._web_menu(),error:window.mk64Error})));
   await page.screenshot({path:path.join(output,`race-step-${step}.png`)});
  }
  await page.waitForFunction(()=>window.mk64._web_race_state()===3,{}, {timeout:30000});
  const state=()=>page.evaluate(()=>({frame:mk64._web_frame(),race:mk64._web_race_state(),pos:[0,1,2].map(axis=>mk64._web_position(axis))}));
  const before=await state();
  await page.screenshot({path:path.join(output,'race-countdown-complete.png')});
  await page.keyboard.down('KeyX');
  await page.waitForTimeout(4000);
  const straight=await state();
  await page.screenshot({path:path.join(output,'race-straight.png')});
  await page.keyboard.down('ArrowRight');await page.waitForTimeout(700);await page.keyboard.up('ArrowRight');
  await page.waitForTimeout(2000);await page.keyboard.up('KeyX');
  const after=await state();
  assert.equal(after.race,3,'Race must remain active');
  assert.ok(after.frame-before.frame>100,'Race frames must continue advancing');
  assert.ok([...before.pos,...after.pos].every(Number.isFinite),'Player coordinates must be finite');
  assert.ok(Math.hypot(...straight.pos.map((value,i)=>value-before.pos[i]))>100,'Accelerating must move the kart');
  assert.ok(Math.hypot(...after.pos.map((value,i)=>value-straight.pos[i]))>20,'Driving must continue after steering');
  assert.deepEqual(errors,[]);
  await page.screenshot({path:path.join(output,'race-driving.png')});
  console.log('PASS race load, countdown, frame advancement, acceleration and steering', {before,straight,after});
  if(process.env.MK64_SHELL_PALETTE_CHECK){
   const map=fs.readFileSync(path.join(output,'build/link.map'),'utf8');
   const address=name=>{const match=map.match(new RegExp('^([0-9a-f]+)\\s+[^\\n]+\\s'+name+'$','m'));assert.ok(match,name);return parseInt(match[1],16);};
   const symbols={green:address('common_tlut_green_shell'),red:address('gTLUTRedShell')};
   const palette=await page.evaluate(({green,red})=>{
    const view=new DataView(testMemory.buffer);
    let mismatches=0, visible=0, redDominant=0;
    for(let i=0;i<256;i++){
     const source=view.getUint16(green+i*2,false);
     const expected=((source&0xf800)>>>5)|((source&0x07c0)<<5)|(source&0x003e)|(source&1);
     const actual=view.getUint16(red+i*2,false);
     if(actual!==expected)mismatches++;
     if(actual&1){visible++;if((actual&0xf800)>((actual&0x07c0)<<5))redDominant++;}
    }
    return {mismatches,visible,redDominant};
   },symbols);
   assert.equal(palette.mismatches,0,'Runtime red-shell palette must match the transformed ROM palette');
   assert.ok(palette.visible>30&&palette.redDominant>30,'Red shell must have visible red pixels');
   console.log('PASS runtime red-shell palette',palette);
  }
  if(process.env.MK64_ASSET_TOUR){
   // Local QA only: use the game's CPU driver to tour the course. No debug
   // controls or memory access are added to the shipped game.
   const map=fs.readFileSync(path.join(output,'build/link.map'),'utf8');
   const address=name=>{const match=map.match(new RegExp('^([0-9a-f]+)\\s+[^\\n]+\\s'+name+'$','m'));assert.ok(match,name);return parseInt(match[1],16);};
   const symbols=Object.fromEntries(['gPlayerOne','gNearestPathPointByPlayerId','gPhysicalFramebuffers','gSegmentTable'].map(name=>[name,address(name)]));
   await page.evaluate(s=>{window.testSymbols=s;const v=new DataView(testMemory.buffer);const p=v.getUint32(s.gPlayerOne,true);v.setUint16(p,v.getUint16(p,true)|0x1000,true);},symbols);
   let screenUpdated=false;
   for(let i=0;i<7;++i){
    await page.waitForTimeout(4000);
    const state=await page.evaluate(()=>{const v=new DataView(testMemory.buffer),s=testSymbols;const segment=v.getUint32(s.gSegmentTable+20,true);const fb=v.getUint32(s.gPhysicalFramebuffers,true);const colors=p=>new Set(new Uint16Array(testMemory.buffer,p,2048)).size;return {frame:mk64._web_frame(),point:v.getInt16(s.gNearestPathPointByPlayerId,true),segment:segment.toString(16),fb:fb.toString(16),screenColors:[0,1,2,3,4,5].map(i=>colors(segment+0xf800+i*0x1000)),frameColors:[0,1,2].map(i=>colors(v.getUint32(s.gPhysicalFramebuffers+i*4,true)))};});
    await page.locator('canvas').screenshot({path:path.join(output,`asset-tour-${i}.png`)});
    console.log('Asset tour',i,state);
    if(i>=4 && state.screenColors.every(count=>count>50)) screenUpdated=true;
   }
   assert.ok(screenUpdated,'All six video screen tiles must receive live pixels');
   assert.deepEqual(errors,[]);
  }
 }finally{fs.writeFileSync(path.join(output,'race-browser.log'),logs.join('\n'));await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
