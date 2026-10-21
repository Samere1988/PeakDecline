const assert=require('node:assert/strict');
const fs=require('node:fs'),http=require('node:http'),path=require('node:path');
const {chromium}=require(path.join(process.env.HOME,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
(async()=>{
 const directory=path.resolve(process.env.MP_BUILD_DIR||'.tmp/marioparty2-port');
 const moduleName=process.env.MP_BUILD_DIR?'marioparty2':'boot-probe',factory=process.env.MP_BUILD_DIR?'createMarioParty2':'createMarioPartyBootProbe';
 const server=http.createServer((req,res)=>{
  if(req.url==='/'){res.setHeader('Content-Type','text/html');return res.end(`<canvas id="canvas" width="640" height="480"></canvas><script src="/boot-probe.js"></script><script>${factory}().then(m=>window.probe=m)</script>`);}
  if(req.url==='/game.z64'){res.setHeader('Content-Type','application/octet-stream');return res.end(fs.readFileSync(path.resolve('static/roms/N64/Mario Party 2 (U) [!].z64')));}
  if(!['/boot-probe.js','/'+moduleName+'.wasm'].includes(req.url)){res.statusCode=404;return res.end();}
  res.setHeader('Content-Type',req.url.endsWith('.wasm')?'application/wasm':'text/javascript');res.end(fs.readFileSync(path.join(directory,req.url==='/boot-probe.js'?moduleName+'.js':req.url)));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 let browser;
 try{
  browser=await chromium.launch({headless:true,executablePath:process.env.MP_BROWSER||path.join(process.env.HOME,'.cache/ms-playwright/chromium-1243/chrome-linux64/chrome')});
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error(e.message);});
  if(process.env.MP_DIAG)page.on('console',message=>console.log(message.text()));
  if(process.env.MP_PROGRESS)page.on('console',message=>{if(message.text().startsWith('MP stage'))console.log(message.text());});
  await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForFunction(()=>window.probe);
  await page.evaluate(input=>window.testInput=input,JSON.parse(process.env.MP_INPUT_FILE?fs.readFileSync(process.env.MP_INPUT_FILE,'utf8'):process.env.MP_INPUT||'[]'));
  await page.evaluate(at=>window.presentAfter=at,Number(process.env.MP_PRESENT_AFTER||0));
  if(process.env.MP_NO_DEPTH)await page.evaluate(()=>{const enable=WebGLRenderingContext.prototype.enable;WebGLRenderingContext.prototype.enable=function(cap){if(cap!==this.DEPTH_TEST)return enable.call(this,cap);};});
  if(process.env.MP_TRACE)await page.evaluate(()=>{
   window.gfxTrace=[];
   for(const name of ['bufferData','texImage2D','drawArrays','clear','blendFunc']){
    const original=WebGLRenderingContext.prototype[name];
    WebGLRenderingContext.prototype[name]=function(...args){
     const formatted=args.map(a=>ArrayBuffer.isView(a)?({length:a.length,first:Array.from(a.slice(0,60)),max:a.reduce((x,y)=>Math.max(x,y),0)}):a);
     gfxTrace.push({name,args:formatted});if(gfxTrace.length>160)gfxTrace.shift();return original.apply(this,args);
    };
   }
  });
  const result=await page.evaluate(async(tickLimit)=>{
   probe.FS.writeFile('/game.z64',new Uint8Array(await (await fetch('/game.z64')).arrayBuffer()));
   probe._mp_prepare();
   const entry=probe._mp_lookup_section(0x80000400),main=probe._mp_lookup_section(0x80000460);
   probe._mp_load_section(2);const first=probe._mp_lookup_section(0x80102800);
   probe._mp_load_section(3);const second=probe._mp_lookup_section(0x80102800);
   probe._mp_prepare();
   let error,ticks=0;const stages=[];
   try{probe._mp_boot();for(;ticks<tickLimit;ticks++){
    for(const [at,buttons,x=0,y=0] of testInput)if(at===ticks)probe._mp_pad(0,buttons,x,y,1);
    probe.skipPresentation=ticks<presentAfter;probe.traceCommands=ticks>=tickLimit-2;probe._mp_tick();
    if(ticks%60===0){const section=probe._mp_lookup_section(0x80102800);if(stages.at(-1)?.section!==section){stages.push({tick:ticks,section});console.debug('MP stage',ticks,section);}}
   }}catch(e){error=e.message;console.error(e.stack);}
   let invalid;try{probe._mp_load_section(999);}catch(e){invalid=e.message;}
   const processes=[];for(let p=probe._mp_word(0x800eb8ec)>>>0;p&&processes.length<20;p=probe._mp_word(p)>>>0)processes.push({p:p.toString(16),entry:(probe._mp_word(p+0x30)>>>0).toString(16),mode:probe._mp_word(p+0x1c)>>>0,sleep:probe._mp_word(p+0x24)});
   const gl=document.getElementById('canvas').getContext('webgl');
   return {turn:probe._mp_word(0x800f93b0)>>>16,hash:probe._mp_hash()>>>0,stages,fade:[probe._mp_word(0x800f5024)>>>0,probe._mp_word(0x800f3288)>>>0,probe._mp_word(0x800ed0d0)>>>0],processes,glError:gl?.getError(),viewport:gl?Array.from(gl.getParameter(gl.VIEWPORT)):null,scissor:gl?Array.from(gl.getParameter(gl.SCISSOR_BOX)):null,entry,main,first,second,error,ticks,invalid,history:probe.renderHistory,info:probe.renderInfo,overlay:probe._mp_lookup_section(0x80102800),process:probe._mp_word(0x800eb8ec),rendered:probe._mp_rendered_frames(),audio:probe._mp_audio_tasks(),threads:probe._mp_boot_threads()};
  },Number(process.env.MP_TICKS||90));
  await page.locator('#canvas').screenshot({path:process.env.MP_SCREENSHOT||'.tmp/marioparty2-native.png'});
  fs.writeFileSync('.tmp/marioparty2-commands.json',JSON.stringify(await page.evaluate(()=>probe.commandTrace||[])));
  if(process.env.MP_TRACE)fs.writeFileSync('.tmp/marioparty2-gfx-trace.json',JSON.stringify(await page.evaluate(()=>gfxTrace),null,2));
  if(process.env.MP_RENDER_TEST){await page.evaluate(()=>probe._mp_render_test());await page.locator('#canvas').screenshot({path:'.tmp/marioparty2-render-test.png'});}
  assert.deepEqual([result.entry,result.main],[0,1]);
  if(process.env.MP_DIAG)console.log(JSON.stringify(result));
  assert.equal(result.error,undefined,'Original cartridge execution must not hit a missing platform service');
  assert.equal(result.ticks,Number(process.env.MP_TICKS||90));
  if(process.env.MP_INPUT_FILE)assert.ok(result.threads>=9);
  else assert.ok(result.threads>0);
  assert.ok(result.rendered>0&&result.audio>0,'Original graphics and audio tasks must execute');
  assert.equal(result.glError,0);
  if(!process.env.MP_TICKS&&!process.env.MP_RENDER_TEST){
   const colored=await page.evaluate(()=>{const gl=document.getElementById('canvas').getContext('webgl'),pixels=new Uint8Array(640*480*4);gl.readPixels(0,0,640,480,gl.RGBA,gl.UNSIGNED_BYTE,pixels);let count=0;for(let i=0;i<pixels.length;i+=4)if(pixels[i]>32||pixels[i+1]>32||pixels[i+2]>32)count++;return count;});
   assert.ok(colored>10000,'The original startup logo must be visible, not a black canvas');
  }
  assert.match(result.invalid,/Invalid Mario Party code section/);
  if(process.env.MP_SCENARIO==='party'){
   assert.ok(result.stages.some(s=>s.section===4),'Roll Out the Barrels must execute');
   assert.ok(result.stages.some(s=>s.section===29),'Balloon Burst must execute');
   assert.equal(result.overlay,67,'The minigame must return to Pirate Land');
   assert.ok(result.turn>=2,'The board must advance beyond its first turn');
  }
  assert.deepEqual(errors,[]);
  console.log('PASS: Mario Party 2 executes original graphics/audio tasks without runtime or WebGL errors.');
 }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});
