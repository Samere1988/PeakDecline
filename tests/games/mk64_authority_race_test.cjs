/* Native menus -> two-player GP -> three laps -> results -> next course.
 * CPU steering is a fixture input aid, applied identically before each step. */
'use strict';
const assert=require('node:assert/strict');
const {Codec}=require('../../ports/mk64/state_codec.js');
const zlib=require('node:zlib');
const {createSimulation}=require('../../ports/mk64/authority_runtime.cjs');
const config={build:process.env.MK64_AUTHORITY_BUILD||'.tmp/mk64/candidate-authority',rom:'static/roms/N64/Mario Kart 64 (U) [!].z64',players:2,nativeMenus:true};
const z={buttons:0,x:0,y:0};
(async()=>{
 const sim=await createSimulation(config),m=sim.module;
 const codec=new Codec(sim.snapshot().data);
 const regions=Object.fromEntries(sim.manifest.regions.map(r=>[r.symbol,r.address]));
 const view=()=>new DataView(m.HEAPU8.buffer);
 const state=()=>({menu:m._web_menu(),stage:m._web_main_menu_selection(),players:m._web_selected_players(),game:m._web_state(),race:m._web_race_state()});
 function step(n,row=[z,z]){for(let i=0;i<n;i++)sim.step(row);}
 function tap(slot,buttons=0,x=0){const row=[z,z];row[slot]={buttons,x,y:0};step(4,row);step(18);}
 step(200);
 for(let i=0;i<10;i++){const s=state();if(s.menu===11&&s.stage===3)break;tap(0,s.menu===10?0x1000:0x4000);}
 assert.equal(state().stage,3);
 for(let i=0;i<4&&state().players!==2;i++)tap(0,0,80);
 assert.equal(state().players,2);
 for(let i=0;i<8&&state().menu!==12;i++)tap(0,0x8000);
 for(let slot=0;slot<2;slot++)for(let i=0;i<8&&!m._web_character_selected(slot);i++){if(i)tap(slot,0,80);tap(slot,0x8000);}
 for(let i=0;i<12&&state().game!==4;i++)tap(0,0x8000);
 assert.equal(state().game,4);assert.equal(view().getInt32(regions.gModeSelection,true),0);
 console.log('race snapshot compressed bytes',zlib.deflateSync(codec.encode(sim.snapshot().data),{level:1}).length);
 const replica=await createSimulation(config);
 function cpu(s){const v=new DataView(s.module.HEAPU8.buffer);for(let i=0;i<2;i++){const at=regions.gPlayers+i*0xdd8;v.setUint16(at,v.getUint16(at,true)|0x1000,true);}return s.step([z,z]);}
 let totalFrames=0;const courses=[];
 for(let race=0;race<4;race++){
  const course=view().getInt16(regions.gCurrentCourseId,true);courses.push(course);
  let done=false,frames=0;
  for(let batch=0;batch<40&&!done;batch++){
   const start=sim.snapshot(),hashes=[];
   for(let i=0;i<600;i++){hashes.push(cpu(sim));frames++;
    if([0,1].every(slot=>view().getInt32(regions.gLapCountByPlayerId+4*slot,true)>=3)){done=true;break;}}
   replica.restore(start);
   for(let i=0;i<hashes.length;i++)assert.equal(cpu(replica),hashes[i],`course ${course} replay ${frames-hashes.length+i}`);
  }
  assert(done,`Both players must finish course ${course}`);totalFrames+=frames;
  step(300);replica.restore(sim.snapshot());
  for(let i=0;i<180;i++)assert.equal(replica.step([z,z]),sim.step([z,z]),'Results replay');
  console.log('PASS cup race',JSON.stringify({race:race+1,course,frames}));
  if(race<3){
   for(let i=0;i<30&&view().getInt16(regions.gCurrentCourseId,true)===course;i++)tap(0,0x8000);
   assert.notEqual(view().getInt16(regions.gCurrentCourseId,true),course,'Advance to next course');
   replica.restore(sim.snapshot());
   for(let i=0;i<300;i++)assert.equal(replica.step([z,z]),sim.step([z,z]),'Next course replay');
  }
 }
 assert.equal(new Set(courses).size,4);
 console.log('PASS complete four-race cup and checkpoint replay',JSON.stringify({totalFrames,courses}));
})().catch(e=>{console.error(e);process.exitCode=1;});
