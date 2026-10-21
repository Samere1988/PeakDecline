/* Actual production page/clock/FFmpeg, real WebSockets, 15 throttled browsers. */
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process'),crypto=require('node:crypto');
const {chromium}=require(process.env.WATCH_PLAYWRIGHT||'C:/Users/Plex/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root=path.resolve(__dirname,'../..'),fixtures=path.join(root,'tests/watch_together/fixtures');
const base=`http://127.0.0.1:${process.env.LIVE_TEST_PORT||18767}`;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const pages=new Map(),results=[],samples=[],events=[];
const goodConnections=process.env.LIVE_TEST_GOOD_CONNECTIONS==='1';
let browser,server,logs='';
const hashes=Object.fromEntries(['static/js/tv_player.js','app/services/streamer.py','app/services/live_clock.py','app/routes.py'].map(f=>[f,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,f))).digest('hex')]));
function record(name,pass,details){results.push({name,pass,details});console.log(`${pass?'PASS':'FAIL'} ${name}: ${JSON.stringify(details)}`);}
async function api(url,method='GET'){const r=await fetch(base+url,{method});if(!r.ok)throw Error(`${url} ${r.status}`);return r.json();}
async function throttle(page,kbps,latency=20,offline=false){await page.cdp.send('Network.emulateNetworkConditions',{offline,latency,downloadThroughput:kbps*1000/8,uploadThroughput:kbps*1000/8});}
async function join(id,kbps=4000,latency=20){
 const context=await browser.newContext();const page=await context.newPage();
 pages.set(id,page);page.cdp=await context.newCDPSession(page);await page.cdp.send('Network.enable');
 await context.route('https://cdn.jsdelivr.net/npm/hls.js@1.6.13/dist/hls.min.js',r=>r.fulfill({path:path.join(fixtures,'hls.min.js'),contentType:'application/javascript'}));
 await context.route('https://cdn.jsdelivr.net/npm/hls.js@latest',r=>r.fulfill({path:path.join(fixtures,'hls.min.js'),contentType:'application/javascript'}));
 await context.route('https://cdn.socket.io/4.6.0/socket.io.min.js',r=>r.fulfill({contentType:'application/javascript',body:fs.readFileSync(path.join(fixtures,'socket.io.min.js'),'utf8')+'\n;const originalIo=window.io;window.io=()=>originalIo({transports:["websocket"],upgrade:false});'}));
 await context.route('https://fonts.googleapis.com/**',r=>r.abort());
 await page.addInitScript(()=>{
  window.mediaTrace=[];
  document.addEventListener('DOMContentLoaded',()=>{const v=document.querySelector('video');if(v)for(const event of ['playing','waiting','pause','seeking','seeked','error'])v.addEventListener(event,()=>mediaTrace.push({event,at:performance.now(),time:v.currentTime}));});
 });
 page.on('pageerror',e=>events.push({id,error:e.message}));
 await throttle(page,kbps,latency);
 await page.goto(`${base}/test/login/${id}`,{waitUntil:'domcontentloaded'});
 console.log(`Joined viewer ${id}`);
 return page;
}
async function chooseQuality(page, quality){
 await page.waitForFunction(()=>Array.isArray(hls?.levels)&&hls.levels.length>=3,{timeout:30000});
 await page.evaluate(value=>{const select=document.getElementById('live-quality-select');select.value=value;select.dispatchEvent(new Event('change',{bubbles:true}));},quality);
}
async function clickControl(id, selector){
 const page=pages.get(id);
 await page.bringToFront();
 await page.locator('#live-player-shell').hover();
 await page.locator(selector).click();
}
async function snapshot(page,id){return page.evaluate(id=>{
 const v=document.querySelector('video'),date=hls?.playingDate;
 return{id,pdt:date&&Number.isFinite(date.getTime())?date.getTime()/1000:null,paused:v.paused,ready:v.readyState,
  height:v.videoHeight,level:hls?.currentLevel,autoLevel:hls?.autoLevelEnabled,
  frames:v.getVideoPlaybackQuality().totalVideoFrames,rate:v.playbackRate,seeking:v.seeking,
  current:v.currentTime,buffered:Array.from({length:v.buffered.length},(_,i)=>[v.buffered.start(i),v.buffered.end(i)]),
  socket:socket.io.engine?.transport.name,localTarget:sharedTarget(),trace:mediaTrace.splice(0)};
},id);}
async function observe(seconds,phase){
 const end=Date.now()+seconds*1000;
 while(Date.now()<end){
  const start=performance.now(),clock=await api('/test/measure');
  const viewers=await Promise.all([...pages].map(async([id,p])=>{try{return await snapshot(p,id);}catch(e){return{id,error:e.message};}}));
  samples.push({phase,at:Date.now(),clock,measurementMs:performance.now()-start,viewers});await sleep(1000);
 }
}
function assess(label,ids){
 const rows=samples.filter(s=>s.phase===label);let spread=0,maxError=0,stalls=0,count=0,missing=0;
 for(const row of rows){const v=row.viewers.filter(v=>ids.includes(v.id));
  missing+=ids.length-v.filter(v=>Number.isFinite(v.pdt)&&!v.paused).length;
  const positions=v.filter(v=>Number.isFinite(v.pdt)).map(v=>v.pdt);
  if(positions.length>1)spread=Math.max(spread,Math.max(...positions)-Math.min(...positions));
  for(const s of v){count++;if(s.ready<3||s.paused)stalls++;if(Number.isFinite(s.pdt))maxError=Math.max(maxError,Math.abs(s.pdt-row.clock.target_pdt));}
 }
 const first=rows[0]?.viewers,last=rows.at(-1)?.viewers;
 const advancing=ids.every(id=>{const a=first?.find(x=>x.id===id),b=last?.find(x=>x.id===id);return a&&b&&b.frames>a.frames;});
 record(label,rows.length>=5&&missing===0&&spread<=2&&maxError<=1.5&&stalls/count<=0.1&&advancing,{spread,maxError,stalledSamples:stalls,totalSamples:count,missing,advancing});
 fs.writeFileSync(path.join(__dirname,'synchronized-progress.json'),JSON.stringify({results,samples,events},null,2));
}
async function main(){
 server=spawn(path.join(root,'.venv/Scripts/python.exe'),[path.join(__dirname,'server.py')],{stdio:['ignore','pipe','pipe']});
 server.stdout.on('data',d=>logs+=d);server.stderr.on('data',d=>logs+=d);
 for(let i=0;i<60;i++){try{await fetch(base+'/');break;}catch{await sleep(250);}}
 browser=await chromium.launch({headless:true,executablePath:process.env.WATCH_BROWSER||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',args:['--autoplay-policy=no-user-gesture-required']});
 try{
  const nativeOnly=process.env.LIVE_TEST_NATIVE_ONLY==='1';
  const initialSpeeds=goodConnections?[100000,80000,60000,50000,40000]:nativeOnly?[30000,24000,18000,14000,11000]:null;
  const lateSpeeds=goodConnections?[80000,60000,50000,45000,40000]:nativeOnly?[24000,18000,14000,12000,10000]:null;
  for(let id=0;id<10;id++)await join(id,(nativeOnly?initialSpeeds:[8000,4000,2000,1500,1000])[id%5],(goodConnections?[10,20,35,50,80]:[20,50,100,180,250])[id%5]);
  await api('/test/start','POST');await sleep(12000);
  // The product default is native resolution. Slow simulated viewers opt into
  // a lower rendition through the same user-facing quality menu.
  if(!nativeOnly){
   await chooseQuality(pages.get(2),'720');
   await chooseQuality(pages.get(3),'480');
   await chooseQuality(pages.get(4),'480');
  }
  for(let id=10;id<15;id++)await join(id,(nativeOnly?lateSpeeds:[4000,2000,1500,1200,1000])[id-10],(goodConnections?[10,20,35,50,80]:[20,60,100,150,250])[id-10]);
  if(!nativeOnly){
   await chooseQuality(pages.get(12),'720');
   await chooseQuality(pages.get(13),'480');
   await chooseQuality(pages.get(14),'480');
  }
  await observe(30,'late-join warmup');await observe(15,'15 mixed-speed viewers');assess('15 mixed-speed viewers',[...pages.keys()]);
  if(process.env.LIVE_TEST_STARTUP_ONLY==='1'){process.exitCode=results.some(x=>!x.pass)?1:0;return;}
  if(goodConnections){
   const ids=[...pages.keys()],paused=[2,6,11];
   for(const id of paused)await clickControl(id,'#live-play-toggle');
   await observe(15,'three viewers locally paused');
   record('three intentional pauses preserved',samples.filter(s=>s.phase==='three viewers locally paused').every(s=>paused.every(id=>s.viewers.find(v=>v.id===id)?.paused)),{});
   assess('three viewers locally paused',ids.filter(id=>!paused.includes(id)));
   for(const id of paused){await clickControl(id,'#live-play-toggle');await observe(2,`resume viewer ${id}`);}
   await observe(10,'three resume recovery');await observe(15,'three resumed aligned');assess('three resumed aligned',ids);
   await Promise.all([3,8].map(id=>pages.get(id).reload({waitUntil:'domcontentloaded'})));
   for(const id of [5,10]){await pages.get(id).context().close();pages.delete(id);}
   await observe(8,'two left and two refreshed');
   await join(5,60000,35);await observe(4,'first rejoined');await join(10,40000,80);
   await observe(30,'refresh and rejoin recovery');await observe(15,'refresh and rejoin aligned');assess('refresh and rejoin aligned',ids);
   await clickControl(14,'#live-play-toggle');await observe(4,'late viewer pauses');
   await clickControl(14,'#live-go-live');await observe(10,'go live recovery');
   await observe(15,'go live aligned');assess('go live aligned',ids);
   const checked=samples.filter(s=>['15 mixed-speed viewers','three resumed aligned','refresh and rejoin aligned','go live aligned'].includes(s.phase));
   record('all 15 decode native 1080p with automatic quality disabled',checked.every(s=>s.viewers.length===15&&s.viewers.every(v=>v.height===1080&&v.autoLevel===false)),{});
   record('real WebSocket transport',checked.every(s=>s.viewers.every(v=>v.socket==='websocket')),{});
   record('no player exceptions',events.length===0,events);
   process.exitCode=results.some(x=>!x.pass)?1:0;return;
  }
  await pages.get(2).evaluate(()=>video.pause());await observe(12,'local pause');
  record('pause remains local',samples.filter(s=>s.phase==='local pause').every(s=>s.viewers.find(v=>v.id===2)?.paused),{});
  await pages.get(2).evaluate(()=>{video.play().catch(()=>{});});await observe(6,'resume recovery');await observe(8,'resume aligned');assess('resume aligned',[...pages.keys()]);
  await pages.get(5).reload({waitUntil:'domcontentloaded'});
  await pages.get(10).context().close();pages.delete(10);await observe(4,'leave and refresh');
  await join(10,1200,200);await observe(10,'rejoin recovery');await observe(8,'churn aligned');assess('churn aligned',[...pages.keys()]);
  for(const id of [12,13,14])await throttle(pages.get(id),100,250);
  await observe(20,'below bitrate');assess('below bitrate',[0,1,2,3,4,5,6,7,8,9,10,11]);
  for(const id of [12,13,14])await throttle(pages.get(id),4000,30);
  await observe(18,'bandwidth recovery');await observe(10,'all recovered');assess('all recovered',[...pages.keys()]);
  await pages.get(7).evaluate(()=>{video.currentTime=Math.max(video.seekable.start(0),video.currentTime-8);});
  await throttle(pages.get(8),4000,20,true);await observe(6,'forced drift and offline');
  await throttle(pages.get(8),4000,20);await observe(12,'network recovery');
  await observe(10,'network restored');assess('network restored',[...pages.keys()]);
  const before=await pages.get(0).evaluate(()=>generation);
  await pages.get(0).evaluate(()=>{playChannel(2);});
  const heartbeatMs=[];
  for(let i=0;i<30;i++){
   const t=performance.now();await api('/api/heartbeat','POST');heartbeatMs.push(performance.now()-t);await sleep(100);
  }
  await pages.get(0).waitForFunction(()=>currentChannelId===2&&pendingChannelId===null,{},{timeout:15000});
  const after=await pages.get(0).evaluate(()=>generation);
  record('channel switch initializes requester once',after===before+1,{before,after});
  record('server responds during real encoder startup',Math.max(...heartbeatMs)<500,{maxHeartbeatMs:Math.max(...heartbeatMs)});
  await observe(30,'channel switch recovery');await observe(8,'channel switch aligned');assess('channel switch aligned',[...pages.keys()]);
  await pages.get(0).evaluate(()=>{playChannel(3);});
  await pages.get(0).waitForFunction(()=>pendingChannelId===null&&currentChannelId===null,{},{timeout:15000});
  const failedStatus=await pages.get(0).evaluate(()=>fetch('/api/status').then(r=>r.json()));
  record('failed encoder is not reported active',failedStatus.is_streaming===false,failedStatus);
  await pages.get(0).evaluate(()=>{playChannel(1);});
  await pages.get(0).waitForFunction(()=>pendingChannelId===null&&currentChannelId===1,{},{timeout:15000});
  await observe(30,'failed start retry recovery');await observe(8,'failed start retry aligned');assess('failed start retry aligned',[...pages.keys()]);
  await pages.get(2).evaluate(()=>{video.pause();hls.stopLoad();hls.trigger(Hls.Events.ERROR,{fatal:true,type:Hls.ErrorTypes.NETWORK_ERROR});});
  const pausedGeneration=await pages.get(2).evaluate(()=>generation);await sleep(3500);
  record('fatal error respects local pause',await pages.get(2).evaluate(g=>video.paused&&generation===g,pausedGeneration),{});
  await pages.get(2).evaluate(()=>{video.play().catch(()=>{});});
  await observe(12,'paused fatal recovery');await observe(8,'paused fatal aligned');assess('paused fatal aligned',[...pages.keys()]);
  record('real WebSocket transport',samples.at(-1).viewers.every(v=>v.socket==='websocket'),{});
  record('two-second production segments at 25fps',samples.every(s=>s.clock.durations?.every(d=>Math.abs(d-2)<0.08)),{});
  record('no player exceptions',events.length===0,events);
 }catch(e){record('harness completion',false,e.stack);console.log(logs.slice(-3000));}
 finally{
  if(browser)await browser.close();await api('/test/stop','POST').catch(()=>{});server.kill();
  fs.writeFileSync(path.join(__dirname,goodConnections?'native-good-connections-results.json':'synchronized-results.json'),JSON.stringify({generatedAt:new Date().toISOString(),hashes,profile:goodConnections?{bandwidthMbps:[40,100],latencyMs:[10,80],source:'1920x1080 at 25fps',nativeOnly:true}:null,method:'Production Flask page/clock, actual WebSockets and production FFmpeg command with generated 25fps input; HLS.js 1.6.13 in Windows Edge; autoplay allowed by test browser flag',results,samples,events},null,2)+'\n');
 }
 process.exitCode=results.some(x=>!x.pass)?1:0;
}
main().catch(e=>{console.error(e);server?.kill();process.exitCode=1;});
