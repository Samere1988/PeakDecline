/* Real Edge + HLS.js + locally generated HLS video; isolated Socket.IO bridge.
 * WATCH_PLAYWRIGHT may point to the installed playwright module.
 * WATCH_BROWSER may point to Chromium/Edge. See README.md for fixture setup.
 */
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {spawn}=require('node:child_process');
const readline=require('node:readline');
const {createHash}=require('node:crypto');
const {chromium}=require(process.env.WATCH_PLAYWRIGHT||'C:/Users/Plex/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root=path.resolve(__dirname,'../..'),fixtures=path.join(__dirname,'fixtures');
const sourceHash=createHash('sha256').update(fs.readFileSync(path.join(root,'static/js/room_player.js'))).digest('hex');
const bridge=spawn(process.env.WATCH_TEST_PYTHON||path.join(root,'.venv/Scripts/python.exe'),[path.join(__dirname,'server_bridge.py')],{stdio:['pipe','pipe','pipe']});
let pending=[],stderr='';bridge.stderr.on('data',d=>stderr+=d);
readline.createInterface({input:bridge.stdout}).on('line',l=>{const p=pending.shift();try{const d=JSON.parse(l);d.error?p.reject(Error(d.error)):p.resolve(d.result);}catch(e){p.reject(e);}});
bridge.on('exit',code=>{for(const p of pending)p.reject(Error(`Bridge exit ${code}: ${stderr}`));pending=[];});
function rpc(d){return new Promise((resolve,reject)=>{pending.push({resolve,reject});bridge.stdin.write(JSON.stringify({...d,now:Date.now()/1000})+'\n');});}
const html=`<!doctype html><html><body>
<div id="room-app"><video id="video-player" playsinline></video>
<button id="plex-play-toggle">Play</button><span id="plex-sync-status"></span><button id="btn-sync-to-host">Sync to Host</button></div>
<script>
const params=new URLSearchParams(location.search),id=Number(params.get('id'));
Object.assign(document.getElementById('room-app').dataset,{roomId:'1',currentKey:'fixture',isHost:String(id===0),hostUsername:'user0',username:'user'+id});
window.received={};window.playerEvents=[];window.io=()=>({on:(e,f)=>received[e]=f,io:{on(){}},emit:(event,data)=>window.toServer({event,data})});
for(const event of ['play','pause','waiting','canplay','seeking','seeked','error'])document.querySelector('video').addEventListener(event,()=>playerEvents.push({event,time:performance.now(),position:document.querySelector('video').currentTime}));
</script><script src="/hls.min.js"></script><script src="/room_player.js"></script></body></html>`;
const server=http.createServer((req,res)=>{
 const pathname=new URL(req.url,'http://localhost').pathname;
 if(pathname==='/'){res.setHeader('Content-Type','text/html');res.end(html);return;}
 if(pathname.startsWith('/api/')){res.setHeader('Content-Type','application/json');res.end('{}');return;}
 const name=pathname==='/fixture.m3u8'?'test.m3u8':path.basename(pathname);
 const file=pathname==='/room_player.js'?path.join(root,'static/js/room_player.js'):path.join(fixtures,name);
 if(!fs.existsSync(file)){res.writeHead(404);res.end();return;}
 res.setHeader('Content-Type',name.endsWith('.m3u8')?'application/vnd.apple.mpegurl':name.endsWith('.ts')?'video/mp2t':'application/javascript');
 res.setHeader('Cache-Control','no-store');fs.createReadStream(file).pipe(res);
});
const pages=new Map(),contexts=[],results=[];let browser,chain=Promise.resolve();
function transact(op){const next=chain.then(async()=>{
 const events=await rpc(op);if(op.op==='state')return events;
 for(const [id,items] of Object.entries(events)){const page=pages.get(Number(id));if(!page||page.isClosed())continue;
  for(const item of items)await page.evaluate(({event,data})=>window.received[event]?.(data),{event:item.name,data:item.args[0]});
 }return events;
 });chain=next.catch(()=>{});return next;}
async function join(id,{kbps=8000,latency=20,delay=0}={}){
 const context=await browser.newContext();contexts.push(context);const page=await context.newPage();pages.set(id,page);
 page.on('pageerror',e=>results.push({name:`user${id} script error`,pass:false,details:e.message}));
 await page.exposeFunction('toServer',d=>transact({op:'emit',id,...d}));
 await page.goto(`${base}/?id=${id}`);await page.waitForFunction(()=>!!window.received.room_state);
 if(delay)await page.route('**/fixture.m3u8',async route=>{await new Promise(r=>setTimeout(r,delay));await route.continue();});
 const cdp=await context.newCDPSession(page);await cdp.send('Network.enable');await cdp.send('Network.emulateNetworkConditions',{offline:false,latency,downloadThroughput:kbps*1000/8,uploadThroughput:kbps*1000/8});
 page.networkSession=cdp;
 await transact({op:'join',id});return page;
}
async function state(page){return page.evaluate(()=>{const v=document.querySelector('video');return{paused:v.paused,time:v.currentTime,ready:v.readyState,rate:v.playbackRate,frames:v.getVideoPlaybackQuality().totalVideoFrames,status:document.getElementById('plex-sync-status').textContent,events:playerEvents};});}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let base;
async function record(name,pass,details){results.push({name,pass,details});console.log(`${pass?'PASS':'FAIL'} ${name}: ${details}`);}
async function reset(){for(const context of contexts.splice(0))await context.close();pages.clear();await chain;await transact({op:'reset'});}
async function main(){await new Promise(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({headless:true,executablePath:process.env.WATCH_BROWSER||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',args:['--autoplay-policy=no-user-gesture-required']});
 await transact({op:'reset'});
 for(let id=0;id<10;id++)await join(id,{kbps:[8000,4000,1500,500,150][id%5],latency:[20,60,150,400,900][id%5]});
 await sleep(4000);await pages.get(0).locator('#plex-play-toggle').click();await sleep(5000);
 for(let id=10;id<15;id++)await join(id,{kbps:[8000,3000,1000,500,150][id-10],latency:[20,80,200,400,900][id-10]});
 await sleep(6000);
 const refresh=pages.get(5);await transact({op:'leave',id:5});await refresh.reload();await refresh.waitForFunction(()=>!!window.received.room_state);await transact({op:'join',id:5});
 await transact({op:'leave',id:12});await pages.get(12).context().close();pages.delete(12);await sleep(1500);await join(12,{kbps:1000,latency:200});
 await pages.get(0).locator('#plex-play-toggle').click();await sleep(1500);await pages.get(0).locator('#plex-play-toggle').click();await sleep(6000);
 const snapshots={};for(const [id,page]of pages)snapshots[id]=await state(page);
 await sleep(2500);for(const [id,page]of pages){const next=await state(page);snapshots[id].framesAdvanced=next.frames-snapshots[id].frames;}
 const host=snapshots[0];const bad=Object.entries(snapshots).filter(([id,s])=>id!=='0'&&(s.paused||Math.abs(s.time-host.time)>3||s.framesAdvanced===0||s.ready<3));
 const normalBad=bad.filter(([id])=>![4,9,14].includes(Number(id)));
 await record('Nominal viewers play while below-bitrate profiles buffer',normalBad.length===0,`host=${host.time.toFixed(2)}s; paused, stalled or >3s drift=${bad.map(([id,s])=>`${id}:${s.paused?'paused':s.ready<3||s.framesAdvanced===0?'stalled':(s.time-host.time).toFixed(1)+'s'}`).join(', ')||'none'}`);
 results.at(-1).snapshots=snapshots;
 // Insufficient bandwidth is expected to stall; the recovery requirement is
 // playable frames and convergence once the connection can carry the stream.
 results.at(-1).details += '; diagnostic below-bitrate profiles, recovery checked next';
 for(const id of [4,9,14]){
  const cdp=pages.get(id).networkSession;
  await cdp.send('Network.enable');await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:20,downloadThroughput:1000000,uploadThroughput:1000000});
 }
 await sleep(22000);
 const recovered={};for(const [id,page] of pages)recovered[id]=await state(page);
 await sleep(2000);for(const [id,page] of pages)recovered[id].framesAdvanced=(await state(page)).frames-recovered[id].frames;
 const recoveryBad=Object.entries(recovered).filter(([id,s])=>s.paused||s.ready<3||s.framesAdvanced===0||Math.abs(s.time-recovered[0].time)>3);
 await record('All 15 viewers recover after bandwidth returns',recoveryBad.length===0,`unrecovered=${recoveryBad.map(([id])=>id).join(',')||'none'}`);
 results.at(-1).snapshots=recovered;
 for(const playing of [true,false]){
  await reset();const host=await join(0);await sleep(1000);
  if(playing)await host.locator('#plex-play-toggle').click();
  const viewer=await join(1,{delay:6000});await sleep(1000);
  await host.locator('#plex-play-toggle').click();await sleep(8500);
  const v=await state(viewer),h=await state(host);
  await record(`Real HLS delayed join across host ${playing?'pause':'play'}`,v.paused===h.paused,`host paused=${h.paused}; viewer paused=${v.paused}; viewer readyState=${v.ready}`);
  results.at(-1).snapshots={host:h,viewer:v};
 }
 await reset();await browser.close();
 browser=await chromium.launch({headless:true,executablePath:process.env.WATCH_BROWSER||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',args:['--autoplay-policy=document-user-activation-required']});
 const h=await join(0);await sleep(1200);await h.locator('#plex-play-toggle').click();const v=await join(1);await sleep(3500);
 const before=await state(v);
 if(!before.paused){results.push({name:'Real browser autoplay denial',pass:null,details:'This Edge configuration allowed autoplay; denial not reproduced. Deterministic denial test covers the error path.',snapshot:before});}
 else {
  // The standard play button remains available even when the sync label has not refreshed.
  await v.locator('#plex-play-toggle').click();await sleep(2000);const after=await state(v);
  await record('Real browser autoplay denial and click recovery',!after.paused,`before paused=${before.paused}, label=${JSON.stringify(before.status)}; after click paused=${after.paused}`);
 }
}
main().catch(e=>{console.error(e);results.push({name:'Browser harness error',pass:false,details:e.stack});process.exitCode=2;}).finally(async()=>{
 fs.writeFileSync(path.join(__dirname,'browser-results.json'),JSON.stringify({generatedAt:new Date().toISOString(),sourceHash,method:'Real headless Edge, actual HLS.js 1.6.13 decoding generated HLS, CDP network throttling; minimal fixture UI; real backend test-client bridge (not WebSocket transport)',results},null,2)+'\n');
 if(browser)await browser.close();server.close();bridge.stdin.end();if(!process.exitCode)process.exitCode=results.every(r=>r.pass!==false)?0:1;
});
