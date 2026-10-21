/* Real native engines + authenticated Socket.IO + original controller-only flow. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const trace=JSON.parse(fs.readFileSync(require('node:path').join(__dirname,'fixtures/perfectdark-menu-inputs.json'),'utf8')).trace;
const four=process.argv.includes('--four');
const combat=process.argv.includes('--combat');
const playerCount=four?4:2;
const commands=[];
for(const {commands:[count,slot,buttons,moveX,moveY]} of trace)
 for(let n=0;n<count;n++)commands.push([slot,buttons,moveX,moveY]);
if(combat)commands.length=2233;
if(four){
 commands.length=2026;
 const neutral=n=>{for(let i=0;i<n;i++)commands.push([-1,0,0,0]);};
 const press=(slot,buttons,settle=60)=>{commands.push([slot,buttons,0,0]);neutral(settle);};
 press(2,128);press(3,128);
 for(let slot=0;slot<4;slot++)press(slot,128);
 neutral(4000);
 for(let slot=0;slot<4;slot++)press(slot,512);
 for(let slot=0;slot<4;slot++)press(slot,128);
 neutral(120);
}
(async()=>{
 const browser=await chromium.launch({headless:true});const pages=[],errors=[];
 try{
  for(let n=0;n<playerCount+1;n++){
   const p=await browser.newPage();pages.push(p);p.on('pageerror',e=>errors.push(e.message));
   await p.goto('http://127.0.0.1:8066/test-login/sync-native-'+n);
   await p.waitForFunction(()=>PeakNet.adapters.has('perfectdark'));
  }
  const host=pages[0],guest=pages[1],watcher=pages[playerCount],playing=pages.slice(0,playerCount),name='Native sync '+Date.now();
  await host.locator('#retro-open-create').click();await host.locator('#retro-game-select').selectOption('perfectdark');
  await host.locator('#retro-room-name').fill(name);await host.locator('#retro-room-create').click();
  for(const p of playing.slice(1)){
   await p.locator('article').filter({hasText:name}).getByRole('button',{name:'Join room',exact:true}).click();
   await p.locator('#retro-choose-player').click();
  }
  for(const p of playing)await p.locator('#retro-ready').click();
  await host.locator('#retro-start-race').click();
  for(const p of playing){
   await p.waitForFunction(()=>window.retroNetplay?.failed||window.retroNetplay?.nativeEngine,null,{timeout:120000});
   assert.equal(await p.evaluate(()=>retroNetplay.failed),false,await p.locator('#retro-runtime-status').textContent());
   await p.evaluate(({commands,combat})=>{
    const s=retroNetplay;window.originalEngine=s.nativeEngine;window.syncStages=[];window.combatEvents=[];window.reloads=0;
    let lastAmmo=0,lastHandState=0,lastWeapon=0;
    const drain=s.nativeEngine.drainEvents.bind(s.nativeEngine);
    s.nativeEngine.drainEvents=()=>{const events=drain();combatEvents.push(...events);return events;};
    let target,combatTick=0;

    s.adapter.sampleInput=()=>{
     if(combat&&s.sent>=commands.length){
      const state=s.nativeEngine.captureComponents(),epoch=state.meta.epoch,id=state.meta.players[s.slot];
      const player=state[`player:${epoch}:${id}`],prop=state[`prop:${epoch}:${id}`];
      const n={buttons:0,moveX:0,moveY:0,lookX:0,lookY:0};
      if(!player||!prop||s.nativeEngine.observeFlow().root!==0)return n;
      combatTick++;
      if(!target){
       const candidates=Object.values(state).filter(p=>p.type===4&&p.enabled&&p.position&&Math.abs(p.position[1]-player.feetGround)<30);
       candidates.sort((a,b)=>Math.hypot(a.position[0]-prop.position[0],a.position[2]-prop.position[2])-Math.hypot(b.position[0]-prop.position[0],b.position[2]-prop.position[2]));
       target=candidates[0]?.position;window.combatTarget=target;
      }
      if(target&&combatTick<1000&&player.weapon===1){
       const dx=target[0]-prop.position[0],dz=target[2]-prop.position[2];
       const angle=(Math.atan2(-dx,dz)*180/Math.PI-player.yaw+540)%360-180;
       return {...n,buttons:combatTick%60===10?32:0,moveY:Math.hypot(dx,dz)>20&&Math.abs(angle)<25?100:0,lookX:Math.round(Math.max(-3,Math.min(3,angle/16))*32767/180)};
      }
      if(player.weapon===1&&player.switchWeapon===-1&&combatTick%60===10)return {...n,buttons:32};
      if(combatTick<1100)return n;
      return {...n,buttons:combatTick%180===150?4:combatTick%20<5?1:0};
     }
     const row=commands[s.sent]||[-1,0,0,0];
     return {buttons:row[0]===s.slot?row[1]:0,moveX:row[0]===s.slot?row[2]:0,moveY:row[0]===s.slot?row[3]:0,lookX:0,lookY:0};
    };
    const step=s.adapter.step.bind(s.adapter);
    s.adapter.step=row=>{step(row);
     if(combat){const m=s.nativeEngine.module,weapon=m._peakPdHandField(s.slot,0,0),state=m._peakPdHandField(s.slot,0,7),ammo=m._peakPdHandField(s.slot,0,11);
      if(weapon===lastWeapon&&ammo>lastAmmo&&lastHandState===1)reloads++;
      lastAmmo=ammo;lastHandState=state;lastWeapon=weapon;
     }
     const stage=s.nativeEngine.observe().stage;if(syncStages.at(-1)!==stage)syncStages.push(stage);};
    s.clock=()=>performance.now()*6;s.nextTick=s.clock();
    s.nativeEngine.setPresentation(false);
   },{commands,combat});
  }
  await host.waitForFunction(()=>retroNetplay.failed||retroNetplay.frame>2500,null,{timeout:120000});
  assert.equal(await host.evaluate(()=>retroNetplay.failed),false,await host.locator('#retro-runtime-status').textContent());
  await watcher.locator('article').filter({hasText:name}).getByRole('button',{name:'Spectate',exact:true}).click();
  await watcher.waitForFunction(()=>window.retroNetplay?.failed||window.retroNetplay?.live,null,{timeout:120000});
  assert.equal(await watcher.evaluate(()=>retroNetplay.failed),false,await watcher.locator('#retro-runtime-status').textContent());
  assert.equal(await watcher.evaluate(()=>retroNetplay.spectator),true);
  console.log('A late spectator reconstructed the real native game from controller history.');
  if(combat){
   await host.waitForFunction(()=>retroNetplay.failed||retroNetplay.frame>5600,null,{timeout:180000});
   let firearm=0,reloads=0;
   for(const p of playing){
    assert.equal(await p.evaluate(()=>retroNetplay.failed),false,await p.locator('#retro-runtime-status').textContent());
    firearm+=await p.evaluate(()=>combatEvents.filter(e=>e.type==='shot'&&e.data.attack==='firearm').length);
    reloads+=await p.evaluate(()=>window.reloads);
   }
   console.log('Combat observations',JSON.stringify(await Promise.all(playing.map(p=>p.evaluate(()=>({target:window.combatTarget,state:retroNetplay.nativeEngine.observe(),reloads:window.reloads}))))));
   assert.ok(firearm>=4,'Native synchronized match must actually pick up and fire weapons');
   assert.ok(reloads>0,'A native reload must refill an existing weapon clip');
   assert.deepEqual(errors,[]);console.log('Native pickups, weapon switching, firing and reload commands stayed synchronized.',{firearm,reloads});return;
  }
  for(const p of playing){
   await p.waitForFunction(total=>retroNetplay.failed||retroNetplay.frame>=total,commands.length,{timeout:240000});
   assert.equal(await p.evaluate(()=>retroNetplay.failed),false,await p.locator('#retro-runtime-status').textContent());
   const result=await p.evaluate(()=>({epoch:retroNetplay.epoch,flow:retroNetplay.nativeEngine.observeFlow(),stages:syncStages,same:originalEngine===retroNetplay.nativeEngine,frame:retroNetplay.frame}));
   assert.equal(result.epoch,0);assert.equal(result.same,true);assert.ok(result.stages.includes(50)&&(four||result.stages.includes(41)));
   assert.equal(result.flow.seats & 15,(1<<playerCount)-1);assert.equal(result.flow.root,3);console.log('Original menus, two results/rematches, arena change:',result.frame,result.stages);
  }
  assert.equal(await watcher.evaluate(()=>retroNetplay.failed),false,await watcher.locator('#retro-runtime-status').textContent());
  if(four){assert.deepEqual(errors,[]);console.log('Four controllers completed native setup, match, results and return to setup.');return;}
  // Exercise the visibility listener with actual native engines and live sockets.
  await guest.evaluate(()=>{
   Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});
   document.dispatchEvent(new Event('visibilitychange'));
  });
  const hiddenFrame=await guest.evaluate(()=>retroNetplay.frame);
  const hostFrame=await host.evaluate(()=>retroNetplay.frame);
  await host.waitForFunction(n=>retroNetplay.frame>n+120,hostFrame,{timeout:15000});
  assert.equal(await guest.evaluate(()=>retroNetplay.frame),hiddenFrame);
  assert.equal(await guest.evaluate(()=>retroNetplay.background),true);
  await guest.evaluate(()=>{
   delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));
  });
  await guest.waitForFunction(()=>retroNetplay.failed||retroNetplay.live,null,{timeout:30000});
  assert.equal(await guest.evaluate(()=>retroNetplay.failed),false);
  assert.equal(await guest.evaluate(()=>retroNetplay.nativeEngine===originalEngine),true);
  assert.ok(await guest.evaluate(()=>retroNetplay.frame)>hiddenFrame);
  console.log('Hidden player released its controller; original native engine caught up on return.');
  // Same-tab transport recovery: the original native engine survives.
  await guest.evaluate(()=>retroNetplay.socket.disconnect());
  const before=await host.evaluate(()=>retroNetplay.frame);
  await host.waitForFunction(before=>retroNetplay.frame>before+60,before,{timeout:15000});
  await guest.evaluate(()=>retroNetplay.socket.connect());
  await guest.waitForFunction(()=>retroNetplay.failed||(!retroNetplay.transportSuspended&&retroNetplay.live),null,{timeout:30000});
  assert.equal(await guest.evaluate(()=>retroNetplay.failed),false);
  assert.equal(await guest.evaluate(()=>retroNetplay.nativeEngine===originalEngine),true);
  console.log('Guest disconnect did not stop the host; reconnect retained the native engine.');
  // Recover a dropped live packet with delayed commands and delivered history.
  await guest.evaluate(()=>{
   const s=retroNetplay;window.savedReceive=s.receive.bind(s);window.savedEmit=s.socket.emit.bind(s.socket);
   window.droppedSyncPacket=false;
   s.receive=(packet,history)=>{
    if(!history&&!droppedSyncPacket){droppedSyncPacket=true;return;}
    setTimeout(()=>savedReceive(packet,history),80);
   };
   s.socket.emit=(name,...args)=>name==='sync_input'?setTimeout(()=>savedEmit(name,...args),80):savedEmit(name,...args);
  });
  const delayedStart=await guest.evaluate(()=>retroNetplay.frame);
  await guest.waitForFunction(start=>retroNetplay.failed||retroNetplay.frame>start+240,delayedStart,{timeout:45000});
  assert.equal(await guest.evaluate(()=>retroNetplay.failed),false,await guest.locator('#retro-runtime-status').textContent());
  assert.equal(await guest.evaluate(()=>droppedSyncPacket),true);
  await guest.evaluate(()=>{retroNetplay.receive=savedReceive;retroNetplay.socket.emit=savedEmit;});
  console.log('Missing live input history recovered under 80 ms each-way application delays.');
  for(const p of [guest,host]){
   const other=p===guest?host:guest;
   const beforeReload=await other.evaluate(()=>retroNetplay.frame);
   await p.reload();
   await p.waitForFunction(()=>window.retroNetplay?.failed||window.retroNetplay?.live,null,{timeout:120000});
   assert.equal(await p.evaluate(()=>retroNetplay.failed),false,await p.locator('#retro-runtime-status').textContent());
   assert.equal(await p.evaluate(()=>retroNetplay.spectator),false);
   assert.equal(await p.evaluate(()=>retroNetplay.epoch),0);
   assert.ok(await other.evaluate(()=>retroNetplay.frame)>beforeReload);
   const flow=await p.evaluate(()=>retroNetplay.nativeEngine.observeFlow());
   assert.equal(flow.root,3);assert.equal(flow.arena,four?50:41);
  }
  console.log('Both guest and original host page reloads reconstructed the continuing native game.');
  const presentationFrame=await host.evaluate(()=>{retroNetplay.nativeEngine.setPresentation(true);return retroNetplay.frame;});
  await host.waitForFunction(n=>retroNetplay.failed||retroNetplay.frame>n+2,presentationFrame,{timeout:15000});
  assert.equal(await host.evaluate(()=>retroNetplay.failed),false);
  await host.locator('#perfectdark-play-area').screenshot({path:'.tmp/perfectdark/sync-live.png'});
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
