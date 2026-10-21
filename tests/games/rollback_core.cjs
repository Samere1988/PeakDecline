const assert = require('node:assert/strict');
const {RollbackEngine, RollbackSession} = require('../../static/js/netplay/rollback.js');
const pad = (slot, frame) => ({buttons: (frame % (7+slot) < 3 ? 0x8000 : 0), x: (frame * (slot+3)) % 161 - 80, y: slot});
function fixture(players) {
 let state={rng:123,players:Array.from({length:players},()=>({x:0,hp:100})),items:[],frame:0};
 let captures=0,releases=0,replays=0,effects=0;
 const adapter={
  saveState(){++captures;return structuredClone(state);},
  restoreState(saved){state=structuredClone(saved);},
  releaseState(){++releases;},
  simulateFrame(pads,{frame,replaying}){
   if(replaying)++replays;else ++effects;
   state.frame=frame;state.rng=(Math.imul(state.rng,1664525)+1013904223)>>>0;
   pads.forEach((p,i)=>{state.players[i].x+=p.x; if(p.buttons&0x8000)state.players[(i+1)%players].hp-=1;});
   if(frame%9===0)state.items.push({id:frame,x:state.rng%37});
   if(frame%13===0)state.items.shift();
  },
  hashState(){let h=2166136261;for(const c of JSON.stringify(state))h=Math.imul(h^c.charCodeAt(0),16777619)>>>0;return h;}
 };
 return {adapter,get state(){return state;},get counts(){return {captures,releases,replays,effects};}};
}
for(const players of [1,2,4]) {
 const ref=fixture(players),sim=fixture(players),engine=new RollbackEngine({players,adapter:sim.adapter});
 const queue=[];
 for(let wall=1;wall<=620;wall++) {
  if(wall<=600) for(let slot=0;slot<players;slot++)queue.push({slot,frame:wall,pad:pad(slot,wall),at:wall+(slot===0?0:(wall*7+slot)%6)});
  // Deliver out of order and duplicate each confirmed sample.
  for(const event of queue.filter(e=>e.at===wall).reverse()) {engine.receive(event.slot,event.frame,event.pad);engine.receive(event.slot,event.frame,event.pad);}
  while(engine.frame<=Math.min(wall,600) && engine.advance()){}
 }
 engine.reconcile();
 for(let frame=1;frame<=600;frame++)ref.adapter.simulateFrame(Array.from({length:players},(_,s)=>pad(s,frame)),{frame,replaying:false});
 assert.deepEqual(sim.state,ref.state);assert.equal(engine.frame,601);assert.equal(engine.confirmed,600);
 assert.ok(engine.actual.size<=129);assert.ok(engine.snapshots.size<=6);
 if(players>1)assert.ok(engine.rollbacks>0);
 assert.equal(sim.counts.effects,600);engine.dispose();assert.equal(sim.counts.captures,sim.counts.releases);
 console.log(players+' players: 600 frames match reference; '+engine.rollbacks+' corrections.');
}
{
 const sim=fixture(2),engine=new RollbackEngine({players:2,adapter:sim.adapter});
 for(let frame=1;frame<=6;frame++){engine.receive(0,frame,pad(0,frame));assert.equal(engine.advance(),true);}
 assert.equal(engine.advance(),false,'must stall beyond prediction limit');
 for(let frame=1;frame<=6;frame++)engine.receive(1,frame,pad(1,frame));
 engine.reconcile();assert.equal(engine.confirmed,6);
 assert.throws(()=>engine.receive(1,6,{buttons:1,x:0,y:0}),/Conflicting/);
 assert.throws(()=>engine.receive(2,7,pad(0,7)),/Invalid/);
 assert.throws(()=>engine.receive(1,1000,pad(0,7)),/ahead/);engine.dispose();
}
{
 const sim=fixture(2),engine=new RollbackEngine({players:2,maxPrediction:0,adapter:sim.adapter});
 engine.receive(0,1,pad(0,1));assert.equal(engine.advance(),false);
 engine.receive(1,1,pad(1,1));assert.equal(engine.advance(),true);engine.dispose();
}
// Sessions exercise actual delay seeding, slot routing, confirmed hashes,
// spectators, epoch rejection, and bounded stalls, without a real-time timer.
{
 const players=2,game={inputSchema:'n64-pad-v1',tickRate:30,rollback:{inputDelay:2,maxPrediction:6}};
 const events=[], sessions=[],fixtures=[],errors=[];
 for(let slot=0;slot<3;slot++){
  const f=fixture(players);let sampled=0;f.adapter.sampleInput=()=>pad(slot,++sampled);
  const socket={emit(type,data){events.push({type,data,slot,at:wall+(type==='input'?(data.frame+slot)%4:0)});}};
  var wall=0;
  const session=new RollbackSession({socket,game,epoch:4,players,slot,spectator:slot===2,onFailure:e=>errors.push(e)});
  session.bind(f.adapter);sessions.push(session);fixtures.push(f);
 }
 const rows=new Map();sessions.forEach(s=>s.start());
 for(wall=0;wall<500;wall++){
  for(let i=events.length-1;i>=0;i--){const e=events[i];if(e.at>wall)continue;events.splice(i,1);
   if(e.type==='input'){
    const row=rows.get(e.data.frame)||Array(players).fill(null);row[e.slot]=e.data.pad;rows.set(e.data.frame,row);
    sessions.forEach(s=>s.receiveInput({...e.data,slot:e.slot}));
    if(row.every(Boolean))sessions.forEach(s=>s.receive({...e.data,pads:row}));
   }
  }
  sessions.forEach((s,i)=>{if(s.frame<=300){
   if(i===1){const next=s.beginAdvance();if(next){s.adapter.simulateFrame(next.pads,{frame:next.frame,replaying:false});s.completeAdvance();}}
   else s.advance();
  }});
 }
 sessions.forEach(s=>s.engine.reconcile());assert.deepEqual(errors,[]);
 assert.deepEqual(fixtures[0].state,fixtures[1].state);assert.deepEqual(fixtures[0].state,fixtures[2].state);
 assert.equal(sessions[0].frame,301);assert.equal(sessions[2].sentThrough,0);
 sessions[0].receiveInput({epoch:3,slot:9,frame:-1,pad:null});assert.equal(sessions[0].failed,false);
 sessions.forEach(s=>s.dispose());
 console.log('Sessions: delay, correction, spectator and stale epoch checks passed.');
}
console.log('Rollback tests passed.');
// A coroutine may finish the prepared frame later. Its checksum must not be
// committed before completion, and a second prepare must not overwrite it.
{
 const sim=fixture(1),engine=new RollbackEngine({players:1,adapter:sim.adapter});
 engine.receive(0,1,pad(0,1));
 const next=engine.beginAdvance();
 assert.equal(engine.frame,1); assert.equal(engine.hashes.has(1),false);
 assert.throws(()=>engine.beginAdvance(),/not completed/);
 sim.adapter.simulateFrame(next.pads,{frame:next.frame,replaying:false});
 assert.equal(engine.completeAdvance(),true); assert.equal(engine.frame,2);
 assert.equal(engine.hashes.get(1),sim.adapter.hashState());
 assert.throws(()=>engine.completeAdvance(),/awaiting completion/);
 engine.dispose();
 console.log('Coroutine frame preparation/completion checks passed.');
}
// A remote correction can arrive while native execution has yielded. Retain
// its snapshot until replay and withhold the stale checksum from the server.
{
 const sim=fixture(2),ref=fixture(2),events=[];
 const session=new RollbackSession({socket:{emit:(type,data)=>events.push({type,data})},
  game:{inputSchema:'n64-pad-v1',tickRate:1,rollback:{inputDelay:0,maxPrediction:6}},
  epoch:1,players:2,slot:0,spectator:false,onFailure:e=>assert.fail(e)});
 sim.adapter.sampleInput=()=>pad(0,1);session.bind(sim.adapter);session.start();
 const next=session.beginAdvance();
 sim.adapter.simulateFrame(next.pads,{frame:1,replaying:false});
 session.receiveInput({epoch:1,slot:1,frame:1,pad:pad(1,1)});
 session.completeAdvance();
 assert.equal(events.filter(e=>e.type==='hash').length,0);
 assert.equal(session.engine.snapshots.has(1),true);
 session.engine.reconcile();session.publishHashes();
 ref.adapter.simulateFrame([pad(0,1),pad(1,1)],{frame:1,replaying:false});
 assert.deepEqual(sim.state,ref.state);
 assert.equal(events.find(e=>e.type==='hash').data.hash,ref.adapter.hashState());
 session.dispose();
 console.log('Corrections during pending coroutine frames retain history and publish corrected hashes.');
}
