/* Real browser RTC channels, with deterministic application-level network
 * delay/loss. This is a transport experiment, not Internet or input-to-photon
 * performance. No game/WASM rendering is involved. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const path=require('node:path'),fs=require('node:fs'),assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE || undefined});
 try{
  const page=await browser.newPage();
  await page.addScriptTag({content:'window.PeakNet={};'});
  await page.addScriptTag({path:path.resolve(__dirname,'../../static/js/netplay/rollback_transport.js')});
  const report=await page.evaluate(async()=>{
   const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
   const sockets=[],ready=new Set(),transports=[],arrivals=new Map();let currentFrame=1,phase='setup';
   class Socket{
    constructor(slot){this.slot=slot;this.listeners=new Map();}
    on(name,fn){const rows=this.listeners.get(name)||[];rows.push(fn);this.listeners.set(name,rows);}
    off(name,fn){this.listeners.set(name,(this.listeners.get(name)||[]).filter(f=>f!==fn));}
    receive(name,data){for(const fn of this.listeners.get(name)||[])fn(data);}
    emit(name,data){
     if(name==='rollback_connect'){
      ready.add(this.slot);
      queueMicrotask(()=>this.receive('rollback_transport',{epoch:1,slot:this.slot,players:2,peers:[...ready],iceServers:[]}));
      for(const other of ready)if(other!==this.slot)queueMicrotask(()=>sockets[other].receive('rollback_peer',{epoch:1,slot:this.slot}));
     }else if(name==='rollback_signal')queueMicrotask(()=>sockets[data.to].receive(name,{...data,from:this.slot}));
    }
   }
   for(let slot=0;slot<2;slot++)sockets.push(new Socket(slot));
   for(let slot=0;slot<2;slot++)transports.push(new PeakNet.RollbackInputTransport({socket:sockets[slot],epoch:1,players:2,slot,
    spectator:false,frame:()=>currentFrame,receiveInput:event=>{
     if(slot===1 && phase!=='setup' && !arrivals.has(event.frame))arrivals.set(event.frame,{at:performance.now(),path:'rtc'});
    }}));
   for(const t of transports)t.start();
   const deadline=performance.now()+10000;
   while(transports.some(t=>t.diagnostics().openPeers!==1)){
    if(performance.now()>deadline)throw Error('RTC data channel did not open');
    await pause(10);
   }
   const channel=transports[0].peers.get(1).channel;
   const options={ordered:channel.ordered,maxRetransmits:channel.maxRetransmits};
   const nativeSend=channel.send.bind(channel);let packet=0,dropped=0;
   channel.send=buffer=>{
    packet++;
    if(packet%20===0){dropped++;return;}
    const copy=buffer.slice(0);
    setTimeout(()=>{if(channel.readyState==='open')nativeSend(copy);},40);
   };
   const results=[];
   for(const mode of ['ordered-relay','rtc-with-relay-fallback','closed-rtc-relay-fallback']){
    phase=mode;arrivals.clear();let relayAt=0;const sampled=new Map(),pending=[];
    if(mode==='closed-rtc-relay-fallback'){
     // Keep RTC unavailable for this fallback-only phase, including retries.
     transports[0].PeerConnection=function(){throw Error('simulated RTC outage');};
     transports[0].failPeer(transports[0].peers.get(1));
    }
    const offset=results.length*180;
    for(let index=1;index<=180;index++){
     const frame=offset+index;currentFrame=frame;
     sampled.set(frame,performance.now());
     const pad={buttons:frame,x:0,y:0};
     // Every 45th input models a 120 ms TCP retransmission stall. Later
     // reliable input is held behind it; the RTC copies do not inherit it.
     relayAt=Math.max(relayAt,performance.now()+40+(index%45===0?120:0));
     pending.push(new Promise(resolve=>setTimeout(()=>{
      if(!arrivals.has(frame))arrivals.set(frame,{at:performance.now(),path:'relay'});
      for(const socket of sockets)socket.receive('frameset',{epoch:1,frame});resolve();
     },Math.max(0,relayAt-performance.now()))));
     if(!transports[0].canSend(frame))throw Error('Unexpected relay lead limit in bounded latency experiment');
     // Record sends even in relay-only phase so relay confirmations use the
     // same transport bookkeeping without sending a peer copy.
     if(mode==='ordered-relay'){
      for(const transport of transports)transport.sentThrough=frame;
     }else{
      // Both seats submit a frame before its complete relay row can exist.
      // This also exercises valid bidirectional acknowledgment frontiers.
      transports[0].send(frame,pad);transports[1].send(frame,pad);
     }
     await pause(1000/60);
    }
    await Promise.all(pending);await pause(100);
    const values=[...sampled].map(([frame,at])=>{
     if(!arrivals.has(frame))throw Error('Input '+frame+' lost');
     return arrivals.get(frame).at-at;
    }).sort((a,b)=>a-b);
    const percentile=p=>Math.round(values[Math.floor((values.length-1)*p)]*100)/100;
    results.push({mode,inputs:sampled.size,received:values.length,medianMs:percentile(.5),p95Ms:percentile(.95),
     maxMs:Math.round(values.at(-1)*100)/100,rtcFirst:[...arrivals.values()].filter(e=>e.path==='rtc').length});
   }
   const metrics=transports.map(t=>t.diagnostics());for(const t of transports)t.dispose();
   return {description:'Real local RTC channels; application-emulated 40 ms transit, relay-only 120 ms ordered stalls every45 inputs, RTC 5% packet loss; sample-to-input-arrival only.',
    options,rtcPacketsDropped:dropped,results,metrics};
  });
  assert.deepEqual(report.options,{ordered:false,maxRetransmits:0});
  assert.ok(report.rtcPacketsDropped>0);
  assert.ok(report.results.every(r=>r.inputs===180&&r.received===180));
  assert.ok(report.results[1].rtcFirst>0);
  assert.equal(report.results[2].rtcFirst,0);
  assert.ok(report.results[1].p95Ms<report.results[0].p95Ms,'Unordered RTC should bypass the emulated ordered stalls');
  if(process.env.ROLLBACK_TRANSPORT_REPORT){fs.mkdirSync(path.dirname(process.env.ROLLBACK_TRANSPORT_REPORT),{recursive:true});fs.writeFileSync(process.env.ROLLBACK_TRANSPORT_REPORT,JSON.stringify(report,null,2));}
  console.log(JSON.stringify(report,null,2));
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
