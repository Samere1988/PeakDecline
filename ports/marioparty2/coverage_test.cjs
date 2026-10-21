// Test-only fixture selection in an unmodified release module. Never touches the live service.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require(path.join(process.env.HOME,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const root=path.resolve(process.env.MP_BUILD_DIR||'.tmp/marioparty2-port/release'),out=path.resolve(process.env.MP_REPORT_DIR||'.tmp/mp2-coverage');
const runtimeSha256=require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(root,'marioparty2.wasm'))).digest('hex');
const input=JSON.parse(fs.readFileSync('ports/marioparty2/party_inputs.json'));
const cases=JSON.parse(fs.readFileSync(process.env.MP_CASES||'ports/marioparty2/coverage_cases.json'));
(async()=>{
 fs.mkdirSync(out,{recursive:true});
 const server=http.createServer((req,res)=>{
  if(req.url==='/'){res.setHeader('Content-Type','text/html');return res.end('<canvas id="canvas" width="640" height="480"></canvas><script src="/marioparty2.js"></script><script>createMarioParty2().then(m=>window.probe=m)</script>');}
  const file=req.url==='/game.z64'?path.resolve('static/roms/N64/Mario Party 2 (U) [!].z64'):['/marioparty2.js','/marioparty2.wasm'].includes(req.url)?root+req.url:null;
  if(!file){res.statusCode=404;return res.end();}res.setHeader('Content-Type',file.endsWith('.wasm')?'application/wasm':'application/octet-stream');fs.createReadStream(file).pipe(res);
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({headless:true,executablePath:path.join(process.env.HOME,'.cache/ms-playwright/chromium-1243/chrome-linux64/chrome')});
 let failed=0;
 try{for(const test of cases){
  if(process.env.MP_FILTER&&!test.key.match(new RegExp(process.env.MP_FILTER)))continue;
  if(process.env.MP_SHARD&&test.id%Number(process.env.MP_SHARDS||2)!==Number(process.env.MP_SHARD))continue;
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  try{
   await page.addInitScript(()=>{for(const method of ['instantiate','instantiateStreaming']){const original=WebAssembly[method];WebAssembly[method]=async function(...args){const result=await original.apply(this,args);window.testMemory=Object.values((result.instance||result).exports).find(v=>v instanceof WebAssembly.Memory);return result;};}});
   await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForFunction(()=>window.probe);
   let caseInput=input;
   if(test.natural){caseInput=input.map(e=>e.slice());const move=caseInput.find(e=>e[0]===2184);if(test.id===0)caseInput.push([2240,0,0,80],[2246,0,0,0]);if(test.id===2){move[2]=0;move[3]=80;caseInput.push([2220,0,80,0],[2226,0,0,0],[2256,0,0,-80],[2262,0,0,0]);}if(test.id===3||test.id===4){move[2]=0;move[3]=80;}if(test.id===4)caseInput.push([2240,0,80,0],[2246,0,0,0]);caseInput.sort((a,b)=>a[0]-b[0]);}
   const result=await page.evaluate(async({test,input,fullRender,captureAt,traceAt})=>{
    const rom=new Uint8Array(await(await fetch('/game.z64')).arrayBuffer());probe.FS.writeFile('/game.z64',rom);probe._mp_prepare();
    // Locate the unique loaded entry code; read back through the public accessor before any fixture writes.
    const heap=new Uint8Array(window.testMemory.buffer);let base=-1;
    for(let at=0;at<heap.length-0x800000;at+=4){let match=true;for(let i=0;i<64;i++)if(heap[at+((0x400+i)^3)]!==rom[0x1000+i]){match=false;break;}if(match){if(base!==-1)throw Error('Ambiguous guest memory');base=at;}}
    if(base<0)throw Error('Guest memory not found');
    const read16=a=>((probe._mp_word(a&~3)>>>((a&2)?0:16))&65535);
    const write8=(a,v)=>heap[base+((a&0x7fffff)^3)]=v;
    const write16=(a,v)=>{write8(a,v>>>8);write8(a+1,v);};
    if(new DataView(heap.buffer).getUint32(base+0x400,true)!==(probe._mp_word(0x80000400)>>>0))throw Error('Guest memory check failed');
    probe.inspectAudio=true;probe._mp_boot();let index=0,selected=false,entered=-1,exited=-1,error=null;const stages=[],hashes=[],shots=[];
    let ticks=0,last=-2;
    const limit=test.ticks||26000;
    try{for(;ticks<limit;ticks++){
     while(index<input.length&&input[index][0]===ticks){const [,b,x,y]=input[index++];probe._mp_pad(0,b,x,y,1);}
     if(test.kind==='board'&&!test.natural&&ticks>=2666&&ticks<5300)write16(0x800f93aa,test.id);
     const pending=probe._mp_word(0x800fa63c),change=probe._mp_word(0x800cd41c);
     if(test.kind==='minigame'&&!selected&&ticks>13000&&change&&(pending===95||pending===96)){
      write16(0x800f93c8,test.id);write16(0x800fa63e,test.id<30?95:96);
      // Original CPU logic exercises a complete timed round. Team grouping follows the cartridge category.
      for(let p=0;p<4;p++){const a=0x800fd2c0+p*0x34;write8(a,test.type===1?(p?1:0):test.type===2?(p<2?0:1):p);write8(a+1,2);write8(a+2,2);write16(a+6,read16(a+6)|1);}
      selected=true;
     }
     if(ticks>14000){const current=probe._mp_lookup_section(0x80102800);probe._mp_pad(0,[97,98].includes(current)&&ticks%120<6?4096:ticks%30<6?32768:0,0,0,1);}
     probe.skipPresentation=!(fullRender&&entered>=0)&&ticks%60>3;if(captureAt!==null&&ticks>=captureAt)probe.skipPresentation=false;
     if(traceAt!==null&&ticks>=traceAt){probe.traceCommands=true;probe.commandTrace=[];}
     probe._mp_tick();
     const section=probe._mp_lookup_section(0x80102800);
     if(section!==last){stages.push({tick:ticks,section});last=section;}
     if((test.kind==='board'||selected)&&section===test.section&&entered<0)entered=ticks;
     if(entered>=0&&section!==test.section&&ticks>entered+120&&exited<0)exited=ticks;
     if(entered>=0&&[entered+600,entered+1800].includes(ticks)){probe.skipPresentation=false;shots.push({tick:ticks,image:document.getElementById('canvas').toDataURL()});}
     if(ticks%600===0)hashes.push([ticks,probe._mp_hash()>>>0]);
     if(test.kind==='minigame'&&exited>=0&&ticks>exited+180)break;
     if(test.kind==='board'&&entered>=0&&read16(0x800f93b0)>=2&&section===test.section&&ticks>entered+1200)break;
    }}catch(e){error=e.stack||e.message;}
    probe.skipPresentation=false;if(!error)probe._mp_tick();
    const gl=document.getElementById('canvas').getContext('webgl');
    return {commandTrace:probe.commandTrace,shots,test,ticks,selected,entered,exited,error,stages,hashes,finalHash:probe._mp_hash()>>>0,turn:read16(0x800f93b0),board:read16(0x800f93aa),chosen:read16(0x800f93c8),overlay:probe._mp_lookup_section(0x80102800),audio:probe.audioStats,glError:gl.getError()};
   },{test,input:caseInput,traceAt:process.env.MP_TRACE_AT?Number(process.env.MP_TRACE_AT):null,fullRender:process.env.MP_FULL_RENDER!=='0',captureAt:process.env.MP_CAPTURE_AT?Number(process.env.MP_CAPTURE_AT):null});
   for(const shot of result.shots)fs.writeFileSync(path.join(out,test.key+'-'+shot.tick+'.png'),Buffer.from(shot.image.split(',')[1],'base64'));delete result.shots;
   result.runtime_sha256=runtimeSha256;result.pageErrors=errors;
   result.status=result.error||errors.length||result.glError||!result.audio?.peak?'FAIL':result.entered<0?'NOT_REACHED':test.kind==='minigame'&&result.exited<0?'INCOMPLETE':test.kind==='board'&&result.turn<2?'INCOMPLETE':'PASS';
   result.presentation=process.env.MP_FULL_RENDER==='0'?'sampled':'continuous after target entry';
   if(result.status!=='PASS')failed++;
   await page.locator('#canvas').screenshot({path:path.join(out,test.key+'.png')});
   fs.writeFileSync(path.join(out,test.key+'.json'),JSON.stringify(result,null,2));
   console.log(JSON.stringify({key:test.key,status:result.status,ticks:result.ticks,entered:result.entered,exited:result.exited,overlay:result.overlay,board:result.board,turn:result.turn,error:result.error?.slice(0,250)}));
  }catch(e){failed++;console.error(test.key,e);fs.writeFileSync(path.join(out,test.key+'.json'),JSON.stringify({test,runtime_sha256:runtimeSha256,status:'HARNESS_ERROR',error:e.stack}));}
  finally{await page.close();}
 }}finally{await browser.close();await new Promise(r=>server.close(r));}
 if(failed)process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1;});
