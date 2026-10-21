/* Retained Mario Party sessions using the installed Wasm input ring. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const createCore = require(path.resolve(__dirname, '../../instance/netplay/build/netplay.js'));
(async () => {
 for (const id of ['marioparty', 'marioparty2']) {
  let now = 0, watchdog;
  const sandbox = {performance:{now:()=>now},setInterval(fn){watchdog=fn;return 1;},clearInterval(){}};
  sandbox.window = sandbox; vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../static/js/netplay/session.js'),'utf8'),sandbox);
  const events=[], failures=[];
  const session = new sandbox.PeakNet.Session({socket:{emit:(event,data)=>events.push({event,data})},
   core:await createCore(),game:{id,tickRate:60},epoch:0,players:4,slot:0,spectator:false,onFailure:message=>failures.push(message)});
  const pads = Array.from({length:4},(_,i)=>({buttons:i,x:i*20,y:i ? -i*20 : 0}));
  const packet = frame=>({epoch:0,frame,pads});
  session.bind({sampleInput:()=>pads[0],hashForFrame:()=>123});
  assert.equal(session.recoverable,true);
  session.latency(1);session.start();session.frameReady(1);
  session.receive(packet(1));assert.equal(session.frameReady(1),1);
  session.frameReady(2);session.suspendTransport();
  const before=events.length;
  now=3600000;watchdog();
  assert.deepEqual(failures,[],'a deliberate reconnect pause must not expire the progress watchdog');
  assert.equal(session.frameReady(2),0);assert.equal(events.length,before);
  session.resumeTransport({epoch:0,completed:2,paused:true,frames:[packet(2)]});
  assert.deepEqual(events.slice(before).filter(e=>e.event==='input').map(e=>e.data.frame),[3]);
  assert.equal(session.frameReady(2),0,'wait for the other missing player');
  session.resumeTransport({epoch:0,paused:false});
  assert.equal(session.frameReady(2),1);
  assert.deepEqual(JSON.parse(JSON.stringify(session.getFrame(2))),pads);
  watchdog();assert.equal(session.failed,false,'resume resets the progress watchdog');
  session.suspendTransport();session.resumeTransport({epoch:0,completed:4,frames:[packet(4)]});
  assert.equal(session.failed,true,'missing history fails explicitly rather than silently desyncing');
 }
 for (const id of ['marioparty','marioparty2']) {
  const sandbox = {performance,setInterval(){return 1;},clearInterval(){}};
  sandbox.window=sandbox;vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.resolve(__dirname,'../../static/js/netplay/session.js'),'utf8'),sandbox);
  const events=[],failures=[];
  const session=new sandbox.PeakNet.Session({socket:{emit:(event,data)=>events.push({event,data})},
   core:await createCore(),game:{id,tickRate:60},epoch:4,players:4,slot:2,spectator:false,
   recovery:{through:1301,checkpointFrame:1259},onFailure:message=>failures.push(message)});
  session.bind({sampleInput:()=>({buttons:1,x:0,y:0}),hashForFrame:frame=>{assert.equal(frame,1259);return 777;}});
  session.start();
  for(let frame=1;frame<=1301;frame++) {
   const request=events.findLast(event=>event.event==='party_replay');
   if(session.replayRequested) {
    const start=request.data.start;
    session.receiveReplay({epoch:4,start,through:1301,frames:Array.from({length:Math.min(600,1302-start)},(_,i)=>({
     epoch:4,frame:start+i,pads:Array.from({length:4},()=>({buttons:(start+i)&65535,x:0,y:0}))}))});
   }
   assert.equal(session.frameReady(frame),1);
   assert.ok(session.frames.size<=631);
  }
  assert.equal(session.frameReady(1302),0);
  assert.equal(events.filter(e=>e.event==='input').length,0,'replay must not sample fresh inputs');
  assert.equal(events.filter(e=>e.event==='hash').length,0,'historical checksums must not enter the live protocol');
  assert.deepEqual(JSON.parse(JSON.stringify(events.find(e=>e.event==='party_replay_ready').data)),{epoch:4,frame:1301,hash:777});
  session.replayLive({epoch:4,completed:1301,paused:true});
  assert.equal(session.frameReady(1302),0);
  session.resumeTransport({epoch:4,paused:false});
  session.frameReady(1302);
  assert.equal(events.find(e=>e.event==='input').data.frame,1302);
  assert.deepEqual(failures,[]);session.dispose();
 }
 console.log('PASS: both Mario Party sessions retain inputs, pause without watchdog expiry, resume all four pads and reject replay holes.');
})().catch(error=>{console.error(error);process.exitCode=1;});
