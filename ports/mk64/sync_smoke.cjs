// Two independent browser processes replay the same inputs by simulation frame.
// This is a determinism probe, not a multiplayer transport or player lobby.
const {chromium}=require(process.env.MK64_PLAYWRIGHT||'C:/Users/Plex/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');

const output=path.resolve(__dirname,'../../.tmp/mk64/sync-report.json');
const replay=frame=>{
    if(frame>=300 && frame<305) return {buttons:0x1000,x:0,y:0};
    for(let step=1;step<=8;++step) if(frame>=300+step*60 && frame<305+step*60)
        return {buttons:0x8000,x:0,y:0};
    if(frame>=1040 && frame<1200) return {buttons:0x8000,x:frame>=1140?65:0,y:0};
    return {buttons:0,x:0,y:0};
};

(async()=>{
 const browsers=[],pages=[],errors=[];
 try{
  for(let i=0;i<2;++i){
   const browser=await chromium.launch({headless:true,executablePath:process.env.MK64_BROWSER||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',args:['--enable-unsafe-swiftshader']});
   browsers.push(browser);
   const page=await browser.newPage();pages.push(page);
   await page.addInitScript(fn=>{window.mk64InputAtFrame=eval(`(${fn})`);},replay.toString());
   page.on('pageerror',error=>errors.push({browser:i,message:error.message}));
  }
  await Promise.all(pages.map(page=>page.goto('http://127.0.0.1:8064/')));
  await Promise.all(pages.map(page=>page.waitForFunction(()=>window.mk64?._web_frame()>=1250,{},{timeout:120000})));
  const traces=await Promise.all(pages.map(page=>page.evaluate(()=>({
   frame:mk64._web_frame(),race:mk64._web_race_state(),
   position:[0,1,2].map(axis=>mk64._web_position(axis)),
   hashes:Array.from({length:1100},(_,index)=>mk64._web_hash_for_frame(150+index)>>>0)
  }))));
  const mismatches=[];
  for(let index=0;index<traces[0].hashes.length;++index){
   const frame=index+150,a=traces[0].hashes[index],b=traces[1].hashes[index];
   if(a!==b) mismatches.push({frame,a:a.toString(16),b:b.toString(16)});
  }
  const report={status:mismatches.length?'desync':'matched',browserFrames:traces.map(t=>t.frame),raceStates:traces.map(t=>t.race),positions:traces.map(t=>t.position),comparedFrames:1100,firstMismatches:mismatches.slice(0,20),mismatchCount:mismatches.length,errors};
  fs.writeFileSync(output,JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
  assert.deepEqual(errors,[]);
  assert.ok(traces.every(t=>t.race===3),'Both browsers must reach a race');
  assert.ok(traces.every(t=>t.hashes.every(Boolean)),'Every compared frame must be recorded');
  assert.equal(mismatches.length,0,'Both simulations must match at every frame');
 }finally{await Promise.all(browsers.map(browser=>browser.close()));}
})().catch(error=>{console.error(error);process.exitCode=1;});
