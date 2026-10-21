/* Loopback-only experimental race server. Not a production authentication boundary. */
'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {promisify}=require('node:util'),zlib=require('node:zlib');
const deflate=promisify(zlib.deflate);
let WebSocketServer;
try { ({WebSocketServer}=require('ws')); } catch {
 ({wsServer:WebSocketServer}=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/lib/utilsBundle.js')));
}
const {createSimulation}=require('./authority_runtime.cjs'),{Authority}=require('./authority_net.js'),{Codec}=require('./state_codec.js');
const ROOT=path.resolve(__dirname,'../..'),build=path.join(ROOT,'.tmp/mk64/candidate-authority');
const rom=path.join(ROOT,'static/roms/N64/Mario Kart 64 (U) [!].z64');
const port=Number(process.env.MK64_AUTHORITY_PORT||8072);
const types={'.js':'text/javascript','.json':'application/json','.html':'text/html','.wasm':'application/wasm'};
(async()=>{
 const sim=await createSimulation({build,rom}),authority=new Authority(sim);
 // Candidate starts directly on the existing native online course. Menu support
 // is an explicit acceptance requirement before production integration.
 for(let i=0;i<180;i++)authority.tick();
 const baseline=sim.snapshot(),codec=new Codec(baseline.data);
 const baselineZip=await deflate(baseline.data,{level:1});
 const assets=new Map([['/','authority_harness.html'],['/native_state.js','native_state.js'],['/authority_net.js','authority_net.js'],['/state_codec.js','state_codec.js']].map(([url,name])=>[url,name.endsWith('.js')?path.join(ROOT,'static/js/netplay/mk64_'+name):path.join(__dirname,name)]));
 for(const name of ['mk64.js','mk64.wasm','state-manifest.json'])assets.set('/'+name,path.join(build,name));
 assets.set('/baserom.us.z64',rom);
 const server=http.createServer((req,res)=>{
  const file=assets.get(new URL(req.url,'http://localhost').pathname);
  if(!file){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',types[path.extname(file)]||'application/octet-stream');res.setHeader('Cache-Control','no-store');
  fs.createReadStream(file).pipe(res);
 });
 const wss=new WebSocketServer({server,maxPayload:4096});const seats=new Map();
 function send(socket,meta,data){const header=Buffer.from(JSON.stringify(meta));const length=Buffer.alloc(4);length.writeUInt32LE(header.length);socket.send(Buffer.concat([length,header,data]));}
 wss.on('connection',(socket,request)=>{
  // Prevent other web origins from driving the local test process.
  if(request.headers.origin!==`http://127.0.0.1:${port}`){socket.close(1008);return;}
  const slot=[0,1].find(i=>!seats.has(i));if(slot===undefined){socket.close(1013);return;}
  seats.set(slot,socket);
  send(socket,{type:'baseline',slot,epoch:1,frame:baseline.frame,build:baseline.build,bytes:baseline.data.length},baselineZip);
  socket.on('message',data=>{try{const message=JSON.parse(data);authority.receive(slot,message);}catch{socket.close(1008);}});
  socket.on('close',()=>{if(seats.get(slot)===socket){seats.delete(slot);authority.depart(slot);}});
 });
 let next=performance.now(),busy=false,ticks=0;
 const timer=setInterval(()=>{
  const now=performance.now();let steps=0;
  while(now>=next&&steps++<4){authority.tick();next+=1000/30;ticks++;}
  if(now-next>1000)next=now; // Server overload cannot grow an unbounded replay loop.
  if(ticks<6||busy||!seats.size)return;ticks=0;busy=true;
  const state=authority.checkpoint(),packed=codec.encode(state.state.data);
  deflate(packed,{level:1}).then(data=>{
   const meta={type:'state',epoch:state.epoch,frame:state.frame,hash:state.hash,inputs:state.inputs,build:state.state.build,bytes:packed.length};
   for(const socket of seats.values())if(socket.readyState===1&&socket.bufferedAmount<1024*1024)send(socket,meta,data);
  }).catch(console.error).finally(()=>{busy=false;});
 },5);
 server.listen(port,'127.0.0.1',()=>console.log(`Candidate only: http://127.0.0.1:${port}/`));
 function stop(){clearInterval(timer);for(const socket of seats.values())socket.terminate();wss.close();server.close();}
 process.on('SIGTERM',stop);process.on('SIGINT',stop);
})().catch(e=>{console.error(e);process.exitCode=1});
