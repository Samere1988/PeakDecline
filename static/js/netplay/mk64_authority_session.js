/* Server-owned simulation, local prediction, bounded checkpoint delivery. */
(() => {
 'use strict';
 const checkpointWorkerURL=new URL('/games/retro/worker/mk64_checkpoint_worker.js',location.href);
 class KartSession {
  static async create(options){return new KartSession(options);}
  constructor(options){
   Object.assign(this,options);this.frame=1;this.running=false;this.failed=false;this.disposed=false;
   this.lead=4;this.acceptedSequence=-1;this.latest=null;this.ready=false;this.transportSuspended=false;this.queue=Promise.resolve();
   this.receive=packet=>{this.queue=this.queue.then(()=>this.checkpoint(packet)).catch(e=>this.fail(e.message));};
   this.saveStatus=packet=>{if(packet.epoch===this.epoch)document.getElementById('mk64-runtime-status').textContent=packet.message;};
   this.socket.on('kart_snapshot',this.receive);this.socket.on('kart_save_status',this.saveStatus);
   this.decoder=new Worker(checkpointWorkerURL);this.decoding=new Map();
   this.decoder.onmessage=({data})=>{const pending=this.decoding.get(data.sequence);if(!pending)return;
    this.decoding.delete(data.sequence);data.error?pending.reject(Error(data.error)):pending.resolve(data.state);};
   this.decoder.onerror=event=>{console.error('Mario Kart checkpoint worker:',event.message);this.fail('Mario Kart checkpoint decoding failed. Reload to reconnect.');};
   this.frameTiming=new PeakNet.FrameTiming();this.engine={rollbacks:0,confirmed:0};
  }
  latency(ms){if(Number.isFinite(ms)&&ms>=0)this.lead=Math.max(3,Math.min(15,Math.ceil(ms*30/1000)+3));}
  async bindNative(module,input){
   const url=new URL('state-manifest.json',document.getElementById('mk64-game').dataset.buildUrl.startsWith('http')?
    document.getElementById('mk64-game').dataset.buildUrl:new URL(document.getElementById('mk64-game').dataset.buildUrl,location.href));
   const response=await fetch(url,{cache:'no-store'});if(!response.ok)throw Error('Mario Kart snapshot layout is unavailable.');
   this.manifest=await response.json();if(this.disposed)return;
   this.adapter={module,input};this.sim=MK64Native.attach(module,this.manifest,this.players);
   this.client=new MK64Authority.Client(this.sim,{slot:this.spectator?0:this.slot,players:this.players,epoch:this.epoch});
   this.loaded();this.raf=requestAnimationFrame(now=>this.render(now));
  }
  loaded(){this.socket.emit('loaded',{epoch:this.epoch,compatibility:this.game});}
  start(){this.running=true;this.lastProgress=performance.now();}
  suspendTransport(){this.transportSuspended=true;this.ready=false;}
  catchingUp(){return false;}
  decode(packet){return new Promise((resolve,reject)=>{
   this.decoding.set(packet.sequence,{resolve,reject});
   this.decoder.postMessage({type:packet.type,sequence:packet.sequence,base:packet.base,bytes:packet.bytes,payload:packet.payload});
  });}
  async checkpoint(packet){
   if(this.disposed||this.failed||packet.epoch!==this.epoch)return;
   if(!Number.isSafeInteger(packet.sequence)||packet.sequence<=this.acceptedSequence)return;
   if(!this.sim||packet.build!==this.manifest.wasm)throw Error('Mario Kart build changed. Reload to reconnect.');
   if(packet.type==='state'&&packet.frame<=this.client.confirmed){
    this.acceptedSequence=packet.sequence;this.socket.emit('kart_ack',{epoch:this.epoch,sequence:packet.sequence});return;
   }
   const began=performance.now();
   const needs=packet.type==='baseline'||packet.type==='anchor'||this.spectator||this.client.needsState(packet);
   const bytes=needs?await this.decode(packet):null;
   if(this.disposed)return;
   if(packet.type==='baseline'){
    this.baseline=true;
   }
   if(['baseline','anchor','state'].includes(packet.type)&&this.baseline){
    const state={schema:1,build:packet.build,frame:packet.frame,data:bytes||undefined};
    // A spectator follows the authority without creating controller input.
    if(this.spectator){this.sim.restore(state);this.client.confirmed=packet.frame;}
    else this.client.reconcile({...packet,state});
    this.latest=packet;this.latestAt=performance.now();this.ready=true;
    this.engine.rollbacks=this.client.metrics.corrections;this.engine.confirmed=this.client.confirmed;
    this.lastProgress=this.latestAt;
    this.checkpointMs=this.latestAt-began;
   }else throw Error('Unexpected checkpoint');
   this.acceptedSequence=packet.sequence;
   this.socket.emit('kart_ack',{epoch:this.epoch,sequence:packet.sequence});
  }
  render(now){
   if(this.disposed||this.failed)return;
   try{
    if(this.running&&this.ready&&!this.transportSuspended){
     const active=this.adapter.module._web_state()===4&&!document.hidden;
     this.frameTiming.mark(0,active);
     const age=now-this.latestAt;
     // Bound prediction during a lost transport. Other seats never wait here.
     if(age<1000){
      const target=this.latest.frame+(this.spectator?0:this.lead)+Math.floor(age*30/1000);
      let count=0;
      while(this.sim.frame()<target&&count++<3){
       if(this.spectator)this.sim.step(this.latest.inputs);
       else {
        const input=this.adapter.input,pad={buttons:input.buttons,x:input.x,y:input.y};
        const command=this.client.tick(pad);
        // Not volatile: Socket.IO drops a volatile emit made before the previous
        // one flushes, which lost every extra frame stepped in the same render.
        if(this.socket.connected)this.socket.emit('kart_input',command);
       }
      }
     }
     this.frame=this.sim.frame()+1;
     this.frameTiming.mark(1,active);
     if(!this.displayAt||now-this.displayAt>=1000/60-1){
      this.adapter.module._web_present_pass((age%(1000/30))<1000/60?1:0);this.displayAt=this.displayAt?now-((now-this.displayAt)%(1000/60)):now;
      this.frameTiming.mark(2,active);this.frameTiming.mark(3,active);
     }
    }
   }catch(e){this.fail(e.message);return;}
   this.raf=requestAnimationFrame(time=>this.render(time));
  }
  fail(message){if(this.failed||this.disposed)return;this.failed=true;this.failureMessage=message;
   this.socket.emit('failed',{epoch:this.epoch,message:String(message).slice(0,240)});this.onFailure(message);}
  dispose(){this.disposed=true;this.running=false;cancelAnimationFrame(this.raf);
   this.decoder.terminate();for(const pending of this.decoding.values())pending.reject(Error('Session closed'));this.decoding.clear();
   this.socket.off('kart_snapshot',this.receive);this.socket.off('kart_save_status',this.saveStatus);}
 }
 PeakNet.backends.set('mk64-server-authority-v1',KartSession);
})();
