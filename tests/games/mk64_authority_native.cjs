'use strict';
const assert=require('node:assert/strict');
const {createSimulation}=require('../../ports/mk64/authority_runtime.cjs');
const config={build:'.tmp/mk64/candidate-authority',rom:'static/roms/N64/Mario Kart 64 (U) [!].z64'};
const neutral=()=>Array.from({length:2},()=>({buttons:0,x:0,y:0}));
(async()=>{
 const sim=await createSimulation(config);
 console.log('initialized',sim.frame(),sim.bytes,sim.regions.length);
 const snap=sim.snapshot(), hashes=[];
 for(let i=0;i<180;i++) hashes.push(sim.step(neutral()));
 sim.restore(snap);
 for(let i=0;i<180;i++) assert.equal(sim.step(neutral()),hashes[i],`replay frame ${i}`);
 console.log('PASS same-instance replay');
 const other=await createSimulation(config);
 other.restore(sim.snapshot());
 for(let i=0;i<180;i++)assert.equal(other.step(neutral()),sim.step(neutral()),`cross-instance ${i}`);
 console.log('PASS cross-instance snapshot and replay');
 console.log('race',sim.module._web_race_state(),sim.module._web_state());
 const checkpoint=sim.snapshot(), expected=[];
 const drive=i=>[{buttons:0x8000 | (i%37===0?0x2000:0),x:i%120<60?25:-25,y:0}, {buttons:0x8000,x:i%180<90?-15:15,y:0}];
 const start=performance.now();
 for(let i=0;i<1200;i++)expected.push(sim.step(drive(i)));
 const elapsed=performance.now()-start;
 other.restore(checkpoint);
 for(let i=0;i<1200;i++)assert.equal(other.step(drive(i)),expected[i],`race replay ${i}`);
 assert.equal(sim.module._web_race_state(),3);
 console.log('PASS 1200-frame race replay', {simulationMs:elapsed, averageStepMs:elapsed/1200});

})().catch(e=>{console.error(e);process.exitCode=1;});
