/* Input-driven edge cases. Every required event must occur under correction,
 * with an independently recorded, confirmed-input execution as the oracle. */
const assert=require('node:assert/strict');
const cases={};
function add(name,fighters,frames,required,extra={}){cases[name]={extended:true,fighters,frames,required,...extra};}
for(const [name,fighter] of [['samus',3],['donkey',2]]){
 add(name+'-charge',fighter+',1,2,3',2000,['charge','cancelled','stored','releasedCharge','fullCharge','fullRelease','chargedDeath','resetAfterDeath']);
 add('kirby-'+name+'-charge','8,'+fighter+',2,3',2400,['copied','charge','cancelled','stored','releasedCharge','fullCharge','fullRelease','chargedDeath','resetAfterDeath'],{copy:true,chargeKind: fighter});
}
add('fox-reflect','0,1,2,3',1200,['projectile','reflected']);
add('ness-absorb','1,11,2,3',1200,['projectile','absorbed']);
add('link-boomerang','5,1,2,3',1100,['boomerangOut','boomerangReturn','boomerangCaught']);
add('shield-break','0,1,2,3',1700,['shieldDrain','shieldBreak','dizzy','recovered']);
add('knockdown-roll','0,2,2,3',1000,['hitstun','knockdown','getupRoll']);
add('special-interrupt','3,1,2,3',1200,['charge','specialInterrupted']);
add('grab-interrupt','0,1,2,3',1200,['grabAttempt','grabInterrupted']);
for(const action of ['climb','attack','roll'])add('ledge-'+action,'0,1,2,3',1200,['ledgeCatch','ledgeInvincible','ledge'+action]);
add('platform-drop','0,1,2,3',900,['platformDrop','landed']);
add('moving-platform','0,1,2,3',1500,['platformRiding'],{stage:2});
for(const [name,item,required] of [
 ['pokeball','19',['releasedItem','pokemon']],
 ['crate','0',['containerDamaged','containerChild']],
 ['barrel','1',['containerPresent','containerChild']],
 ['bobomb','15',['releasedItem','explosion']],
 ['green-shell','17',['releasedItem','movingShell']],
 ['red-shell','18',['releasedItem','movingShell']],
])add('spawn-'+name,(['crate','barrel'].includes(name)?'2':'0')+',1,2,3',1500,required,{item,preview:['crate','barrel'].includes(name)?'ground':'hold',previewOnly:['crate','barrel'].includes(name)});
add('projectile-item-death','0,1,2,3',1000,['ownedProjectile','heldProjectile','heldProjectileDeath','projectileAfterDeath'],{item:'8',preview:'hold'});
add('kirby-copy-projectile','8,5,2,3',1000,['copied','boomerangOut','lostCopyWithProjectile']);

// Serialized into the browser. No imports, game-memory writes or move setters.
function create(cfg){
 const fl=n=>new Float32Array(new Int32Array([n]).buffer)[0];
 const pad=()=>({buttons:0,x:0,y:0});
 let phase=0,at=0,copied=false,launched=false,leftFloor=false,cliffAt=0,done=false,chargeAt=0,chargeCycle=0;
 const id=cfg.ids;
 return {input(f,s,e){
  const a=s.slice(0,16),b=s.slice(16,32),p=pad(),q={buttons:0,x:f%2?1:-1,y:0};
  if(f<430)return[p,q];
  const ax=fl(a[3]),ay=fl(a[4]),bx=fl(b[3]),by=fl(b[4]),dx=bx-ax,dir=dx<0?-1:1;
  const approach=(distance)=>{if(Math.abs(dx)>distance)p.x=dir*45;else if(a[6]!==dir)p.x=dir*30;else return true;return false;};
  const drop=()=>{if(by>ay+200)q.y=f%30<5?-80:0;};
  if(cfg.copy || cfg.name==='kirby-copy-projectile'){
   drop();
   if(a[8]!==9)copied=true;
   if(!copied){
    if(a[9])p.y=-80;
    else if(approach(180))p.buttons=0x4000;
    return[p,q];
   }
  }
  if(cfg.name.endsWith('-charge')){
   const charge=e[cfg.chargeKind===2&&cfg.copy?1:0];
   if(phase===0){if(!at && a[2]===id.nFTCommonStatusWait)at=f;p.buttons=at&&f<at+3?0x4000:0;if(charge>=3){phase=1;at=f;}}
   else if(phase===1){p.buttons=f<at+8?0x2000:0;if(f>at+90){phase=2;at=f;}}
   else if(phase===2){p.buttons=(f-at)%35<3?0x4000:0;if(charge===0 && f>at+40){phase=3;at=f;chargeAt=0;}}
   else if(phase===3){if(f>at+70 && a[2]===id.nFTCommonStatusWait && !chargeAt)chargeAt=f;if(chargeAt)p.buttons=f<chargeAt+3?0x4000:0;if(charge>=(chargeCycle===0?(a[1]===2||cfg.chargeKind===2?10:7):3)){phase=4;at=f;}}
   else if(phase===4){p.buttons=f<at+8?0x2000:0;if(f>at+90){if(chargeCycle===0){chargeCycle=1;phase=2;at=f;}else phase=5;}}
   else if(phase===5){p.x=79;if(a[2]<=id.nFTCommonStatusDeadUpFall)phase=6;}
  }else if(cfg.name==='fox-reflect' || cfg.name==='ness-absorb'){
   drop();if(f>510){q.buttons=0x4000;q.y=-80;}
   if(f>570)p.buttons=f%45<3?0x4000:0;
  }else if(cfg.name==='link-boomerang' || cfg.name==='kirby-copy-projectile'){
   if(!launched && a[2]===id.nFTCommonStatusWait){p.buttons=0x4000;launched=true;at=f;}
   if(cfg.name==='kirby-copy-projectile' && f>at+45)p.buttons=f%30<3?0x20:0;
  }else if(cfg.name==='shield-break'){
   if(a[2]===id.nFTCommonStatusFuraFura){phase=1;p.buttons=f%2?0x8000:0x4000;p.x=f%2?80:-80;}
   else if(!phase)p.buttons=0x2000;
  }else if(cfg.name==='knockdown-roll'){
   drop();
   if(a[2]>=id.nFTCommonStatusDownBounceD && a[2]<=id.nFTCommonStatusDownWaitU){p.x=80;}
   // DK's grounded down-special knocks Mario upward. Chase Mario only before
   // the first hit; later neutral inputs allow a real floor knockdown.
   if(!phase){if(approach(400)){phase=1;at=f;}}
   else if(f<at+160){q.buttons=f%40<3?0x4000:0;q.y=-80;}
  }else if(cfg.name==='special-interrupt' || cfg.name==='grab-interrupt'){
   drop();
   if(cfg.name==='special-interrupt'){
    p.buttons=f===450?0x4000:0;
    if(f>510)q.buttons=f%30<3?0x4000:0;
   }else{
    if(approach(450)){p.buttons=f%35<4?0xa000:0;q.buttons=f%30<3?0x4000:0;}
   }
  }else if(cfg.name.startsWith('ledge-')){
   if(e[7]){if(!cliffAt)cliffAt=f;if(f>cliffAt+45){
    if(cfg.name==='ledge-climb')p.x=a[6]*80;
    if(cfg.name==='ledge-attack')p.buttons=f%8<3?0x8000:0;
    if(cfg.name==='ledge-roll')p.buttons=f%8<3?0x2000:0;
   }}else if(cliffAt){done=true;}
   else if(!done){
    if(phase===0){p.x=-79;if(ax < -2000)phase=1;}
    else if(phase===1){p.x=30;if(a[6]===1){phase=2;at=f;}}
    else if(phase===2){if(f>at+15){p.buttons=8;if(e[5]===1)phase=3;}}
    else {const target=-2420;p.x=Math.abs(ax-target)>20?(ax>target?-45:45):0;}
   }
  }else if(cfg.name==='platform-drop'){
   q.y=f%30<5?-80:0;
  }else if(cfg.name==='moving-platform'){
   if(f<510)p.x=ax < -1000?45:0;
   if((f>=470&&f<473)||(f>=500&&f<503))p.buttons=8;
   // After landing, neutral riders inherit the moving floor's displacement.
  }else if(cfg.name.startsWith('spawn-')){
   if(cfg.previewOnly){p.buttons=f%45<3?0x4000:0;p.y=-80;}
   else if(f>=500&&f<503){p.buttons=0xa000;p.y=-80;}
  }else if(cfg.name==='projectile-item-death'){
   // Carry the bat off the left edge; face inward and throw a fireball while
   // falling, then drift outward into the blast zone.
   if(!leftFloor){p.x=-79;if(e[5]===1 && ax < -2000)leftFloor=true;}
   else {p.x=-79;if(ay < -900 && !launched){p.x=30;phase++;if(phase>2){p.buttons=0x4000;launched=true;}}}
  }
  return[p,q];
 }};
}
function verify(cfg,runs){
 const fl=n=>new Float32Array(new Int32Array([n]).buffer)[0];
 const chunks=(v,n,start=0)=>{const a=[];for(let i=start;i<v.length;i+=n)a.push(v.slice(i,i+n));return a;};
 assert.equal(runs.length,2);
 for(const [f,s] of Object.entries(runs[0].states)){
  assert.deepEqual(runs[1].states[f],s,cfg.name+' gameplay differs at '+f);
  assert.deepEqual(runs[1].extras[f],runs[0].extras[f],cfg.name+' extended state differs at '+f);
  const weapons=run=>chunks(run.weaponDetails[f]||[0],96,1).map(w=>w.slice(0,16));
  assert.deepEqual(weapons(runs[1]),weapons(runs[0]),cfg.name+' weapon state differs at '+f);
 }
 return runs.map(run=>{
  const events={},add=(n,f)=>(events[n]??=[]).push(f),id=cfg.ids;
  let prev=null,prevE=null,prevW=[],charged=false,died=false,dizzy=false,knocked=false,returned=false,prevDir=0;
  for(const [key,s] of Object.entries(run.states)){
   const f=+key,a=s.slice(0,16),b=s.slice(16,32),e=run.extras[f],items=chunks(e,12,129),w=chunks(run.weaponDetails[f]||[0],96,1);
   const charge=e[cfg.copy&&cfg.chargeKind===2?1:0],dead=a[2]<=id.nFTCommonStatusDeadUpFall;
   if(f<430){prev=a;prevE=e;prevW=w;continue;}
   if(a[1]===8 && a[8]!==9)add('copied',f);
   if(charge===(a[1]===2||cfg.chargeKind===2?10:7) && a[2]===id.nFTCommonStatusWait)add('fullCharge',f);
   if(charge>0){charged=true;add('charge',f);if(a[2]===id.nFTCommonStatusWait)add('stored',f);}
   const prefix=a[1]===8?'nFTKirbyStatusCopy'+(cfg.chargeKind===2?'Donkey':'Samus'):'nFT'+(a[1]===2?'Donkey':'Samus')+'Status';
   const releasing=['SpecialNEnd','SpecialAirNEnd','SpecialNFull','SpecialAirNFull'].some(n=>a[2]===id[prefix+n]);
   if(prevE && prevE[cfg.copy&&cfg.chargeKind===2?1:0]>0 && !charge && releasing){add('releasedCharge',f);if(prevE[cfg.copy&&cfg.chargeKind===2?1:0]===(a[1]===2||cfg.chargeKind===2?10:7))add('fullRelease',f);}
   if(charge>0 && charge<(a[1]===2||cfg.chargeKind===2?10:7) && prev?.[2]===id[prefix+'SpecialNLoop'] && a[2]===id.nFTCommonStatusWait)add('cancelled',f);
   if(dead && prevE?.[cfg.copy&&cfg.chargeKind===2?1:0]>0){add('chargedDeath',f);died=true;}
   if(died && !charge && !dead)add('resetAfterDeath',f);
   if(w.length)add('projectile',f);
   if(w.some(v=>v[1]===1&&prevW.some(p=>p[0]===v[0]&&p[2]===v[2]&&p[1]===0)))add('reflected',f);
   if(b[1]===11 && [id.nFTNessStatusSpecialLwHit,id.nFTNessStatusSpecialAirLwHit].includes(b[2]))add('absorbed',f);
   const boom=w.find(v=>v[0]===7&&v[1]===0);
   if(boom){add('boomerangOut',f);const d=Math.sign(fl(boom[13]));if(prevDir && d!==prevDir){add('boomerangReturn',f);returned=true;}if(d)prevDir=d;}
   if(returned&&!boom&&!e[15]&&!dead && prevW.some(v=>v[0]===7&&Math.hypot(fl(v[10])-fl(a[3]),fl(v[11])-fl(a[4]))<450))add('boomerangCaught',f);
   if(prevE && e[11] && e[2]<prevE[2])add('shieldDrain',f);
   if(a[2]>=id.nFTCommonStatusShieldBreakFly&&a[2]<=id.nFTCommonStatusShieldBreakStandU)add('shieldBreak',f);
   if(a[2]===id.nFTCommonStatusFuraFura){dizzy=true;add('dizzy',f);}
   if(dizzy&&a[2]===id.nFTCommonStatusWait)add('recovered',f);
   if(e[12])add('hitstun',f);
   if(a[2]>=id.nFTCommonStatusDownBounceD&&a[2]<=id.nFTCommonStatusDownWaitU){knocked=true;add('knockdown',f);}
   if(knocked&&a[2]>=id.nFTCommonStatusDownForwardD&&a[2]<=id.nFTCommonStatusDownBackU)add('getupRoll',f);
   if(charged&&prev?.[2]>=id.nFTCommonStatusSpecialStart&&e[12]&&a[2]<id.nFTCommonStatusSpecialStart)add('specialInterrupted',f);
   if(a[2]===id.nFTCommonStatusCatch)add('grabAttempt',f);
   if(prev?.[2]===id.nFTCommonStatusCatch&&e[12])add('grabInterrupted',f);
   if(e[7]){add('ledgeCatch',f);if(a[13]||a[14]||a[12]>1)add('ledgeInvincible',f);}
   for(const [action,prefix] of [['climb','CliffClimb'],['attack','CliffAttack'],['roll','CliffEscape']])
    if(['Quick1','Quick2','Slow1','Slow2'].some(suffix=>a[2]===id['nFTCommonStatus'+prefix+suffix]))add('ledge'+action,f);
   if(b[2]===id.nFTCommonStatusPass)add('platformDrop',f);
   if(f>500&&b[2]===id.nFTCommonStatusWait&&fl(b[4])<100)add('landed',f);
   for(const offset of [0,16]){const ex=offset*2;
    if(prevE && e[ex+5]===0&&prevE[ex+5]===0&&e[ex+6]===prevE[ex+6]&&run.states[f-1] &&
      (s[offset+3]!==run.states[f-1][offset+3]||s[offset+4]!==run.states[f-1][offset+4]) &&
      s[offset+2]===id.nFTCommonStatusWait && cfg.name==='moving-platform' && f>550 && e[ex+6]!==run.extras[430][ex+6])add('platformRiding',f);
   }
   if(prev?.[7]&&!a[7])add('releasedItem',f);
   if(items.some(v=>v[0]>=id.nITKindMBallMonsterStart&&v[0]<=id.nITKindMBallMonsterEnd))add('pokemon',f);
   if(cfg.previewOnly && items.some(v=>v[0]===Number(cfg.item)))add('containerPresent',f);
   if(cfg.previewOnly && items.some(v=>v[0]===Number(cfg.item)&&v[3]>0))add('containerDamaged',f);
   if(cfg.previewOnly && prevE && !items.some(v=>v[0]===Number(cfg.item))){
    const parent=chunks(prevE,12,129).find(v=>v[0]===Number(cfg.item));
    // A later natural spawn must not stand in for an actual container drop.
    if(parent && items.some(v=>v[0]>=id.nITKindUtilityStart&&v[0]<=id.nITKindUtilityEnd &&
      Math.hypot(fl(v[6])-fl(parent[6]),fl(v[7])-fl(parent[7]))<500))add('containerChild',f);
   }
   if(items.some(v=>[17,18].includes(v[0])&&Math.abs(fl(v[9]))>1&&!a[7]))add('movingShell',f);
   if(items.some(v=>v[0]===15&&(v[5]&0x100)))add('explosion',f);
   const owned=w.some(v=>v[1]===0);
   if(owned)add('ownedProjectile',f);
   if(owned&&a[7])add('heldProjectile',f);
   if(dead&&prev?.[7]&&prevW.some(v=>v[1]===0)){add('heldProjectileDeath',f);died=true;}
   if(died&&dead&&owned)add('projectileAfterDeath',f);
   if(a[1]===8&&a[8]===9&&prev?.[8]!==9&&boom)add('lostCopyWithProjectile',f);
   prev=a;prevE=e;prevW=w;
  }
  const summary={delayed:run.delayed,rollbacks:run.rollbacks,events:{}};
  for(const name of cfg.required){
   const frames=events[name]||[],crossed=frames.filter(f=>run.rewinds.some(r=>r.from<=f&&f<r.to));
   summary.events[name]={frames:frames.length,first:frames[0],last:frames.at(-1),rewoundFrames:crossed.length};
   assert.ok(frames.length,cfg.name+' did not exercise '+name+'; observed '+JSON.stringify(Object.fromEntries(Object.entries(events).map(([n,v])=>[n,{count:v.length,first:v[0]}]))));
   if(run.delayed)assert.ok(crossed.length,cfg.name+' did not rewind '+name);
  }
  return summary;
 });
}
module.exports={cases,create,verify};
