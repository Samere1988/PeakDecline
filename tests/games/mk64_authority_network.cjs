'use strict';
const assert=require('node:assert/strict');
const zlib=require('node:zlib');
const {createSimulation}=require('../../ports/mk64/authority_runtime.cjs');
const {Authority,Client}=require('../../ports/mk64/authority_net.js');
const {Codec}=require('../../ports/mk64/state_codec.js');
const config={build:'.tmp/mk64/candidate-authority',rom:'static/roms/N64/Mario Kart 64 (U) [!].z64'};
const zero={buttons:0,x:0,y:0};
(async()=>{
 const serverSim=await createSimulation(config), clientSim=await createSimulation(config);
 const server=new Authority(serverSim),client=new Client(clientSim,{slot:0});
 const initial=server.checkpoint();client.reconcile(initial);
 const codec=new Codec(initial.state.data);
 const commands=[],states=[];let packets=0,totalBytes=0, compressionMs=0;
 // A three-frame client lead represents a 100ms server input buffer.
 for(let i=0;i<3;i++)commands.push({at:i+2,value:client.tick(zero)});
 for(let i=0;i<600;i++){
  const pad={buttons:i>100?0x8000:0,x:i%80<40?30:-30,y:0};
  const message=client.tick(pad);
  // Loss, jitter, duplicates, stale checkpoints and one absent seat.
  if(i%11)commands.push({at:i+1+(i%3),value:message});
  for(let j=commands.length-1;j>=0;j--)if(commands[j].at<=i){server.receive(0,commands[j].value);server.receive(0,commands[j].value);commands.splice(j,1);}
  if(i<200)server.receive(1,{epoch:1,frame:serverSim.frame()+1,pad:{buttons:0x8000,x:0,y:0}});
  if(i===200)server.depart(1);
  const before=serverSim.frame();server.tick();assert.equal(serverSim.frame(),before+1);
  if(i%6===0 && i%23){
   const state=server.checkpoint();states.push({at:i+2+i%4,state});
   if(packets<5){const start=performance.now();const encoded=zlib.deflateSync(codec.encode(state.state.data),{level:1});compressionMs+=performance.now()-start;totalBytes+=encoded.length;packets++;}
  }
  for(let j=states.length-1;j>=0;j--)if(states[j].at<=i){client.reconcile(states[j].state);states.splice(j,1);}
 }
 // Catch the authority up to this client's predicted frame, then corrupt a
 // hashed position. Recovery must happen through reconcile, never a test restore.
 server.depart(0);server.depart(1);
 while(serverSim.frame()<clientSim.frame())server.tick();
 if(serverSim.frame()>clientSim.frame())client.reconcile(server.checkpoint());
 client.tick(zero);server.tick();
 const player=clientSim.manifest.regions.find(r=>r.symbol==='gPlayers');
 const view=new DataView(clientSim.module.HEAPU8.buffer);
 // Player.pos begins at offset 0x14 in the native Player structure.
 view.setFloat32(player.address+0x14,view.getFloat32(player.address+0x14,true)+123,true);
 const final=server.checkpoint();
 assert.notEqual(clientSim.hash(),final.hash,'Fault must alter observable simulation');
 const corrections=client.metrics.corrections;
 assert.equal(client.reconcile(final),true);
 assert.equal(client.metrics.corrections,corrections+1);
 assert.equal(clientSim.hash(),serverSim.hash(),'Automatic correction converges at the authority frame');
 assert.equal(client.reconcile(final),false,'Duplicate checkpoints cannot rewind confirmed state');
 assert.equal(client.reconcile({...final,epoch:2,frame:final.frame+1}),false);
 for(let i=0;i<90;i++){server.receive(0,client.tick(zero));server.tick();assert.equal(clientSim.hash(),serverSim.hash());}
 // A periodic full refresh repairs latent state outside the fast gameplay hash.
 const eeprom=clientSim.manifest.regions.find(r=>r.symbol==='eeprom');
 const beforeHash=clientSim.hash();clientSim.module.HEAPU8[eeprom.address]^=1;
 assert.equal(clientSim.hash(),beforeHash);
 const refreshes=client.metrics.refreshes;
 client.reconcile(server.checkpoint());
 assert(client.metrics.refreshes>refreshes);
 assert.equal(clientSim.module.HEAPU8[eeprom.address],serverSim.module.HEAPU8[eeprom.address]);
 // Codec corruption is rejected, and snapshots decode without earlier packets.
 const encoded=codec.encode(final.state.data);
 assert.deepEqual(codec.decode(encoded),final.state.data);
 assert.throws(()=>codec.decode(encoded.subarray(0,encoded.length-1)));
 const trailing=new Uint8Array(encoded.length+1);trailing.set(encoded);
 assert.throws(()=>codec.decode(trailing));
 assert(client.metrics.corrections>0);assert(client.metrics.replayed>0);
 assert.equal(server.last[1].buttons,0);
 assert.equal(server.receive(0,{epoch:2,frame:serverSim.frame()+1,pad:zero}),false);
 console.log('PASS native authority with loss/jitter/duplicates/absent player',JSON.stringify({client:client.metrics,server:server.metrics,compressedSnapshotBytes:totalBytes/packets,compressionMs:compressionMs/packets}));
})().catch(e=>{console.error(e);process.exitCode=1;});
