/* Candidate server-authoritative frame protocol. Server clocks never wait for a seat. */
(function(root,factory){const api=factory();if(typeof module==='object')module.exports=api;else root.MK64Authority=api;})(typeof globalThis==='object'?globalThis:this,()=>{
 'use strict';
 const neutral=()=>({buttons:0,x:0,y:0});
 const valid=p=>p && Number.isInteger(p.buttons)&&p.buttons>=0&&p.buttons<=65535&&Number.isInteger(p.x)&&Math.abs(p.x)<=80&&Number.isInteger(p.y)&&Math.abs(p.y)<=80;
 const clone=p=>({buttons:p.buttons,x:p.x,y:p.y});
 class Authority {
  constructor(sim,{players=2,epoch=1,maxAhead=30,holdFrames=6}={}) {
   Object.assign(this,{sim,players,epoch,maxAhead,holdFrames});
   this.pending=Array.from({length:players},()=>new Map());
   this.last=Array.from({length:players},neutral);this.lastAt=Array(players).fill(-Infinity);
   this.metrics={late:0,duplicate:0,missing:0};
  }
  // Caller derives slot from authenticated membership, never a packet field.
  receive(slot,message){
   if(!Number.isInteger(slot)||slot<0||slot>=this.players||!message||message.epoch!==this.epoch||
      !Number.isSafeInteger(message.frame)||!valid(message.pad))return false;
   const {frame,pad}=message;
   if(frame<=this.sim.frame()){this.metrics.late++;return false;}
   if(frame>this.sim.frame()+this.maxAhead)return false;
   const existing=this.pending[slot].get(frame);
   if(existing){this.metrics.duplicate++;return existing.buttons===pad.buttons&&existing.x===pad.x&&existing.y===pad.y;}
   this.pending[slot].set(frame,clone(pad));return true;
  }
  depart(slot){this.pending[slot].clear();this.last[slot]=neutral();this.lastAt[slot]=-Infinity;}
  tick(){
   const frame=this.sim.frame()+1;
   for(let slot=0;slot<this.players;slot++){
    const input=this.pending[slot].get(frame);
    if(input){this.last[slot]=input;this.lastAt[slot]=frame;}else this.metrics.missing++;
    this.pending[slot].delete(frame);
    if(frame-this.lastAt[slot]>this.holdFrames)this.last[slot]=neutral();
   }
   this.sim.step(this.last);return this.sim.frame();
  }
  checkpoint(){return {epoch:this.epoch,frame:this.sim.frame(),hash:this.sim.hash(),
   inputs:this.last.map(clone),state:this.sim.snapshot()};}
 }
 class Client {
  constructor(sim,{slot,players=2,epoch=1,maxHistory=120}={}){
   Object.assign(this,{sim,slot,players,epoch,maxHistory});this.inputs=new Map();this.hashes=new Map();
   this.remote=Array.from({length:players},neutral);this.confirmed=0;this.restored=0;
   this.metrics={corrections:0,refreshes:0,replayed:0,resets:0};
  }
  tick(pad){
   if(!valid(pad))throw new Error('Invalid client input');
   const frame=this.sim.frame()+1;this.inputs.set(frame,clone(pad));
   const row=this.remote.map(clone);row[this.slot]=clone(pad);
   this.sim.step(row,false);this.hashes.set(frame,this.sim.hash());
   this.prune();return {epoch:this.epoch,frame,pad:clone(pad)};
  }
  needsState(packet){
   const observed=packet.frame===this.sim.frame()?this.sim.hash():this.hashes.get(packet.frame);
   // Periodic full repair also covers latent state outside the fast gameplay hash.
   return observed!==packet.hash||packet.frame-this.restored>=30;
  }
  reconcile(packet){
   if(!packet||packet.epoch!==this.epoch||!Number.isSafeInteger(packet.frame)||packet.frame<=this.confirmed)return false;
   if(packet.frame!==packet.state?.frame||!Array.isArray(packet.inputs)||packet.inputs.length!==this.players||!packet.inputs.every(valid))
    throw new Error('Invalid authority checkpoint');
   const target=this.sim.frame();
   this.remote=packet.inputs.map(clone);
   const observed=packet.frame===target?this.sim.hash():this.hashes.get(packet.frame);
   if(this.needsState(packet)){
    if(observed!==packet.hash)this.sim.module?._web_mark_correction?.();
    this.sim.restore(packet.state);this.restored=packet.frame;this.metrics[observed!==packet.hash?'corrections':'refreshes']++;
    if(target-packet.frame>this.maxHistory){this.inputs.clear();this.hashes.clear();this.metrics.resets++;}
    else for(let f=packet.frame+1;f<=target;f++){
     const row=this.remote.map(clone);row[this.slot]=this.inputs.get(f)||neutral();
     this.sim.step(row);this.hashes.set(f,this.sim.hash());this.metrics.replayed++;
    }
   }
   this.confirmed=packet.frame;this.prune();return true;
  }
  prune(){const before=Math.max(this.confirmed,this.sim.frame()-this.maxHistory);
   for(const map of [this.inputs,this.hashes])for(const f of map.keys())if(f<=before)map.delete(f);}
 }
 return {Authority,Client};
});
