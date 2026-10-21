const assert=require('node:assert/strict'),fs=require('node:fs'),http=require('node:http'),path=require('node:path');
const {chromium}=require(path.join(process.env.HOME,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
(async()=>{
 const directory=path.resolve(process.env.MP_BUILD_DIR||'.tmp/marioparty2-port');
 const limit=Number(process.env.MP_TICKS||1050),input=process.env.MP_INPUT_FILE?JSON.parse(fs.readFileSync(process.env.MP_INPUT_FILE,'utf8')):null;
 const players=input?1:4;
 const moduleName=process.env.MP_BUILD_DIR?'marioparty2':'boot-probe',factory=process.env.MP_BUILD_DIR?'createMarioParty2':'createMarioPartyBootProbe';
 const server=http.createServer((req,res)=>{
  if(req.url==='/'){res.setHeader('Content-Type','text/html');return res.end(`<canvas id="canvas" width="640" height="480"></canvas><script src="/boot-probe.js"></script><script src="/runtime.js"></script><script>${factory}().then(m=>window.probe=m)</script>`);}
  if(req.url==='/game.z64')return fs.createReadStream('static/roms/N64/Mario Party 2 (U) [!].z64').pipe(res);
  if(req.url==='/runtime.js'){res.setHeader('Content-Type','text/javascript');return fs.createReadStream('static/js/netplay/marioparty_runtime.js').pipe(res);}
  if(!['/boot-probe.js','/'+moduleName+'.wasm'].includes(req.url)){res.statusCode=404;return res.end();}
  res.setHeader('Content-Type',req.url.endsWith('.wasm')?'application/wasm':'text/javascript');fs.createReadStream(path.join(directory,req.url==='/boot-probe.js'?moduleName+'.js':req.url)).pipe(res);
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
 try{
  browser=await chromium.launch({headless:true,executablePath:path.join(process.env.HOME,'.cache/ms-playwright/chromium-1243/chrome-linux64/chrome')});
  const results=[];
  for(const role of ['player','spectator']){
   const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForFunction(()=>window.probe);
   results.push(await page.evaluate(async({role,limit,input,players})=>{
    probe.FS.writeFile('/game.z64',new Uint8Array(await (await fetch('/game.z64')).arrayBuffer()));
    probe.inspectAudio=true;
    let callback,available=false,loaded=0,cancelled=0,failures=[],hashes=[],seen=[];
    let inputIndex=0,pad={buttons:0,x:0,y:0};
    const bridge={players,loaded(){loaded++;},ready(frame){seen.push(frame);return available;},
     pads(frame){
      if(input){while(inputIndex<input.length&&input[inputIndex][0]<=frame-1){const [,buttons,x=0,y=0]=input[inputIndex++];pad={buttons,x,y};}return [pad];}
      return Array.from({length:players},(_,slot)=>({buttons:slot===0&&frame>=900&&frame<910?4096:0,x:0,y:0}));
     },
     completed(frame,hash){if(frame%60===59)hashes.push([frame,hash]);},failed(error){failures.push(error);}};
    const runtime=startMarioPartyRuntime(probe,bridge,{requestFrame(fn){callback=fn;return 1;},cancelFrame(){cancelled++;}});
    callback(0);const blockedFrame=runtime.frame;available=true;
    for(let i=0;i<limit;i++){probe.skipPresentation=input?i<limit-(role==='player'?100:20):role==='spectator'&&i<1000;callback(i*1000/60+0.001);}
    const beforeStop=runtime.frame;runtime.stop();callback(limit*1000/60+1000);
    return {role,loaded,blockedFrame,frame:runtime.frame,beforeStop,cancelled,failures,hashes,audio:probe.audioStats,hash:probe._mp_hash()>>>0,overlay:probe._mp_lookup_section(0x80102800)};
   },{role,limit,input,players}));
   assert.deepEqual(errors,[]);await page.close();
  }
  for(const r of results){assert.equal(r.loaded,1);assert.equal(r.blockedFrame,1);assert.equal(r.frame,limit+1);assert.equal(r.frame,r.beforeStop);assert.equal(r.cancelled,1);assert.deepEqual(r.failures,[]);assert.ok(r.overlay>=0);assert.ok(r.hashes.length>10);}
  assert.deepEqual(results[0].hashes,results[1].hashes);assert.equal(results[0].hash,results[1].hash);
  for(const r of results){assert.ok(r.audio.samples>32000);assert.ok(r.audio.peak>100);assert.ok(r.audio.clipped/r.audio.samples<0.01);}
  fs.writeFileSync('.tmp/mp2-frame-bridge-report.json',JSON.stringify(results,null,2));
  console.log(`PASS: separate native player/spectator runtimes consume ${limit} identical frames with ${players} connected controllers and match checksums even with skipped presentation; unavailable frames stall, disposal stops advancement, and generated audio is non-silent without excessive clipping.`);
 }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
