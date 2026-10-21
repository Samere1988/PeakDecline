/* A phase change may change input lead, never already committed input history. */
const assert = require('node:assert/strict');
const {RollbackSession, RollbackInputBuffer} = require('../../static/js/netplay/rollback.js');
const neutral = {buttons:0,x:0,y:0};
function fixture({players=2,spectator=false,confirmedInputDelay=8}={}) {
 const events=[],samples=[],errors=[],edges=new RollbackInputBuffer();
 let confirmedMode=true,state=0,live=neutral;
 const session=new RollbackSession({
  socket:{emit:(type,data)=>events.push({type,data:structuredClone(data)})},
  game:{inputSchema:'n64-pad-v1',tickRate:60,rollback:{inputDelay:1,maxPrediction:6,confirmedInputDelay}},
  epoch:7,players,slot:0,spectator,onFailure:e=>errors.push(e)
 });
 const adapter={
  sampleInput({frame}){samples.push(frame);return edges.take(live);},
  confirmedInputMode:()=>confirmedMode,
  canPredict:()=>!confirmedMode,
  saveState:()=>state,restoreState:n=>{state=n;},
  simulateFrame(pads){state=(state+pads.reduce((n,p)=>n+p.buttons,0))>>>0;},
  hashState:()=>state
 };
 session.bind(adapter);session.start();
 return {session,events,samples,errors,adapter,
  mode:value=>{confirmedMode=value;},
  press:pad=>{live=pad;edges.record(pad);},
  remote:frame=>session.receiveInput({epoch:7,slot:1,frame,pad:neutral}),
  inputs:()=>events.filter(e=>e.type==='input').map(e=>e.data)
 };
}
{
 const f=fixture(),s=f.session;
 try {
  f.press({...neutral,buttons:4096});f.press(neutral);
  assert.equal(s.advance(),false,'An expanded pipeline still waits for confirmed menu input');
  const sent=f.inputs();
  assert.deepEqual(sent.map(e=>e.frame),[1,2,3,4,5,6,7,8,9]);
  assert.equal(sent[1].pad.buttons,4096);assert.equal(sent[2].pad.buttons,0,'Brief press/release stays ordered');
  assert.deepEqual(f.samples,[2,3,4,5,6,7,8,9]);
  for(let i=0;i<20;i++)s.advance();
  assert.deepEqual(f.inputs(),sent,'Repeated stalls cannot resample or overwrite sent inputs');
  f.mode(false);
  for(let frame=1;frame<=8;frame++){f.remote(frame);assert.equal(s.advance(),true);}
  assert.deepEqual(f.inputs(),sent,'Shrinking the lead drains the old buffer');
  f.remote(9);assert.equal(s.advance(),true);
  assert.equal(f.inputs().at(-1).frame,10,'Sampling resumes at the normal one-frame combat lead');
  assert.deepEqual(f.samples,[2,3,4,5,6,7,8,9,10]);
  f.mode(true);s.advance();
  assert.deepEqual(f.inputs().map(e=>e.frame),Array.from({length:18},(_,i)=>i+1));
  assert.deepEqual(f.inputs().slice(0,sent.length),sent);
  assert.deepEqual(f.errors,[]);
 } finally {s.dispose();}
}
{
 const f=fixture(),s=f.session;
 try {
  let limit=3;
  s.inputTransport={canSend:frame=>frame<=limit,send(){},dispose(){}};
  s.advance();assert.equal(s.sentThrough,3);
  for(let frame=1;frame<=3;frame++){f.remote(frame);assert.equal(s.advance(),true,'Backpressure must allow buffered frames to drain');}
  assert.equal(s.advance(),false);assert.equal(s.engine.lastStallReason,'relay');
  limit=12;s.advance();
  assert.deepEqual(f.inputs().map(e=>e.frame),Array.from({length:12},(_,i)=>i+1),'Recovery fills all missing frames in order');
  assert.deepEqual(f.errors,[]);
 } finally {s.dispose();}
}
for(const options of [{players:1},{confirmedInputDelay:1},{spectator:true}]) {
 const f=fixture(options);
 try {
  f.session.advance();
  assert.equal(f.session.sentThrough,options.spectator?0:2,'Solo/default/spectator behavior stays bounded');
 } finally {f.session.dispose();}
}
{
 const f=fixture();delete f.adapter.confirmedInputMode;
 try {f.session.advance();assert.equal(f.session.sentThrough,2,'Adapters without phase support retain their delay');}
 finally {f.session.dispose();}
}
for(const confirmedInputDelay of [0,13,true,1.5])assert.throws(()=>fixture({confirmedInputDelay}),/confirmed-input delay/);
console.log('Phase input buffering: ordered edges, immutable history, draining, backpressure, compatibility and bounds passed.');
