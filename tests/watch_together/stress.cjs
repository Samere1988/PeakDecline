/* Executes the unmodified production player in 15 separate JS contexts and sends
 * its events through the real Flask-SocketIO handlers. Media/network timing is
 * deterministic simulation, not a claim of 15 real video decoders or Plex load.
 * Run: node tests/watch_together/stress.cjs
 */
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const {spawn} = require('node:child_process');
const readline = require('node:readline');
const {createHash} = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'static/js/room_player.js'), 'utf8');
const sourceHash = createHash('sha256').update(source).digest('hex');
const python = process.env.WATCH_TEST_PYTHON || path.join(root, '.venv/Scripts/python.exe');
const bridge = spawn(python, [path.join(__dirname, 'server_bridge.py')], {stdio: ['pipe','pipe','pipe']});
let pending = [];
let serverErrors = '';
bridge.stderr.on('data', d => { serverErrors += d; });
readline.createInterface({input: bridge.stdout}).on('line', line => {
  const waiter = pending.shift();
  if (!waiter) return;
  try { const d = JSON.parse(line); d.error ? waiter.reject(Error(d.error)) : waiter.resolve(d.result); }
  catch(e) { waiter.reject(e); }
});
bridge.on('exit', code => { for (const p of pending) p.reject(Error(`Bridge exited ${code}: ${serverErrors}`)); pending=[]; });
function rpc(data) {return new Promise((resolve,reject) => {pending.push({resolve,reject}); bridge.stdin.write(JSON.stringify(data)+'\n');});}

class Element {
  constructor() {this.listeners={};this.style={};this.dataset={};this.classList={add(){},remove(){},toggle(){}};this.children=[];this.value='';}
  addEventListener(e,fn,opts={}) {(this.listeners[e] ||= []).push({fn,once:opts.once});}
  removeEventListener(e,fn) {this.listeners[e]=(this.listeners[e]||[]).filter(h=>h.fn!==fn);}
  dispatch(e) {for(const h of [...(this.listeners[e] || [])]) {if(h.once)this.listeners[e]=this.listeners[e].filter(x=>x!==h); h.fn({target:this,stopPropagation(){},preventDefault(){}});}}
  setAttribute(k,v) {this[k]=v;} removeAttribute(k){if(k!=='src')delete this[k];}
  replaceChildren(){this.children=[];} appendChild(x){this.children.push(x);} querySelector(){return null;}
}
class Sim {
  constructor(){this.now=0;this.jobs=[];this.seq=0;this.clients=new Map();this.events=[];this.outbound=[];this.serverPlaying=false;this.maxDrift=0;}
  schedule(fn,delay=0,repeat=0,owner=null){const j={fn,at:this.now+delay,repeat,id:++this.seq,owner};this.jobs.push(j);return j.id;}
  cancel(id){this.jobs=this.jobs.filter(j=>j.id!==id);}
  async server(op){const result=await rpc({...op,now:1700000000+this.now/1000});
    if(['state'].includes(op.op))return result;
    for(const [id,events] of Object.entries(result))for(const e of events){
      const c=this.clients.get(Number(id));if(!c)continue;
      const data=e.args[0];
      if(['force_play','force_pause','force_seek'].includes(e.name))this.serverPlaying=e.name==='force_play'||(e.name==='force_seek'&&data.is_playing);
      this.schedule(()=>{if(this.clients.get(c.id)===c)c.receive(e.name,data);},c.latency,0,c);
    } return result;
  }
  async flush(){while(this.outbound.length){const op=this.outbound.shift(); if(this.clients.has(op.id))await this.server(op);}}
  async advance(ms){const end=this.now+ms;await this.flush();let loops=0;
    while(true){this.jobs.sort((a,b)=>a.at-b.at||a.id-b.id);const job=this.jobs[0];if(!job||job.at>end)break;
      if(++loops>100000)throw Error('Event feedback loop exceeded 100000 callbacks');
      this.tick(job.at);this.jobs.shift();if(job.repeat)this.jobs.push({...job,at:job.at+job.repeat});job.fn();await this.flush();
    }this.tick(end);await Promise.resolve();await this.flush();
  }
  tick(time){const dt=(time-this.now)/1000;for(const c of this.clients.values())if(!c.video.paused&&c.video.readyState>=3&&!c.stalled)c.video.currentTime+=dt*c.video.playbackRate;this.now=time;}
  async join(id,opts={}){const c=new Client(this,id,opts);this.clients.set(id,c);await this.server({op:'join',id});return c;}
  async leave(id){const c=this.clients.get(id);this.clients.delete(id);this.jobs=this.jobs.filter(j=>j.owner!==c);await this.server({op:'leave',id});}
  async refresh(id){const c=this.clients.get(id);await this.leave(id);return this.join(id,c.opts);}
  async host(event,time){this.outbound.push({op:'emit',id:0,event,data:{room_id:'1',current_time:time??this.clients.get(0).video.currentTime}});await this.flush();}
}
class Client {
  constructor(sim,id,opts){this.sim=sim;this.id=id;this.opts=opts;this.latency=opts.latency||0;this.startup=opts.startup||50;this.skew=opts.skew||0;this.blocked=!!opts.blocked;this.logs=[];this.emitted=[];this.hlsInstances=[];this.handlers={};
    const video=this.video=new Element();Object.assign(video,{paused:true,currentTime:0,duration:7200,readyState:0,playbackRate:1,volume:1,muted:false,buffered:{length:0},canPlayType:()=>opts.native?'probably':''});
    const later=(fn,ms=0)=>sim.schedule(fn,ms,0,this);
    video.play=()=>{if(this.blocked){const err=Error('User gesture required');err.name='NotAllowedError';return Promise.reject(err);}
      if(video.paused){video.paused=false;this.logs.push({at:sim.now,event:'play'});later(()=>video.dispatch('play'));}return Promise.resolve();};
    video.pause=()=>{if(!video.paused){video.paused=true;this.logs.push({at:sim.now,event:'pause'});later(()=>video.dispatch('pause'));}};
    video.load=()=>{video.readyState=0;video.currentTime=0;};
    let src='';Object.defineProperty(video,'src',{configurable:true,get:()=>src,set:v=>{src=v;video.currentSrc=v;later(()=>{video.readyState=4;video.dispatch('loadedmetadata');video.dispatch('canplay');},this.startup);}});
    const app=new Element();Object.assign(app.dataset,{roomId:'1',currentKey:'fixture',isHost:String(id===0),hostUsername:'user0',username:`user${id}`});
    this.status=new Element();this.syncButton=new Element();this.playButton=new Element();
    const elems={'room-app':app,'video-player':video,'plex-sync-status':this.status,'btn-sync-to-host':this.syncButton,'plex-play-toggle':this.playButton};
    const document={getElementById:id=>elems[id]||null,addEventListener:(e,fn)=>{if(e==='DOMContentLoaded')this.init=fn;},querySelector:()=>null,createElement:()=>new Element()};
    const client=this;
    class Hls {
      static isSupported(){return !opts.native;}static Events={MANIFEST_PARSED:'manifest',ERROR:'error'};static ErrorTypes={NETWORK_ERROR:'network',MEDIA_ERROR:'media'};
      constructor(config){this.config=config;this.events={};client.hlsInstances.push(this);}
      loadSource(url){this.url=url;}attachMedia(){video.currentSrc=this.url;later(()=>{if(this.dead)return;video.readyState=4;this.events.manifest?.();video.dispatch('canplay');},client.startup);}
      on(e,fn){this.events[e]=fn;}stopLoad(){}detachMedia(){}destroy(){this.dead=true;}startLoad(){}recoverMediaError(){}
    }
    const socket={on:(e,fn)=>this.handlers[e]=fn,io:{on(){}},emit:(event,data)=>{this.emitted.push({at:sim.now,event,data});sim.events.push({at:sim.now,id,event,data});later(()=>sim.outbound.push({op:'emit',id,event,data}),this.latency);}};
    const FakeDate=class extends Date {static now(){return 1700000000000+sim.now+client.skew;}};
    const context=vm.createContext({document,window:{addEventListener(){},location:{}},navigator:{},Hls,io:()=>socket,Date:FakeDate,
      setTimeout:later,clearTimeout:id=>sim.cancel(id),setInterval:(fn,ms)=>sim.schedule(fn,ms,ms,this),clearInterval:id=>sim.cancel(id),
      localStorage:{getItem:()=>null,setItem(){}},console:{log(){},warn:(...a)=>this.logs.push({at:sim.now,warning:String(a[0])}),error:(...a)=>{throw Error(a.join(' '));}},
      fetch:async()=>({ok:true,json:async()=>({audio:[],subtitles:[]})}),alert(){},URLSearchParams});
    vm.runInContext(source,context,{filename:'room_player.js'});this.init();
  }
  receive(event,data){this.handlers[event]?.(data);}
}
const results=[];
function check(condition,details){return {pass:!!condition,details};}
async function test(name,fn){await rpc({op:'reset'});const sim=new Sim();try{const result=await fn(sim);results.push({name,...result});console.log(`${result.pass?'PASS':'FAIL'} ${name}: ${result.details}`);}catch(e){results.push({name,pass:false,harnessError:e.stack});console.error('HARNESS ERROR',name,e.stack);}}

async function main(){
 await test('Host pause aligns all 15 viewers to within 50ms',async s=>{
   for(let i=0;i<15;i++)await s.join(i,{latency:(i%5)*300,startup:50});
   await s.advance(3000);await s.host('user_play',120);await s.advance(5000);
   const host=s.clients.get(0);const target=host.video.currentTime;
   for(const [id,c] of s.clients)if(id)c.video.currentTime=target+(id%2?0.65:-0.4);
   host.playButton.dispatch('click');await s.advance(5000);
   const drift=Math.max(...[...s.clients.values()].map(c=>Math.abs(c.video.currentTime-target)));
   return check(drift<=0.05&&[...s.clients.values()].every(c=>c.video.paused),`paused max drift=${drift.toFixed(4)}s`);
 });
 await test('Paused downtime retries a seek the media element initially ignores',async s=>{
   await s.join(0);const c=await s.join(1);await s.advance(1000);await s.host('user_play',120);await s.advance(5000);
   let position=c.video.currentTime,ignore=true;
   Object.defineProperty(c.video,'currentTime',{get:()=>position,set:value=>{if(c.video.paused&&ignore&&Math.abs(value-position)>2){ignore=false;return;}position=value;},configurable:true});
   await s.host('user_pause',150);await s.advance(6000);
   return check(c.video.paused&&Math.abs(position-150)<=0.05,`position=${position.toFixed(4)}s; target=150s`);
 });
 await test('15-user mixed-speed lifecycle soak (10 simulated minutes)',async s=>{
   for(let i=0;i<10;i++)await s.join(i,{latency:[20,80,200,600,1200][i%5],startup:[100,500,2000,5000,9000][i%5]});
   await s.advance(12000);s.clients.get(0).playButton.dispatch('click');await s.advance(15000);
   for(let i=10;i<15;i++)await s.join(i,{latency:[20,200,800,1200,1800][i-10],startup:[100,800,3000,6000,10000][i-10]});
   await s.advance(20000);const peaks=s.clients.size;const drifts=[];
   for(let round=0;round<20;round++){
     if(round%3===0)await s.refresh(3+round%10);
     if(round%4===0){await s.leave(14);await s.advance(2000);await s.join(14,{latency:1800,startup:9000});}
     if(round%5===0){s.clients.get(0).playButton.dispatch('click');await s.advance(5000);s.clients.get(0).playButton.dispatch('click');}
     await s.advance(25000);
     const host=s.clients.get(0).video;
     for(const [id,c] of s.clients)if(id!==0)drifts.push(Math.abs(c.video.currentTime-host.currentTime));
   }
   await s.advance(25000);
   const state=await s.server({op:'state'});const pauses=[...s.clients.values()].filter(c=>c.video.paused).map(c=>c.id);
   const max=Math.max(...drifts);return check(pauses.length===0&&max<=3&&state.users.length===15,`peak=${peaks}, final users=${state.users.length}, paused=${JSON.stringify(pauses)}, max sampled drift=${max.toFixed(2)}s, simulated=${(s.now/1000).toFixed(0)}s, outgoing=${s.events.length}`);
 });
 for(const native of [false,true]){
  await test(`${native?'Native HLS':'HLS.js'} obsolete load cannot change replacement media`,async s=>{
   await s.join(0);const c=await s.join(1,{startup:5000,native});await s.advance(100);
   const obsolete=native?c.video.listeners.loadedmetadata[0].fn:c.hlsInstances[0].events.manifest;
   await s.server({op:'media',key:'replacement',position:37});await s.advance(6000);
   const before=c.video.currentTime;obsolete();await s.advance(1000);
   return check(c.video.paused&&c.video.currentTime===before&&before===37,`position=${c.video.currentTime}, paused=${c.video.paused}`);
  });
  await test(`${native?'Native HLS':'HLS.js'} slow join: host pauses before metadata`,async s=>{
   await s.join(0);await s.advance(1000);await s.host('user_play',100);const c=await s.join(1,{startup:8000,native});await s.advance(1000);await s.host('user_pause',101);await s.advance(10000);
   return check(c.video.paused,`room paused; viewer paused=${c.video.paused}, position=${c.video.currentTime.toFixed(2)}`);
  });
  await test(`${native?'Native HLS':'HLS.js'} slow join: host plays before metadata`,async s=>{
   await s.join(0);await s.advance(1000);const c=await s.join(1,{startup:8000,native});await s.advance(1000);await s.host('user_play',100);await s.advance(10000);
   return check(!c.video.paused,`room playing; viewer paused=${c.video.paused}, position=${c.video.currentTime.toFixed(2)}`);
  });
 }
 await test('Host buffer recovery resumes room',async s=>{
   const h=await s.join(0);const v=await s.join(1);await s.advance(1000);await s.host('user_play',50);await s.advance(5000);
   h.video.readyState=2;h.video.dispatch('waiting');await s.advance(1000);h.video.readyState=4;h.video.dispatch('canplay');await s.advance(5000);
   return check(!h.video.paused&&!v.video.paused,`host paused=${h.video.paused}, viewer paused=${v.video.paused}, buffer_resolved emissions=${h.emitted.filter(e=>e.event==='buffer_resolved').length}`);
 });
 await test('Fast buffer recovery waits for slow server acknowledgement',async s=>{
   const h=await s.join(0,{latency:600});const c=await s.join(1);await s.advance(2000);await s.host('user_play',50);await s.advance(5000);
   h.video.readyState=2;h.video.dispatch('waiting');await s.advance(100);h.video.readyState=4;h.video.dispatch('canplay');await s.advance(5000);
   return check(!h.video.paused&&!c.video.paused,`host paused=${h.video.paused}, viewer paused=${c.video.paused}`);
 });
 await test('Reconnect after missing host play resumes viewer',async s=>{
   await s.join(0);const c=await s.join(1);await s.advance(1000);await s.host('user_play',30);await s.advance(5000);await s.host('user_pause',35);await s.advance(500);
   const receive=c.receive.bind(c);c.receive=()=>{};await s.host('user_play',35);await s.advance(5000);c.receive=receive;
   const state=await s.server({op:'state'});c.receive('room_state',state.payload);await s.advance(5000);
   return check(!c.video.paused,`same-media reconnect, room playing=${state.payload.is_playing}, viewer paused=${c.video.paused}`);
 });
 await test('Late buffer recovery does not override an intentional host pause',async s=>{
   await s.join(0);await s.join(1);await s.advance(1000);await s.host('user_play',30);await s.advance(5000);
   const active=(await s.server({op:'state'})).payload;
   await s.server({op:'emit',id:0,event:'user_buffering',data:{room_id:'1',current_time:35,buffer_id:'episode',revision:active.revision,media_version:active.media_version}});
   const buffering=(await s.server({op:'state'})).payload;
   if(buffering.status!=='buffering')throw Error('Test precondition: buffering was not accepted');
   await s.advance(200);await s.host('user_pause',35);await s.advance(200);
   await s.server({op:'emit',id:0,event:'buffer_resolved',data:{room_id:'1',current_time:35,buffer_id:'episode',revision:buffering.revision,media_version:buffering.media_version}});await s.advance(1000);
   const state=await s.server({op:'state'});return check(!state.payload.is_playing,`intentional pause followed by delayed buffer_resolved; room playing=${state.payload.is_playing}`);
 });
 await test('Out-of-order playback state cannot undo newer pause',async s=>{
   await s.join(0);const c=await s.join(1);await s.advance(1000);await s.host('user_play',100);
   const stale=(await s.server({op:'state'})).payload;await s.host('user_pause',101);await s.advance(1000);
   c.receive('force_play',stale);await s.advance(4000);return check(c.video.paused,'stale force_play delivered after newer force_pause');
 });
 await test('Intentional viewer pause survives reconnect',async s=>{
   await s.join(0);const c=await s.join(1);await s.advance(1000);await s.host('user_play',100);await s.advance(5000);
   c.playButton.dispatch('click');await s.advance(1000);c.receive('room_state',(await s.server({op:'state'})).payload);await s.advance(4000);
   return check(c.video.paused,'explicit local pause preserved');
 });
 await test('Old media commands are rejected after a media switch',async s=>{
   await s.join(0);await s.advance(1000);const old=(await s.server({op:'state'})).payload;
   await s.server({op:'media',key:'replacement',position:37});await s.advance(1000);
   await s.server({op:'emit',id:0,event:'user_play',data:{room_id:'1',current_time:999,media_version:old.media_version}});
   const state=(await s.server({op:'state'})).payload;
   return check(!state.is_playing&&state.offset===37,`playing=${state.is_playing}, position=${state.offset}`);
 });
 await test('Autoplay denial provides explicit gesture guidance',async s=>{
   await s.join(0);await s.advance(1000);await s.host('user_play',100);const c=await s.join(1,{blocked:true});await s.advance(6000);
   const label=c.status.textContent;const visible=c.syncButton.style.display!=='none';c.blocked=false;c.syncButton.dispatch('click');await s.advance(1000);
   return check(/click|tap|autoplay/i.test(label||'')&&!c.video.paused,`blocked label=${JSON.stringify(label)}, sync button visible=${visible}, user click recovers=${!c.video.paused}`);
 });
 await test('Viewer buffering avoids repeated seeks into unavailable media',async s=>{
   await s.join(0);const c=await s.join(1);await s.advance(1000);await s.host('user_play',30);await s.advance(5000);
   c.stalled=true;c.video.readyState=2;c.video.dispatch('waiting');const start=c.video.currentTime;await s.advance(20000);
   return check(c.video.currentTime===start,`stalled viewer advanced by ${(c.video.currentTime-start).toFixed(2)}s through programmatic seeks`);
 });
 await test('Clock skew +120s keeps viewer within 3 seconds',async s=>{
   await s.join(0);const c=await s.join(1,{skew:120000});await s.advance(1000);await s.host('user_play',100);await s.advance(15000);
   const drift=c.video.currentTime-s.clients.get(0).video.currentTime;return check(Math.abs(drift)<=3,`viewer-host drift=${drift.toFixed(2)}s`);
 });
 await test('Host refresh within grace retains ownership',async s=>{
   for(let i=0;i<15;i++)await s.join(i);await s.advance(1000);await s.host('user_play',60);await s.advance(5000);await s.refresh(0);await s.advance(5000);await s.server({op:'tasks'});
   const state=await s.server({op:'state'});return check(state.host==='0'&&state.users.length===15,`host=${state.host}, unique users=${state.users.length}`);
 });
 await test('Host departure transfers to remaining user',async s=>{
   for(let i=0;i<15;i++)await s.join(i);await s.advance(1000);await s.leave(0);await s.advance(26000);await s.server({op:'tasks'});await s.advance(1000);
   const state=await s.server({op:'state'});return check(state.host==='1'&&state.users.length===14,`host=${state.host}, unique users=${state.users.length}`);
 });
 await test('Viewer cannot pause/play/seek/buffer the room',async s=>{
   for(let i=0;i<15;i++)await s.join(i);await s.advance(1000);await s.host('user_play',100);
   for(let id=1;id<15;id++)for(const event of ['user_play','user_pause','user_seek','user_buffering','buffer_resolved'])await s.server({op:'emit',id,event,data:{room_id:'1',current_time:999,is_playing:false}});
   const state=await s.server({op:'state'});return check(state.payload.offset===100&&state.payload.is_playing,`70 unauthorized viewer commands; playing=${state.payload.is_playing}, offset=${state.payload.offset}`);
 });
 await test('Backend rejects non-finite seek positions',async s=>{
   await s.join(0);await s.advance(1000);await s.server({op:'emit',id:0,event:'user_seek',data:{room_id:'1',current_time:'NaN',is_playing:true}});
   // The bridge JSON encoder emits NaN if invalid state was accepted. Test via a late join.
   try {const state=await s.server({op:'state'});return check(Number.isFinite(state.payload.offset),`offset=${state.payload.offset}`);}catch(e){return check(false,`invalid state accepted; state serialization: ${e.message}`);}
 });
 fs.writeFileSync(path.join(__dirname,'results.json'),JSON.stringify({generatedAt:new Date().toISOString(),sourceHash,source:'static/js/room_player.js + app/routes.py',method:'15 isolated JS VMs, simulated media and network timing, real authenticated Flask-SocketIO test clients, in-memory SQLite',results},null,2)+'\n');
 console.log(`\n${results.filter(x=>x.pass).length}/${results.length} checks passed`);
 process.exitCode=results.every(x=>x.pass)?0:1;
}
main().catch(e=>{console.error(e);process.exitCode=2;}).finally(()=>bridge.stdin.end());
