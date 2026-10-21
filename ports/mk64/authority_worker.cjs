/* One room, one native authority. IPC only: no listening socket or client paths. */
'use strict';
const readline=require('node:readline'),zlib=require('node:zlib');
const {promisify}=require('node:util');
const {createSimulation}=require('./authority_runtime.cjs');
const {Authority}=require('./authority_net.js'),{Codec}=require('./state_codec.js');
const deflate=promisify(zlib.deflate);
let sim,authority,codec,timer,busy=false,started=false,closing=false,sequence=0,lastSave,anchor,bootstrap;
function emit(meta,data=Buffer.alloc(0)){
 const json=Buffer.from(JSON.stringify(meta)),header=Buffer.alloc(8);
 header.writeUInt32LE(4+json.length+data.length);header.writeUInt32LE(json.length,4);
 process.stdout.write(Buffer.concat([header,json,data]));
}
function save(){
 const r=sim.manifest.regions.find(r=>r.symbol==='eeprom');
 const bytes=Buffer.from(sim.module.HEAPU8.subarray(r.address,r.address+512));
 if(lastSave&&!bytes.equals(lastSave))emit({type:'save',data:bytes.toString('base64')});
 lastSave=bytes;
}
function metadata(packet){return {epoch:authority.epoch,frame:packet.frame,hash:packet.hash,
 inputs:packet.inputs,build:sim.manifest.wasm};}
async function checkpoint(force=false){
 if(busy||(!force&&process.stdout.writableLength>1024*1024))return;
 busy=true;
 try{
  const packet=authority.checkpoint(),packed=codec.encode(packet.state.data);
  const data=await deflate(packed,{level:1});
  if(closing)return;
  const meta={...metadata(packet),sequence:++sequence,base:anchor.sequence,bytes:packed.length};
  if(packet.frame-anchor.frame>=30){
   emit({...meta,type:'anchor'},data);
   anchor={...metadata(packet),sequence:meta.sequence};
   codec=new Codec(packet.state.data);bootstrap=null;
   // The same native frame is now a zero-delta state relative to the new anchor.
   const empty=codec.encode(packet.state.data);
   const emptyData=await deflate(empty,{level:1});
   if(!closing)emit({...metadata(packet),type:'state',sequence:++sequence,base:anchor.sequence,bytes:empty.length},emptyData);
  }else emit({...meta,type:'state'},data);
 }finally{busy=false;}
}
async function sendBootstrap(target){
 const meta={...anchor,type:'baseline',bytes:codec.base.length};
 if(!bootstrap||bootstrap.sequence!==anchor.sequence)
  bootstrap={sequence:anchor.sequence,data:deflate(codec.base,{level:1})};
 const data=await bootstrap.data;
 if(!closing)emit({...meta,...(target?{target}:{})},data);
}
async function init(config){
 sim=await createSimulation({...config,nativeMenus:true,save:config.save?Buffer.from(config.save,'base64'):undefined});
 authority=new Authority(sim,{players:config.players,epoch:config.epoch});
 const packet=authority.checkpoint();codec=new Codec(packet.state.data);save();
 anchor={...metadata(packet),sequence:0};
 await sendBootstrap();await checkpoint(true);
}
let ready, ticks=0,next;
const input=readline.createInterface({input:process.stdin});
input.on('line',line=>{
 if(line.length>8192)return process.exit(2);
 try{
  const message=JSON.parse(line);
  if(message.type==='init'&&!ready){ready=init(message).catch(fatal);return;}
  if(!sim||!authority)return;
  if(message.type==='input')authority.receive(message.slot,message);
  else if(message.type==='bootstrap'&&typeof message.target==='string')sendBootstrap(message.target).catch(fatal);
  else if(message.type==='depart')authority.depart(message.slot);
  else if(message.type==='start'&&!started){
   started=true;next=performance.now();
   timer=setInterval(()=>{
    try{
     let steps=0;const now=performance.now();
     while(now>=next&&steps++<4){authority.tick();save();next+=1000/30;ticks++;}
     if(now-next>1000)throw Error('Authority cannot maintain simulation rate');
     if(ticks>=6){ticks=0;checkpoint().catch(fatal);}
    }catch(e){fatal(e);}
   },4);
  }else if(message.type==='stop'){closing=true;save();clearInterval(timer);input.pause();process.stdout.end(()=>process.exit(0));}
 }catch(e){fatal(e);}
});
function fatal(error){console.error(error.stack||error);process.exit(1);}
input.on('close',()=>{clearInterval(timer);process.exit(0);});
