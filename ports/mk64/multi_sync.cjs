// Exercise MKart360's two-player race path with distinct inputs on two browsers.
const {chromium}=require(process.env.MK64_PLAYWRIGHT||'C:/Users/Plex/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const output=path.resolve(__dirname,'../../.tmp/mk64/multi-sync-report.json');
(async()=>{
 const browsers=[],pages=[],errors=[];
 try{
  for(let slot=0;slot<2;++slot){
   const browser=await chromium.launch({headless:true,executablePath:process.env.MK64_BROWSER||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',args:['--enable-unsafe-swiftshader']});
   browsers.push(browser);
   const page=await browser.newPage();pages.push(page);
   await page.addInitScript(localSlot=>{
    window.mk64Multiplayer=true;window.mk64LocalSlot=localSlot;
    window.mk64InputsAtFrame=frame=>[
     {buttons:frame>=180 && frame<580?0x8000:0,x:frame>=350 && frame<390?-55:0,y:0},
     {buttons:frame>=220 && frame<580?0x8000:0,x:frame>=360 && frame<410?55:0,y:0}
    ];
   },slot);
   page.on('pageerror',error=>errors.push({slot,message:error.message}));
  }
  await Promise.all(pages.map(page=>page.goto('http://127.0.0.1:8064/')));
  await Promise.all(pages.map(page=>page.waitForFunction(()=>window.mk64?._web_frame()>=650,{},{timeout:120000})));
  const traces=await Promise.all(pages.map(page=>page.evaluate(()=>({
   frame:mk64._web_frame(),race:mk64._web_race_state(),
   players:[0,1].map(slot=>[0,1,2].map(axis=>mk64._web_player_position(slot,axis))),
   hashes:Array.from({length:550},(_,i)=>mk64._web_hash_for_frame(100+i)>>>0)
  }))));
  const mismatches=[];
  for(let i=0;i<550;++i) if(traces[0].hashes[i]!==traces[1].hashes[i])
    mismatches.push({frame:100+i,a:traces[0].hashes[i].toString(16),b:traces[1].hashes[i].toString(16)});
  const report={status:mismatches.length?'desync':'matched',frames:traces.map(t=>t.frame),races:traces.map(t=>t.race),players:traces.map(t=>t.players),comparedFrames:550,mismatchCount:mismatches.length,firstMismatches:mismatches.slice(0,20),errors};
  fs.writeFileSync(output,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
  assert.deepEqual(errors,[]);
  assert.ok(traces.every(t=>t.race===3));
  assert.ok(traces.every(t=>t.hashes.every(Boolean)));
  assert.notDeepEqual(traces[0].players[0],traces[0].players[1]);
  assert.equal(mismatches.length,0);
 }finally{await Promise.all(browsers.map(browser=>browser.close()));}
})().catch(error=>{console.error(error);process.exitCode=1;});
