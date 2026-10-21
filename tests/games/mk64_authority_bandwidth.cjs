'use strict';
const assert=require('node:assert/strict'),zlib=require('node:zlib');
const {createSimulation}=require('../../ports/mk64/authority_runtime.cjs');
const {Codec}=require('../../ports/mk64/state_codec.js');
(async()=>{
 const sim=await createSimulation({build:'.tmp/mk64/candidate-authority',rom:'static/roms/N64/Mario Kart 64 (U) [!].z64'});
 const zero={buttons:0,x:0,y:0};for(let i=0;i<180;i++)sim.step([zero,zero]);
 let codec=new Codec(sim.snapshot().data),receiver=new Codec(codec.base),total=0,count=0,max=0;
 for(let i=1;i<=600;i++){
  sim.step([{buttons:0x8000|(i%50===0?0x2000:0),x:i%90<45?20:-20,y:0},{buttons:0x8000,x:0,y:0}]);
  if(i%6)continue;
  const state=sim.snapshot().data,packet=codec.encode(state),compressed=zlib.deflateSync(packet,{level:1});
  const restored=receiver.decode(zlib.inflateSync(compressed));assert.deepEqual(restored,state);
  total+=compressed.length;count++;max=Math.max(max,compressed.length);
  if(i%30===0){codec=new Codec(state);receiver=new Codec(restored);}
 }
 assert(total/count<150000,'Steady-state checkpoints must not repeat whole course assets');
 console.log('PASS rolling checkpoint codec',JSON.stringify({samples:count,meanBytes:Math.round(total/count),maxBytes:max,kilobitsPerSecond:Math.round(total*8/20/1000)}));
})().catch(e=>{console.error(e);process.exitCode=1;});
