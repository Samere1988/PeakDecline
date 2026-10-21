const assert=require('node:assert/strict');
const {Telemetry,FrameTiming}=require('../../static/js/netplay/telemetry.js');
for(const backend of ['recomp-ring-lockstep-v1','rollback-v1','sync-input-v1','authoritative-host-v1']){
 let now=0,hidden=false;const packets=[];
 const s={frame:backend==='sync-input-v1'?0:1,epoch:3,running:true,failed:false,
  game:{backend},socket:{connected:true,volatile:{emit:(event,data)=>packets.push({event,data})},io:{engine:{transport:{name:'websocket'}}}},delay:2};
 const monitor=new Telemetry(s,{clock:()=>now,hidden:()=>hidden});
 monitor.latency(40);monitor.latency(60);monitor.latency(null);
 for(let i=0;i<40;i++){now+=250;s.frame+=15;for(let j=0;j<15;j++)monitor.display();monitor.sample();}
 const row=packets[0].data;
 assert.equal(row.frames,600);assert.equal(row.windowMs,10000);assert.equal(row.displayFrames,600);
 assert.equal(row.noProgressMs,0);assert.equal(row.rttMs,50);assert.equal(row.rttMaxMs,60);assert.equal(row.probeTimeouts,1);
 assert.equal(row.epoch,3);assert.equal(row.transport,'websocket');
 now+=250;monitor.sample();hidden=true;now+=250;monitor.sample();
 hidden=false;s.replaying=true;now+=250;monitor.sample();s.replaying=false;s.running=false;now+=250;monitor.sample();
 monitor.flush();const contexts=packets[1].data;
 assert.equal(contexts.noProgressMs,250);assert.equal(contexts.hiddenMs,250);assert.equal(contexts.catchupMs,250);assert.equal(contexts.inactiveMs,250);
 s.socket.connected=false;now+=10000;monitor.sample();assert.equal(packets.length,2);
 monitor.stop();monitor.stop();assert.equal(monitor.active,false);
}
console.log('All backend counters, FPS, latency, stall contexts, disconnected delivery and cleanup passed.');

{
 let now=0;const timing=new FrameTiming({clock:()=>now});
 const frame=(record=2,render=3,wait=10,idle=1)=>{
  now+=idle;timing.mark(0,true);now+=record;timing.mark(1,true);
  now+=render;timing.mark(2,true);now+=wait;timing.mark(3,true);
 };
 frame();for(let i=0;i<99;i++)frame();frame(2,103,10,1);
 const sample=timing.take();
 assert.equal(sample.samples,100);assert.equal(sample.p95Ms,16);assert.equal(sample.p99Ms,16);
 assert.equal(sample.maxMs,116);assert.equal(sample.over50,1);assert.equal(sample.over100,1);
 assert.equal(sample.recordMs,2);assert.equal(sample.renderMs,103);assert.equal(sample.waitMs,10);assert.equal(sample.idleMs,1);
 assert.equal(timing.take(),null);
 timing.mark(0,false);now+=10000;frame();frame();
 assert.equal(timing.take().maxMs,16,'returning from a hidden tab or menu is not a driving stall');
 const packets=[],s={frame:1,epoch:0,running:true,game:{backend:'cmr2-server-relay-v1'},frameTiming:timing,
  socket:{connected:true,volatile:{emit:(name,value)=>packets.push(value)}}};
 const monitor=new Telemetry(s,{clock:()=>now,hidden:()=>false});
 for(let i=0;i<100;i++)frame();monitor.flush();
 assert.equal(packets[0].render.samples,100);assert.equal(packets[0].render.maxMs,16);
 s.socket.connected=false;frame();now+=1000;monitor.flush();s.socket.connected=true;
 frame();now+=1000;monitor.flush();assert.equal(packets[1].render.samples,1,'disconnected reports must not accumulate');
}
console.log('Native frame percentiles, worst-frame phases, hidden exclusions and report delivery passed.');
