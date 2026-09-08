/* Supplemental cross-engine/device-profile checks. Windows emulation is not a
 * physical macOS, iPhone, or Android certification. Actual capabilities and skips
 * are recorded, never replaced with a mocked decoder.
 */
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const {createHash}=require('node:crypto');
const root=path.resolve(__dirname,'../..');
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(__dirname,'fixtures/browsers');
const {chromium,webkit,devices}=require(process.env.WATCH_PLAYWRIGHT||'C:/Users/Plex/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const sourceHash=createHash('sha256').update(fs.readFileSync(path.join(root,'static/js/room_player.js'))).digest('hex');
const port=process.env.WATCH_PLATFORM_PORT||'18766',base=`http://127.0.0.1:${port}`;
const server=spawn(process.env.WATCH_TEST_PYTHON||path.join(root,'.venv/Scripts/python.exe'),[path.join(__dirname,'realtime_server.py')],{
 env:{...process.env,WATCH_TEST_PORT:port,WATCH_TEST_SYNTHETIC:'1'},stdio:['ignore','pipe','pipe']});
let serverErrors='';server.stderr.on('data',d=>serverErrors+=d);server.stdout.on('data',()=>{});
const browsers=[],results=[],capabilities=[];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function api(url,method='GET'){const r=await fetch(base+url,{method});if(!r.ok)throw Error(`${url} HTTP ${r.status}`);return r.json();}
function record(profile,name,pass,details){results.push({profile,name,pass,details});console.log(`${pass===null?'UNVERIFIED':pass?'PASS':'FAIL'} ${profile}: ${name} — ${details}`);}
async function open(browser,id,profile,delay=0){
 const {defaultBrowserType,...options}=devices[profile];
 const context=await browser.newContext(options);
 await context.route('https://cdn.jsdelivr.net/npm/hls.js@latest',r=>r.fulfill({path:path.join(__dirname,'fixtures/hls.min.js'),contentType:'application/javascript'}));
 await context.route('https://cdn.socket.io/4.6.0/socket.io.min.js',r=>r.fulfill({contentType:'application/javascript',body:fs.readFileSync(path.join(__dirname,'fixtures/socket.io.min.js'),'utf8')+
  '\n;const originalIo=window.io;window.io=()=>{const s=originalIo({transports:["websocket"],upgrade:false});window.testSocket=s;return s;};'}));
 await context.route('https://fonts.googleapis.com/**',r=>r.abort());
 if(delay)await context.route('**/test/fixture/test.m3u8',async r=>{await sleep(delay);await r.continue();});
 const page=await context.newPage();
 page.on('pageerror',e=>record(profile,'script error',false,e.message));
 await page.goto(`${base}/test/login/${id}`,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.testSocket?.connected,null,{timeout:15000});
 return page;
}
async function snap(page){return page.evaluate(()=>{const v=document.getElementById('video-player');return{
 paused:v.paused,time:v.currentTime,ready:v.readyState,frames:v.getVideoPlaybackQuality().totalVideoFrames,
 status:document.getElementById('plex-sync-status').textContent,transport:testSocket.io.engine.transport.name,
 hlsJs:Hls.isSupported(),nativeHls:v.canPlayType('application/vnd.apple.mpegurl'),userAgent:navigator.userAgent,
 touch:navigator.maxTouchPoints,preload:v.preload,
 buffered:Array.from({length:v.buffered.length},(_,i)=>[v.buffered.start(i),v.buffered.end(i)])};});}
async function aligned(page,target){await page.waitForFunction(t=>{const v=document.getElementById('video-player');return v.paused&&v.readyState>=2&&!v.seeking&&Math.abs(v.currentTime-t)<=0.05;},target,{timeout:15000});}
async function playOrGesture(page){
 await sleep(1000);let s=await snap(page);let policy='autoplay permitted';
 if(s.paused){
  if(!/click|play|join/i.test(s.status))throw Error('Paused without an actionable playback message: '+s.status);
  await page.locator('#plex-play-toggle').tap();policy='user gesture required';
 }
 await page.waitForFunction(()=>{const v=document.getElementById('video-player');return !v.paused&&v.readyState>=3;},null,{timeout:15000});
 s=await snap(page);await sleep(1500);const after=await snap(page);
 if(after.frames<=s.frames)throw Error('No decoded-frame progress');
 return policy;
}
async function main(){
 let ready=false;for(let i=0;i<60;i++){try{await api('/test/status');ready=true;break;}catch{await sleep(250);}}
 if(!ready)throw Error('Synthetic server did not start: '+serverErrors.slice(-1200));
 const chrome=await chromium.launch({headless:true,executablePath:process.env.WATCH_CHROME||'C:/Program Files/Google/Chrome/Application/chrome.exe'});browsers.push(chrome);
 await api('/test/media/movie','POST');const host=await open(chrome,0,'Desktop Chrome');
 await host.waitForFunction(()=>document.getElementById('video-player').readyState>=3);
 let wk;
 try{wk=await webkit.launch({headless:true});browsers.push(wk);}catch(e){record('Windows WebKit','engine launch',null,e.message.split('\n')[0]);}
 if(wk)for(const [id,profile,label]of [[1,'Desktop Safari','macOS Safari profile / Windows WebKit'],[2,'iPhone 13','iPhone profile / Windows WebKit']]){
  const page=await open(wk,id,profile);const s=await snap(page);
  capabilities.push({profile:label,engineVersion:wk.version(),...s});
  record(label,'room and real WebSocket connection',s.transport==='websocket','actual template and JavaScript loaded');
  if(!s.hlsJs&&!s.nativeHls)record(label,'HLS playback',null,'This Windows WebKit build has neither compatible MSE nor native HLS. macOS/iPhone decoding cannot be inferred.');
  else {
   await aligned(page,0);record(label,'paused initial join',true,'generated HLS loaded and paused at 0s');
  }
  await page.context().close();
 }
 const label='Android Chrome profile / desktop Chrome';
 const android=await open(chrome,3,'Pixel 7');capabilities.push({profile:label,engineVersion:chrome.version(),...(await snap(android))});
 await host.locator('#plex-play-toggle').click();
 const policy=await playOrGesture(android);record(label,'late/start playback and decoded frames',true,policy);
 await host.locator('#plex-play-toggle').click();const target=(await snap(host)).time;
 await android.evaluate(t=>{document.getElementById('video-player').currentTime=t+0.65;},target);
 await aligned(android,target);const initial=await snap(android);await sleep(3000);const held=await snap(android);
 record(label,'host pause corrects small drift and holds',held.paused&&Math.abs(held.time-target)<=0.05&&Math.abs(held.time-initial.time)<=0.05,`target=${target.toFixed(4)}s; viewer=${held.time.toFixed(4)}s; preload=${held.preload}`);
 await android.reload({waitUntil:'domcontentloaded'});await aligned(android,target);
 record(label,'refresh during host pause',true,`aligned within 50ms of ${target.toFixed(4)}s`);
 await host.locator('#plex-play-toggle').click();await playOrGesture(android);
 await host.locator('#plex-play-toggle').click();await aligned(android,(await snap(host)).time);
 await android.evaluate(()=>testSocket.disconnect());await host.locator('#plex-play-toggle').click();await sleep(2000);
 await android.evaluate(()=>testSocket.connect());await playOrGesture(android);
 record(label,'reconnect after missing host play',true,'resumed decoding with real Socket.IO reconnect');
 const late=await open(chrome,4,'Pixel 7',4000);await sleep(500);await host.locator('#plex-play-toggle').click();const pausedAt=(await snap(host)).time;
 await aligned(late,pausedAt);await aligned(android,pausedAt);
 record(label,'slow late join honors intervening pause',true,`both viewers paused within 50ms of ${pausedAt.toFixed(4)}s`);
 record('Physical devices','macOS Safari, iPhone Safari, Android Chrome',null,'No physical device sessions were provided. Engine/device-profile emulation does not certify native media, autoplay, screen locking, or OS background behavior.');
}
main().catch(e=>{record('runner','execution',false,e.message);process.exitCode=2;}).finally(async()=>{
 for(const b of browsers)await b.close();
 try{await api('/test/cleanup','POST');}catch(e){record('runner','cleanup',false,e.message);}
 server.kill();
 fs.writeFileSync(path.join(__dirname,'platform-results.json'),JSON.stringify({generatedAt:new Date().toISOString(),sourceHash,hostOS:process.platform,method:'Actual browser engines on Windows, device profiles explicitly emulated, real WebSockets, synthetic HLS, temporary SQLite; no Plex requests',capabilities,results},null,2)+'\n');
 if(!process.exitCode)process.exitCode=results.some(r=>r.pass===false)?1:0;
});
