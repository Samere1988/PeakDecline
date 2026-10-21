/* Same native game on each device, using confirmed controller rows only. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;
 if(root?.PeakNet){root.PeakNet.SynchronizedSession=api.SynchronizedSession;root.PeakNet.backends.set('sync-input-v1',api.SynchronizedSession);}
})(typeof window==='undefined'?null:window,()=>{
 'use strict';
 const neutral=()=>({buttons:0,moveX:0,moveY:0,lookX:0,lookY:0});
 const integer=(n,min,max)=>Number.isInteger(n)&&n>=min&&n<=max;
 class SynchronizedSession {
  static async create(options){return new SynchronizedSession(options);}
  constructor({socket,game,epoch,players,slot,spectator,onFailure,clock=()=>performance.now()}){
   Object.assign(this,{socket,game,epoch,players,slot,spectator,onFailure,clock});
   this.frame=0;this.received=0;this.head=0;this.sent=0;this.lead=6;this.rows=new Map();
   this.failed=false;this.running=false;this.live=false;this.replaying=true;this.transportSuspended=false;this.background=false;
   this.metrics={replayed:0,frames:0,reconnects:0};
  }
  bind(adapter){this.adapter=adapter;this.socket.emit('loaded',{epoch:this.epoch,compatibility:this.game});}
  start(){if(this.running||this.failed)return;this.running=true;this.nextTick=this.clock();if(this.background)this.socket.emit('sync_pause',{epoch:this.epoch});else this.requestHistory();}
  latency(ms){if(Number.isFinite(ms))this.lead=Math.max(6,Math.min(24,Math.ceil(ms/(1000/this.game.tickRate))+3));}
  requestHistory(){
   if(!this.running||this.failed||this.transportSuspended||this.background||this.requested||this.rows.size>=600)return;
   this.requested=true;this.socket.emit('sync_replay',{epoch:this.epoch,start:this.received+1});
  }
  receive(event,history=false){
   if(!this.running||this.failed||this.transportSuspended||this.background||event.epoch!==this.epoch)return;
   try{
    if(!integer(event.start,1,5184001)||!integer(event.count,0,600)||!integer(event.through,0,5184000)||
      event.start+event.count-1>event.through||typeof event.data!=='string'||event.data.length>25600)
      throw new Error('Invalid synchronized controller history.');
    const bytes=Uint8Array.from(atob(event.data),c=>c.charCodeAt(0));
    if(bytes.length!==event.count*this.players*8)throw new Error('Incomplete synchronized controller history.');
    this.head=Math.max(this.head,event.through);
    if(history){this.requested=false;this.readyPending=false;}
    if(event.start>this.received+1){this.requestHistory();return;}
    const view=new DataView(bytes.buffer);
    for(let i=0;i<event.count;i++){
     const frame=event.start+i;if(frame<=this.received)continue;
     // The server retains skipped rows. Pull them after consuming the buffer.
     if(this.rows.size>=1200)break;
     const row=Array.from({length:this.players},(_,slot)=>{
      const at=(i*this.players+slot)*8;
      const command={buttons:view.getUint16(at,true),moveX:view.getInt8(at+2),moveY:view.getInt8(at+3),lookX:view.getInt16(at+4,true),lookY:view.getInt16(at+6,true)};
      if(command.buttons>2047||command.moveX===-128||command.moveY===-128||command.lookX===-32768||command.lookY===-32768)
       throw new Error('Invalid synchronized controller command.');
      return command;
     });
     this.rows.set(frame,row);this.received=frame;
    }
    // Keep catch-up bounded in memory; pull the next chunk after consuming this one.
    if(!this.live&&this.frame>=this.head-32)this.ready();
   }catch(error){this.fail(error.message);}
  }
  ready(){if(this.background||this.transportSuspended||this.readyPending)return;this.readyPending=true;this.socket.emit('sync_ready',{epoch:this.epoch,frame:this.frame});}
  receiveLive(event){
   if(event.epoch!==this.epoch||this.failed||this.background||this.transportSuspended||this.live||!this.readyPending||!integer(event.through,0,5184000))return;
   this.readyPending=false;this.live=true;this.head=Math.max(this.head,event.through);this.sent=event.through;
   if(!this.spectator)for(let i=0;i<this.lead;i++)this.send(neutral());
   if(this.received<this.head)this.requestHistory();
  }
  send(command){this.socket.emit('sync_input',{epoch:this.epoch,frame:++this.sent,command});}
  advance(){
   if(!this.running||this.failed||this.transportSuspended||this.background||!this.adapter)return false;
   const fast=!this.live||this.received-this.frame>24;
   if(this.replaying!==fast){this.replaying=fast;this.adapter.setReplaying?.(fast);this.nextTick=this.clock();}
   if(!fast&&this.clock()<this.nextTick)return false;
   const row=this.rows.get(this.frame+1);
   if(!row){if(this.received<this.head)this.requestHistory();else if(!this.live)this.ready();return false;}
   try{
    this.adapter.step(row);this.rows.delete(++this.frame);this.metrics.frames++;
    if(fast)this.metrics.replayed++;
    this.nextTick=Math.max(this.nextTick+1000/this.game.tickRate,this.clock()-3*1000/this.game.tickRate);
    if(this.live&&!this.spectator){
     const target=this.frame+this.lead;
     while(this.sent<target-1)this.send(neutral());
     if(this.sent<target)this.send(this.adapter.sampleInput());
    }
    if(this.live&&this.frame%120===0)this.socket.emit('sync_hash',{epoch:this.epoch,frame:this.frame,hash:this.adapter.hash()>>>0});
    if(this.rows.size<32&&this.received<this.head)this.requestHistory();
    if(!this.live&&this.frame>=this.head-32)this.ready();
    return true;
   }catch(error){this.fail(error.message);return false;}
  }
  setBackground(hidden){
   hidden=!!hidden;if(this.failed||this.background===hidden)return;
   this.background=hidden;this.live=false;this.requested=false;this.readyPending=false;
   this.nextTick=this.clock();
   if(!this.running||this.transportSuspended)return;
   if(hidden)this.socket.emit('sync_pause',{epoch:this.epoch});
   else this.requestHistory();
  }
  suspendTransport(){this.transportSuspended=true;this.live=false;this.requested=false;this.readyPending=false;}
  resumeTransport(event){
   if(event.epoch!==this.epoch||this.failed)return;
   this.metrics.reconnects++;this.transportSuspended=false;this.live=false;this.requested=false;this.readyPending=false;
   this.nextTick=this.clock();this.requestHistory();
  }
  diagnostics(){return {...this.metrics,frame:this.frame,head:this.head,catchingUp:!this.live||this.replaying};}
  fail(message){if(this.failed)return;this.dispose();this.socket.emit('failed',{epoch:this.epoch,message:String(message).slice(0,240)});this.onFailure(message);}
  dispose(){this.failed=true;this.running=false;this.rows.clear();}
 }
 return {SynchronizedSession};
});
