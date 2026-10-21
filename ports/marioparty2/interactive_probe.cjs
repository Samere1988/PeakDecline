// Local developer harness. No application service or published build is changed.
const fs=require('node:fs'),http=require('node:http'),path=require('node:path'),readline=require('node:readline');
const {chromium}=require(path.join(process.env.HOME,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
(async()=>{
 const root=path.resolve('.tmp/marioparty2-port');
 let currentTick=Number(process.env.MP_INPUT_FILE?process.env.MP_TICKS||14500:0);
 const recorded=process.env.MP_INPUT_FILE?JSON.parse(fs.readFileSync(process.env.MP_INPUT_FILE,'utf8')).filter(event=>event[0]<currentTick):[];
 const server=http.createServer((req,res)=>{
  if(req.url==='/'){res.setHeader('Content-Type','text/html');return res.end('<canvas id="canvas" width="640" height="480"></canvas><script src="/boot-probe.js"></script><script>createMarioPartyBootProbe().then(m=>window.probe=m)</script>');}
  if(req.url==='/game.z64')return fs.createReadStream('static/roms/N64/Mario Party 2 (U) [!].z64').pipe(res);
  if(!['/boot-probe.js','/boot-probe.wasm'].includes(req.url)){res.statusCode=404;return res.end();}
  res.setHeader('Content-Type',req.url.endsWith('.wasm')?'application/wasm':'text/javascript');fs.createReadStream(path.join(root,req.url)).pipe(res);
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({headless:true,executablePath:path.join(process.env.HOME,'.cache/ms-playwright/chromium-1243/chrome-linux64/chrome')});
 const page=await browser.newPage();page.on('pageerror',e=>console.error(e.message));
 await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForFunction(()=>window.probe);
 await page.evaluate(()=>{
  const bufferData=WebGLRenderingContext.prototype.bufferData,drawArrays=WebGLRenderingContext.prototype.drawArrays;
  WebGLRenderingContext.prototype.bufferData=function(...args){if(probe.captureTasks&&ArrayBuffer.isView(args[1]))window.lastVertices=Array.from(args[1]);return bufferData.apply(this,args);};
  WebGLRenderingContext.prototype.drawArrays=function(...args){if(probe.captureTasks){probe.draws=probe.draws||[];probe.draws.push({task:probe.taskImages.length,count:args[2],viewport:Array.from(this.getParameter(this.VIEWPORT)),scissor:Array.from(this.getParameter(this.SCISSOR_BOX)),depth:this.isEnabled(this.DEPTH_TEST),vertices:window.lastVertices,shaders:this.getAttachedShaders(this.getParameter(this.CURRENT_PROGRAM)).map(s=>this.getShaderSource(s))});}return drawArrays.apply(this,args);};
 });
 await page.evaluate(async()=>{probe.FS.writeFile('/game.z64',new Uint8Array(await (await fetch('/game.z64')).arrayBuffer()));probe._mp_prepare();probe._mp_boot();window.ticks=0;});
 if(process.env.MP_INPUT_FILE){
  const input=JSON.parse(fs.readFileSync(process.env.MP_INPUT_FILE,'utf8'));
  await page.evaluate(({input,limit})=>{
   for(;ticks<limit;ticks++){
    for(const [at,buttons,x=0,y=0] of input)if(at===ticks)probe._mp_pad(0,buttons,x,y,1);
    probe.skipPresentation=ticks<limit-2;probe._mp_tick();
   }
   probe.skipPresentation=false;
  },{input,limit:Number(process.env.MP_TICKS||14500)});
  await page.locator('#canvas').screenshot({path:'.tmp/marioparty2-interactive.png'});
 }
 console.log('Ready: JSON lines {ticks:90,buttons:0,x:0,y:0,screenshot:".tmp/marioparty2-interactive.png"}. Buttons: Start=4096, A=32768, B=16384. {quit:true} closes.');
 try{
  for await(const line of readline.createInterface({input:process.stdin})){
   try{const request=JSON.parse(line);if(request.quit)break;
    for(let i=0;i<(request.ticks||1);i++)if(i===0||request.pressEvery&&(i%request.pressEvery===0||i%request.pressEvery===6))recorded.push([currentTick+i,request.pressEvery?(i%request.pressEvery<6?request.buttons||32768:0):request.buttons||0,request.x||0,request.y||0]);
    fs.writeFileSync('.tmp/mp2-interactive-inputs.json',JSON.stringify(recorded));
    console.log(JSON.stringify(await page.evaluate(q=>{
     probe.traceCommands=!!q.trace;probe.commandTrace=[];probe.captureTasks=!!q.trace;probe.taskImages=[];probe.draws=[];
     probe._mp_pad(0,q.buttons||0,q.x||0,q.y||0,1);
     for(let i=0;i<(q.ticks||1);i++){
      if(q.pressEvery)probe._mp_pad(0,i%q.pressEvery<6?q.buttons||32768:0,q.x||0,q.y||0,1);
      probe.skipPresentation=!!q.fast&&i<(q.ticks||1)-2;
      probe._mp_tick();ticks++;
     }
     probe.skipPresentation=false;
     const memory=(q.read||[]).map(address=>({address,words:Array.from({length:q.words||16},(_,i)=>probe._mp_word(Number(address)+i*4)>>>0)}));
     return {ticks,memory,overlay:probe._mp_lookup_section(0x80102800),frames:probe._mp_rendered_frames(),audio:probe._mp_audio_tasks()};
    },request)));
    currentTick+=request.ticks||1;
    if(request.trace)fs.writeFileSync('.tmp/marioparty2-commands.json',JSON.stringify(await page.evaluate(()=>probe.commandTrace)));
    if(request.trace){const images=await page.evaluate(()=>probe.taskImages);images.forEach((image,i)=>fs.writeFileSync('.tmp/mp-task-'+i+'.png',Buffer.from(image.split(',')[1],'base64')));}
    if(request.trace)fs.writeFileSync('.tmp/mp-draws.json',JSON.stringify(await page.evaluate(()=>probe.draws)));
    await page.locator('#canvas').screenshot({path:request.screenshot||'.tmp/marioparty2-interactive.png'});
   }catch(e){console.error(e);}
  }
 }finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));process.stdin.destroy();}
})().catch(e=>{console.error(e);process.exitCode=1;});
