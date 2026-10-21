/* Deterministic packet loss/reorder, protocol and reliable-fallback bounds. */
const assert = require('node:assert/strict');
const {RollbackInputTransport, encode, decode} = require('../../static/js/netplay/rollback_transport.js');
class Socket {
 constructor(){this.listeners=new Map();this.sent=[];}
 on(name,fn){const list=this.listeners.get(name)||[];list.push(fn);this.listeners.set(name,list);}
 off(name,fn){this.listeners.set(name,(this.listeners.get(name)||[]).filter(f=>f!==fn));}
 emit(name,data){this.sent.push({name,data});}
 receive(name,data){for(const fn of this.listeners.get(name)||[])fn(data);}
}
class Channel {
 constructor(){Object.assign(this,{label:'rollback-input-v2',ordered:false,maxRetransmits:0,readyState:'open',bufferedAmount:0,packets:[]});}
 send(packet){if(this.throwSend)throw Error('closed');this.packets.push(packet.slice(0));}
 close(){this.readyState='closed';this.onclose?.();}
}
class PC {
 constructor(){this.connectionState='new';}
 createDataChannel(){return this.channel=new Channel();}
 async createOffer(){return {type:'offer',sdp:'offer'};}
 async createAnswer(){return {type:'answer',sdp:'answer'};}
 async setLocalDescription(value){this.localDescription=value;}
 async setRemoteDescription(value){this.remoteDescription=value;}
 async addIceCandidate(value){(this.candidates??=[]).push(value);}
 close(){this.connectionState='closed';this.onconnectionstatechange?.();}
}
function create(slot=0,extra={}){
 const socket=new Socket(),received=[];let frame=1;
 const transport=new RollbackInputTransport({socket,epoch:9,players:2,slot,spectator:false,
  receiveInput:e=>received.push(e),frame:()=>frame,PeerConnection:PC,...extra});
 transport.start();socket.receive('rollback_transport',{epoch:9,slot,players:2,peers:[0,1],iceServers:[]});
 return {socket,transport,received,setFrame:f=>frame=f};
}
const pad=f=>({buttons:f,x:f%80,y:-(f%80)});
(async()=>{
 const a=create(0),b=create(1),remote=b.transport.peers.get(0),incoming=new Channel();
 b.transport.attachChannel(remote,incoming);
 for(let f=1;f<=12;f++)a.transport.send(f,pad(f));
 const outgoing=a.transport.peers.get(1).channel;
 assert.equal(outgoing.packets.length,12);
 // Lose packets 1..5, deliver 8 then 6 then12. Redundant copies repair every input.
 for(const i of [7,5,11,11])incoming.onmessage({data:outgoing.packets[i]});
 assert.deepEqual([...new Set(b.received.map(e=>e.frame))].sort((a,b)=>a-b),Array.from({length:12},(_,i)=>i+1));
 assert.equal(b.received.length,12,'duplicates must not reach the engine twice');
 assert.ok(b.received.every(e=>e.slot===0 && e.epoch===9));
 assert.ok(b.transport.diagnostics().duplicates>0);
 assert.ok(outgoing.packets.at(-1).byteLength<=84,'bounded eight-input packet including selective ACK');
 // Wrong epoch, impossible future, malformed bytes and invalid pad reject atomically.
 const before=b.received.length;
 const future=encode(9,[{frame:130,pad:pad(1)}]);
 const malformed=encode(9,[{frame:13,pad:{buttons:1,x:100,y:0}}]);
 for(const packet of [new ArrayBuffer(0),encode(8,[{frame:13,pad:pad(13)}]),future,malformed])incoming.onmessage({data:packet});
 assert.equal(b.received.length,before);assert.equal(b.transport.diagnostics().invalidPackets,4);
 incoming.onmessage({data:encode(9,[{frame:12,pad:pad(22)}])});
 assert.equal(b.received.length,before+1,'conflicting duplicate must reach existing engine conflict check');
 outgoing.bufferedAmount=17000;assert.equal(a.transport.send(13,pad(13)),false);
 assert.equal(a.transport.diagnostics().backpressureDrops,1);
 outgoing.bufferedAmount=0;outgoing.throwSend=true;assert.equal(a.transport.send(14,pad(14)),false);
 assert.equal(a.transport.diagnostics().openPeers,0);
 assert.equal(a.transport.diagnostics().failedPeers,1);
 // Reliable relay always remains independently usable when RTC fails.
 a.socket.emit('input',{epoch:9,frame:14,pad:pad(14)});
 assert.equal(a.socket.sent.at(-1).name,'input');
 // A stalled TCP journal may trail P2P by at most 120 frames.
 for(let f=15;f<=120;f++)a.transport.send(f,pad(f));
 assert.equal(a.transport.canSend(120),true);assert.equal(a.transport.canSend(121),false);
 a.socket.receive('frameset',{epoch:8,frame:50});assert.equal(a.transport.canSend(121),false);
 a.socket.receive('frameset',{epoch:9,frame:500});assert.equal(a.transport.canSend(121),false);
 a.socket.receive('frameset',{epoch:9,frame:50});assert.equal(a.transport.canSend(170),true);assert.equal(a.transport.canSend(171),false);
 assert.equal(a.transport.diagnostics().relayConfirmed,50);
 a.socket.receive('frameset',{epoch:9,frame:10});assert.equal(a.transport.diagnostics().relayConfirmed,50);
 const offered=a.socket.sent.filter(e=>e.name==='rollback_signal').length;
 a.socket.receive('rollback_peer',{epoch:8,slot:1});assert.equal(a.socket.sent.filter(e=>e.name==='rollback_signal').length,offered);
 a.transport.dispose();b.transport.dispose();
 assert.equal(a.socket.listeners.get('rollback_signal').length,0);
 assert.equal(a.transport.send(121,pad(1)),false);
 // Unsupported browsers, spectators and solo play need no signaling or send bound.
 for(const extra of [{PeerConnection:null},{spectator:true},{players:1}]){
  const inactive=create(0,extra);assert.equal(inactive.socket.sent.length,0);assert.equal(inactive.transport.canSend(500),true);inactive.transport.dispose();
 }
 // Candidate-before-description ordering is handled without negotiation glare.
 const c=create(1),p=c.transport.peers.get(0);
 c.socket.receive('rollback_signal',{epoch:9,from:0,to:1,type:'candidate',value:{candidate:'x'}});
 c.socket.receive('rollback_signal',{epoch:9,from:0,to:1,type:'offer',value:'offer'});
 await p.queue;
 assert.equal(p.pc.remoteDescription.type,'offer');assert.equal(p.pc.candidates.length,1);
 assert.ok(c.socket.sent.some(e=>e.name==='rollback_signal'&&e.data.type==='answer'));
 c.transport.dispose();
 assert.equal(decode(encode(9,[{frame:2,pad:pad(2)},{frame:1,pad:pad(1)}]),9,1),null);
 console.log('Rollback RTC transport: loss, reorder, duplicates, malformed/epoch, failure, bounds and cleanup passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
