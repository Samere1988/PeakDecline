/* End-to-end isolated room: full template, real WebSocket transport, real Plex.
 * node tests/watch_together/realtime.cjs
 */
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const {createHash}=require('node:crypto');
const {chromium}=require(process.env.WATCH_PLAYWRIGHT||'C:/Users/Plex/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root=path.resolve(__dirname,'../..'),base=`http://127.0.0.1:${process.env.WATCH_TEST_PORT||18765}`;
const sourceHash=createHash('sha256').update(fs.readFileSync(path.join(root,'static/js/room_player.js'))).digest('hex');
const child=spawn(process.env.WATCH_TEST_PYTHON||path.join(root,'.venv/Scripts/python.exe'),[path.join(__dirname,'realtime_server.py')],{stdio:['ignore','pipe','pipe']});
let errors='';child.stderr.on('data',d=>{errors+=d;});child.stdout.on('data',()=>{});
const results=[],pages=new Map(),contexts=[],networkErrors=[];let browser;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function api(endpoint,method='GET'){
 const r=await fetch(base+endpoint,{method});if(!r.ok)throw Error(`${endpoint}: HTTP ${r.status}`);return r.json();
}
function record(name,pass,details){results.push({name,pass,details});console.log(`${pass?'PASS':'FAIL'} ${name}: ${details}`);}
async function join(id){
 const context=await browser.newContext({viewport:{width:1280,height:900}});contexts.push(context);
 await context.route('https://cdn.jsdelivr.net/npm/hls.js@latest',r=>r.fulfill({path:path.join(__dirname,'fixtures/hls.min.js'),contentType:'application/javascript'}));
 await context.route('https://cdn.socket.io/4.6.0/socket.io.min.js',r=>r.fulfill({contentType:'application/javascript',body:fs.readFileSync(path.join(__dirname,'fixtures/socket.io.min.js'),'utf8')+`\n;const originalIo=window.io;window.io=(...args)=>{const s=originalIo({transports:['websocket'],upgrade:false});window.testSocket=s;return s;};`}));
 await context.route('https://fonts.googleapis.com/**',r=>r.abort());
 const page=await context.newPage();pages.set(id,page);
 page.on('pageerror',e=>record(`Browser script error user${id}`,false,e.message));
 page.on('response',r=>{if(r.url().includes('/plex-transcode/')&&r.status()>=400)networkErrors.push({id,status:r.status(),file:new URL(r.url()).pathname.split('/').pop()});});
 await page.addInitScript(()=>{window.mediaEvents=[];document.addEventListener('DOMContentLoaded',()=>{
  const v=document.getElementById('video-player');for(const event of ['play','pause','waiting','canplay','seeking','seeked'])v.addEventListener(event,()=>mediaEvents.push({event,time:performance.now(),position:v.currentTime}));
 });});
 await page.goto(`${base}/test/login/${id}`,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.testSocket?.connected,null,{timeout:15000});
 const cdp=await context.newCDPSession(page);await cdp.send('Network.enable');
 const kbps=[12000,8000,5000,3000,2000][id%5],latency=[20,60,120,250,500][id%5];
 await cdp.send('Network.emulateNetworkConditions',{offline:false,latency,downloadThroughput:kbps*125,uploadThroughput:kbps*125});
 return page;
}
async function snapshot(page){return page.evaluate(()=>{const v=document.getElementById('video-player');return {paused:v.paused,time:v.currentTime,ready:v.readyState,frames:v.getVideoPlaybackQuality().totalVideoFrames,transport:testSocket.io.engine.transport.name,connected:testSocket.connected,events:mediaEvents};});}
async function sample(name){
 const first={};for(const [id,p]of pages)first[id]=await snapshot(p);
 await sleep(2500);for(const [id,p]of pages){first[id].advanced=(await snapshot(p)).frames-first[id].frames;}
 const host=first[0],failed=Object.entries(first).filter(([id,s])=>s.paused||s.ready<3||s.advanced===0||!s.connected||s.transport!=='websocket'||Math.abs(s.time-host.time)>3);
 const server=await api('/test/status');
 record(name,failed.length===0&&server.users===15,`users=${server.users}; unhealthy=${failed.map(([id])=>id).join(',')||'none'}; max drift=${Math.max(...Object.values(first).map(s=>Math.abs(s.time-host.time))).toFixed(2)}s`);
 results.at(-1).snapshots=first;results.at(-1).server=server;
}
async function samplePaused(){
 const first={};for(const [id,p]of pages)first[id]=await snapshot(p);
 await sleep(2500);
 const after={};for(const [id,p]of pages)after[id]=await snapshot(p);
 const target=first[0].time;
 const maxDrift=Math.max(...Object.values(after).map(s=>Math.abs(s.time-target)));
 const moved=Object.entries(after).filter(([id,s])=>!s.paused||Math.abs(s.time-first[id].time)>0.05);
 record('Host pause aligns and holds all 15 users within 50ms',maxDrift<=0.05&&moved.length===0,`target=${target.toFixed(4)}s; max paused drift=${maxDrift.toFixed(4)}s; moving users=${moved.map(([id])=>id).join(',')||'none'}`);
 results.at(-1).snapshots=after;
}
async function main(){
 let ready=false;for(let i=0;i<60;i++){try{await api('/test/status');ready=true;break;}catch{await sleep(250);}}
 if(!ready)throw Error('Isolated test server did not start: '+errors.slice(-1800));
 browser=await chromium.launch({headless:true,executablePath:process.env.WATCH_BROWSER||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',args:['--autoplay-policy=no-user-gesture-required']});
 console.log('Starting movie transcode and 15 WebSocket users');
 await api('/test/media/movie','POST');
 for(let i=0;i<10;i++)await join(i);
 await pages.get(0).waitForFunction(()=>document.getElementById('video-player').readyState>=3,null,{timeout:45000});
 await pages.get(0).locator('#plex-play-toggle').click();await sleep(6000);
 for(let i=10;i<15;i++)await join(i);
 await sleep(12000);await sample('15 users decode movie Plex transcode over real WebSockets');
 // Deliberately introduce small offsets that the previous 750ms threshold ignored.
 for(const [id,p]of pages)if(id)await p.evaluate(()=>{document.getElementById('video-player').currentTime+=0.4;});
 await pages.get(0).locator('#plex-play-toggle').click();await sleep(5000);
 await samplePaused();await pages.get(0).locator('#plex-play-toggle').click();await sleep(3000);
 await pages.get(3).reload({waitUntil:'domcontentloaded'});
 await pages.get(7).evaluate(()=>testSocket.disconnect());
 await pages.get(0).locator('#plex-play-toggle').click();await sleep(1500);
 await pages.get(0).locator('#plex-play-toggle').click();await sleep(1500);
 await pages.get(7).evaluate(()=>testSocket.connect());
 await pages.get(14).context().close();pages.delete(14);await sleep(1000);await join(14);
 await sleep(12000);await sample('Refresh, missed play during disconnect, leave and rejoin');
 await pages.get(0).reload({waitUntil:'domcontentloaded'});await sleep(10000);
 const host=await pages.get(0).getAttribute('#room-app','data-is-host');
 record('Host refresh retains ownership',host==='true',`host=${host}`);
 console.log('Switching the same room to an episode transcode');
 await api('/test/media/episode','POST');
 await pages.get(0).waitForFunction(()=>document.getElementById('video-player').readyState>=3&&document.getElementById('video-player').paused,null,{timeout:45000});
 await pages.get(0).locator('#plex-play-toggle').click();await sleep(15000);
 await sample('15 users decode episode after a versioned media switch');
 const status=await api('/test/status');record('Plex video transcoding observed',status.transcodes.some(t=>t.videoDecision==='transcode'),`active dedicated transcodes=${status.transcodes.length}; delivered segments=${status.proxy.segments}; bytes=${status.proxy.bytes}`);
 results.at(-1).server=status;
 record('Watch-history reporting isolated',status.proxy.history_reports_blocked>0,`blocked progress reports=${status.proxy.history_reports_blocked}`);
}
main().catch(async e=>{record('End-to-end harness',false,e.message);results.at(-1).networkErrors=networkErrors;try{results.at(-1).server=await api('/test/status');if(pages.get(0))results.at(-1).host=await snapshot(pages.get(0));}catch{} console.log('Network errors:',JSON.stringify(networkErrors));process.exitCode=2;}).finally(async()=>{
 if(browser)await browser.close();
 try{const cleanup=await api('/test/cleanup','POST');record('Dedicated test transcodes cleaned up',cleanup.remaining===0,JSON.stringify(cleanup));}catch(e){record('Transcode cleanup',false,e.message);}
 child.kill();
 fs.writeFileSync(path.join(__dirname,'realtime-results.json'),JSON.stringify({generatedAt:new Date().toISOString(),sourceHash,method:'15 Edge contexts, actual room template and production handlers, gevent Socket.IO WebSocket-only connections, temporary SQLite, shared actual Plex transcodes via loopback proxy; no watched-history reporting',results},null,2)+'\n');
 if(!process.exitCode)process.exitCode=results.every(r=>r.pass)?0:1;
});
