/* Room ownership and transport remain on the server; browsers simulate cars. */
(() => {
 'use strict';
 class CMR2Session {
  static async create(options){return new CMR2Session(options);}
  constructor(options){
   Object.assign(this,options);this.queue=[];this.running=false;this.failed=false;this.frame=0;
   this.playerCount=options.players;this.coordinator=0;this.created=false;this.description=null;this.hasSpectators=false;
   this.onState=event=>{if(event.epoch!==this.epoch||this.failed)return;for(const key of ['created','description','coordinator','playerCount'])if(key in event)this[key]=event[key];};
   this.onEvent=event=>{
    if(event.epoch!==this.epoch||this.spectator||this.failed)return;
    // New car state supersedes a queued state from the same sender.
    if(!event.type&&event.reliable===false&&new Uint8Array(event.payload||[])[0]===11){
     const prior=this.queue.findIndex(e=>!e.type&&e.from===event.from&&e.reliable===false&&new Uint8Array(e.payload||[])[0]===11);
     if(prior>=0)this.queue.splice(prior,1);
    }
    if(this.queue.length>=2048)return this.fail('The game is not keeping up with the room.');
    this.queue.push(event);
   };
   this.onRoom=event=>{if(event.epoch===this.epoch)this.hasSpectators=event.members.some(m=>m.role==='spectator'&&m.connected);};
   this.onMedia=event=>{if(this.running&&this.spectator&&event.epoch===this.epoch){this.socket.emit('cmr2_media_ack',{epoch:this.epoch,sequence:event.sequence});this.media?.(event);}};
   for(const [event,callback] of [['cmr2_state',this.onState],['cmr2_event',this.onEvent],['room_update',this.onRoom],['start',this.onRoom],['cmr2_media',this.onMedia]])this.socket.on(event,callback);
  }
  bind(launch,media){this.launch=launch;this.media=media;this.socket.emit('loaded',{epoch:this.epoch,compatibility:this.game});}
  start(){if(!this.running&&!this.failed){this.running=true;this.launch?.();}}
  command(message){
   if(!this.running||this.failed||this.spectator)return Promise.resolve(0);
   if(message.kind===2||message.kind===4){
    const key='command'+message.kind, signature=Array.from(message.payload).join(',');
    if(this[key]===signature)return Promise.resolve(1);
    this[key]=signature;
   }
   return new Promise(resolve=>this.socket.timeout(10000).emit('cmr2_command',{epoch:this.epoch,...message},(error,result)=>{
    if(error||!result?.ok){this.fail(result?.message||'The room server did not respond.');resolve(0);return;}
    this.onState(result);resolve(1);
   }));
  }
  send(message){
   if(!this.running||this.failed||this.spectator||!this.socket.connected)return false;
   const transport=message.reliable?this.socket:this.socket.volatile;
   transport.emit('cmr2_packet',{epoch:this.epoch,...message});return true;
  }
  canBroadcast(){
   const engine=this.socket.io?.engine;
   return this.running&&!this.failed&&!this.spectator&&this.slot===this.coordinator&&this.hasSpectators&&
    this.socket.connected&&!(engine?.writeBuffer?.length)&&engine?.transport?.writable!==false;
  }
  broadcast(kind,payload){if(this.canBroadcast())this.socket.emit('cmr2_media',{epoch:this.epoch,kind,payload:new Uint8Array(payload)});}
  fail(message){if(this.failed)return;this.failureMessage=message;this.socket.emit('failed',{epoch:this.epoch,message});this.failed=true;this.onFailure(message);}
  nativeClose(){if(this.failed||!this.running)return;this.socket.emit('leave');this.failed=true;this.onFailure('You left the race. Return to lobbies to play again.');}
  latency(){}
  dispose(){this.running=false;this.failed=true;this.queue.length=0;for(const [event,callback] of [['cmr2_state',this.onState],['cmr2_event',this.onEvent],['room_update',this.onRoom],['start',this.onRoom],['cmr2_media',this.onMedia]])this.socket.off(event,callback);this.launch=this.media=null;}
 }
 PeakNet.backends.set('cmr2-server-relay-v1',CMR2Session);
})();
