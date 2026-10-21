'use strict';
const assert=require('node:assert/strict');
const {createSimulation}=require('../../ports/mk64/authority_runtime.cjs');
const config={build:'.tmp/mk64/candidate-authority',rom:'static/roms/N64/Mario Kart 64 (U) [!].z64'};
(async()=>{
 for(const [players,nativeMenus] of [[4,false],[2,true]]){
  const sim=await createSimulation({...config,players,nativeMenus});
  const checkpoint=sim.snapshot(),expected=[];
  const row=i=>Array.from({length:players},(_,slot)=>({buttons:nativeMenus?(i%60===0?0x8000:0):0x8000|(i%37===0?0x2000:0),x:nativeMenus?0:(i%120<60?20:-20)*(slot%2?1:-1),y:0}));
  for(let i=0;i<600;i++)expected.push(sim.step(row(i)));
  const final=sim.frame();
  assert.throws(()=>sim.restore({...checkpoint,frame:checkpoint.frame+1}));
  assert.equal(sim.frame(),final,'Invalid restore must not mutate native memory');
  sim.restore(checkpoint);
  for(let i=0;i<600;i++)assert.equal(sim.step(row(i)),expected[i],`players=${players}, menus=${nativeMenus}, frame=${i}`);
  console.log('PASS mode replay',JSON.stringify({players,nativeMenus,menu:sim.module._web_menu(),game:sim.module._web_state()}));
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
