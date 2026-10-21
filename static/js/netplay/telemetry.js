/* Observe counters only. This never changes game timing, inputs or state. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;
 if(root?.PeakNet){root.PeakNet.Telemetry=api.Telemetry;root.PeakNet.FrameTiming=api.FrameTiming;}
})(typeof window==='undefined'?null:window,()=>{
 'use strict';
 // Opt-in native frame timing. Fixed storage and no allocations in the frame
 // loop; background tabs and transitions into/out of driving are excluded.
 class FrameTiming {
  constructor({clock=()=>performance.now()}={}){this.clock=clock;this.phases=new Float64Array(4);this.phaseMask=0;this.prior=null;this.reset();}
  reset(){this.histogram=new Uint32Array(1001);this.samples=0;this.over50=0;this.over100=0;this.maxMs=0;this.worst=[0,0,0,0];}
  mark(phase,active){
   if(!active){this.prior=null;this.phaseMask=0;return;}
   const now=this.clock();this.phases[phase]=now;this.phaseMask|=1<<phase;
   if(phase!==3)return;
   if(this.prior!==null&&this.phaseMask===15&&this.phases[0]>=this.prior){
    const gap=now-this.prior;
    this.histogram[Math.min(1000,Math.ceil(gap))]++;this.samples++;
    if(gap>50)this.over50++;if(gap>100)this.over100++;
    if(gap>this.maxMs){
     this.maxMs=gap;
     this.worst[0]=this.phases[1]-this.phases[0];
     this.worst[1]=this.phases[2]-this.phases[1];
     this.worst[2]=now-this.phases[2];
     this.worst[3]=this.phases[0]-this.prior;
    }
   }
   this.prior=now;this.phaseMask=0;
  }
  take(){
   if(!this.samples)return null;
   const percentile=fraction=>{let count=0;for(let i=0;i<this.histogram.length;i++){count+=this.histogram[i];if(count>=Math.ceil(this.samples*fraction))return i;}};
   const round=n=>Math.min(600000,Math.round(n*100)/100);
   const result={samples:this.samples,p95Ms:percentile(.95),p99Ms:percentile(.99),maxMs:round(this.maxMs),over50:this.over50,over100:this.over100,
    recordMs:round(this.worst[0]),renderMs:round(this.worst[1]),waitMs:round(this.worst[2]),idleMs:round(this.worst[3])};
   this.reset();return result;
  }
 }
 class Telemetry {
  constructor(session,{clock=()=>performance.now(),hidden=()=>document.hidden}={}){
   this.session=session;this.clock=clock;this.hidden=hidden;this.active=true;
   this.reset(clock());
  }
  frame(){return Math.max(0,(this.session.frame||0)-(this.session.game.backend==='sync-input-v1'?0:1));}
  reset(now){this.start=this.last=now;this.firstFrame=this.lastFrame=this.frame();
   this.displayFrames=0;this.noProgressMs=0;this.hiddenMs=0;this.inactiveMs=0;this.catchupMs=0;
   this.rtts=[];this.probeTimeouts=0;this.probes=0;
  }
  latency(ms){this.probes++;if(Number.isFinite(ms)&&ms>=0)this.rtts.push(Math.min(ms,60000));else this.probeTimeouts++;}
  display(){if(this.active)this.displayFrames++;}
  sample(){
   if(!this.active)return;
   const now=this.clock(),dt=Math.max(0,now-this.last),frame=this.frame(),s=this.session;
   if(this.hidden())this.hiddenMs+=dt;
   else if(!s.running||s.failed||s.transportSuspended)this.inactiveMs+=dt;
   else if(s.replaying||s.recovering)this.catchupMs+=dt;
   else if(frame===this.lastFrame)this.noProgressMs+=dt;
   this.last=now;this.lastFrame=frame;
   if(now-this.start>=10000)this.flush();
  }
  flush(){
   if(!this.active)return;
   const now=this.clock(),s=this.session,windowMs=now-this.start;
   if(windowMs<100)return;
   const packet={epoch:s.epoch,windowMs,frames:Math.max(0,this.frame()-this.firstFrame),frame:this.frame(),
    displayFrames:this.displayFrames,noProgressMs:this.noProgressMs,hiddenMs:this.hiddenMs,
    inactiveMs:this.inactiveMs,catchupMs:this.catchupMs,
    rttMs:this.rtts.length?this.rtts.reduce((a,b)=>a+b,0)/this.rtts.length:null,
    rttMaxMs:this.rtts.length?Math.max(...this.rtts):null,probes:this.probes,probeTimeouts:this.probeTimeouts,
    inputDelayFrames:s.delay??s.lead??0,rollbackCount:s.engine?.rollbacks??0,
    confirmedFrame:s.engine?.confirmed??0,hidden:this.hidden(),
    transport:s.socket.connected===false?'disconnected':s.socket.io?.engine?.transport?.name||'unknown'};
   const render=s.frameTiming?.take();if(render)packet.render=render;
   this.latest=packet;
   // A reconnect must not upload an accumulated queue of stale reports.
   if(s.socket.connected!==false)s.socket.volatile.emit('diagnostics',packet);
   this.reset(now);
  }
  stop(){if(!this.active)return;this.sample();this.flush();this.active=false;clearInterval(this.timer);globalThis.cancelAnimationFrame?.(this.raf);}
  static start(session){
   const monitor=new Telemetry(session);
   monitor.timer=setInterval(()=>monitor.sample(),250);
   const display=()=>{if(!monitor.active)return;monitor.display();monitor.raf=requestAnimationFrame(display);};
   monitor.raf=requestAnimationFrame(display);return monitor;
  }
 }
 return {Telemetry,FrameTiming};
});
