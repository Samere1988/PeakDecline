/* Input-only scripts. Native preview options establish item fixtures before
 * delayed delivery begins; no test writes fighter memory or calls move setters. */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const extended=require('./smash_gameplay_extended.cjs');
const cases={
 ...extended.cases,
 'item-throw':{fighters:'0,1,2,3',frames:1000,item:'8',preview:'hold',required:['held','released']},
 'item-death':{fighters:'0,1,2,3',frames:1400,item:'8',preview:'hold',required:['held','heldDeath','dead','rebirth','invincible']},
 'item-pickup':{fighters:'0,1,2,3',frames:1200,item:'8',preview:'ground',required:['pickup','held','released']},
 'hammer-expiry':{fighters:'0,1,2,3',frames:1600,item:'13',preview:'ground',required:['pickup','held','expired']},
 'raygun-ammo':{fighters:'0,1,2,3',frames:1400,item:'11',preview:'hold',required:['held','ammoUsed','ammoEmpty','projectile','released']},
 'grab-throw':{fighters:'0,1,2,3',frames:1000,required:['caught','captured','thrown','victimThrown']},
 'kirby-copy':{fighters:'8,1,2,3',frames:1600,required:['caught','captured','gainedCopy','copied','copyMove','lostCopy']},
 'kirby-stone':{fighters:'8,1,2,3',frames:1000,required:['stone','stoneEnd']},
};
function configuration(name,root){
 assert.ok(cases[name],'Unknown gameplay scenario: '+name);
 const ids={};
 for(const [file,tag] of [['ft/ftdef.h','FTCommonStatus'],['ft/ftchar/ftkirby/ftkirby.h','ftKirbyStatus'],...['samus','donkey','fox','ness','link'].map(n=>['ft/ftchar/ft'+n+'/ft'+n+'.h','ft'+n[0].toUpperCase()+n.slice(1)+'Status']),['it/itdef.h','ITKind']]){
  const text=fs.readFileSync(path.join(root,'.tmp/battleship-web/decomp/src',file),'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,'');
  const body=text.match(new RegExp('typedef enum[^{}]*\\{([^{}]+)\\s*\\}\\s*'+tag+'\\s*;'))[1];
  let value=-1;
  for(const entry of body.split(',').map(s=>s.trim()).filter(Boolean)){
   const [key,expr]=entry.split('=').map(s=>s.trim());
   value=expr===undefined?value+1:Object.hasOwn(ids,expr)?ids[expr]:Number(expr);
   assert.ok(Number.isInteger(value),'Unresolved status '+entry);ids[key]=value;
  }
 }
 const c=cases[name],env={SSB64_BOOT_SLOTS:'hhoo',...c.env};
 assert.ok(!(c.preview==='hold' && ['0','1'].includes(c.item)), 'Heavy-item fixtures require an ordinary ground pickup.');
 if(c.item){env[c.previewOnly?'SSB64_PREVIEW_ITEM_KIND':'SSB64_FORCE_ITEM_KIND']=c.item;env.SSB64_ITEM_PREVIEW=c.preview;}
 return {name,...c,ids,env,extendedCreate:extended.create.toString()};
}
// Serialized into the browser by smash_browser.cjs. Keep dependencies local.
function create(cfg){
 if(cfg.extended)return (0,eval)("("+cfg.extendedCreate+")")(cfg);
 const neutral=()=>({buttons:0,x:0,y:0});
 const float=n=>new Float32Array(new Int32Array([n]).buffer)[0];
 let copiedAt=0,stoneAt=0,heldAt=0,itemX=null;
 return {input(f,raw){
  const a=raw.slice(0,16),b=raw.slice(16,32),p=neutral();
  // A dead-zone axis change forces a genuine remote-input correction without
  // attacking the subject or affecting the intended local move sequence.
  const remote={buttons:0,x:f%2?1:-1,y:0};
  if(f<430)return [p,remote];
  // Dream Land starts P2 on a platform. Use ordinary down-stick inputs to
  // bring the opponent onto the subject's floor before close-range moves.
  if(['grab-throw','kirby-copy'].includes(cfg.name) && float(b[4])>float(a[4])+200)
   remote.y=f%30<5?-80:0;
  if(cfg.name==='item-pickup' || cfg.name==='hammer-expiry'){
   if(itemX===null)itemX=float(a[3])+a[6]*300;
   if(a[7]){
    if(!heldAt)heldAt=f;
    if(cfg.name==='item-pickup' && f>=heldAt+60 && f<heldAt+63){p.buttons=0xa000;p.y=-80;}
   }else if(!heldAt){
    const dx=itemX-float(a[3]);
    if(Math.abs(dx)>120)p.x=dx<0?-30:30;
    p.buttons=f%30<3?0x8000:0;
   }
  }else if(cfg.name==='raygun-ammo'){
   if(a[7] && a[15]>0)p.buttons=f%30<3?0x8000:0;
   else if(a[7] && f%30<3){p.buttons=0xa000;p.y=-80;}
  }else if(cfg.name==='item-throw'){
   if(f>=500 && f<503){p.buttons=0xa000;p.y=-80;}
  }else if(cfg.name==='item-death'){
   if(f<850)p.x=-79;
  }else if(cfg.name==='kirby-stone'){
   if(a[2]===cfg.ids.nFTKirbyStatusSpecialLwHold && !stoneAt)stoneAt=f;
   if(!stoneAt || f<stoneAt+80){p.buttons=0x4000;p.y=-80;}
   else if(f>=stoneAt+90 && f<stoneAt+93)p.buttons=0x4000;
  }else{
   const dx=float(b[3])-float(a[3]),dir=dx<0?-1:1;
   if(cfg.name==='kirby-copy' && a[8]!==9){
    if(!copiedAt)copiedAt=f;
    if(f<copiedAt+140)p.buttons=f%25<3?0x4000:0;
    else p.buttons=f%60<3?0x20:0;
   }else if(copiedAt){
    // Stop after taunting away the ability; leave the spawned star alive.
   }else if(a[9]){
    if(cfg.name==='kirby-copy')p.y=-80;
    else {p.x=a[6]*80;p.buttons=f%12<3?0x8000:0;}
   }else if(Math.abs(dx)>(cfg.name==='grab-throw'?300:180)){p.x=dir*45;}
   else if(a[6]!==dir){p.x=dir*30;}
   else if(cfg.name==='kirby-copy'){p.buttons=0x4000;}
   else {p.buttons=f%40<3?0xa000:0;}
  }
  return [p,remote];
 }};
}
function verify(cfg,runs){
 if(cfg.extended)return extended.verify(cfg,runs);
 assert.equal(runs.length,2);
 for(const [frame,state] of Object.entries(runs[0].states))
  assert.deepEqual(runs[1].states[frame],state,cfg.name+' confirmed gameplay fields differ at frame '+frame);
 const report=[];
 for(const run of runs){
  const events={};let previous=null;
  const add=(name,f)=>{(events[name]??=[]).push(f);};
  for(const [key,s] of Object.entries(run.states)){
   const f=Number(key),a=s.slice(0,16),b=s.slice(16,32),id=cfg.ids;
   if(a[7])add('held',f);
   if(a[7]===12 && previous?.[7]===12 && a[15]<previous[15])add('ammoUsed',f);
   if(a[7]===12 && a[15]===0)add('ammoEmpty',f);
   if(run.weapons?.[f]>0)add('projectile',f);
   if(f>430 && previous && !previous[7] && a[7])add('pickup',f);
   if(previous?.[7] && !a[7])add('released',f);
   if(previous?.[7]===14 && !a[7] && a[2]>id.nFTCommonStatusDeadUpFall)add('expired',f);
   if(a[9])add('caught',f);
   if(b[10])add('captured',f);
   if(a[2]===id.nFTCommonStatusThrowF || a[2]===id.nFTCommonStatusThrowB)add('thrown',f);
   if(b[2]>=id.nFTCommonStatusThrownStart && b[2]<=id.nFTCommonStatusThrownEnd)add('victimThrown',f);
   if(a[2]<=id.nFTCommonStatusDeadUpFall){add('dead',f);if(previous?.[7]&&!a[7])add('heldDeath',f);}
   if(a[2]>=id.nFTCommonStatusRebirthDown && a[2]<=id.nFTCommonStatusRebirthWait)add('rebirth',f);
   if(f>600 && a[13]>0)add('invincible',f);
   if(a[1]===8 && a[8]!==9)add('copied',f);
   if(previous && a[1]===8 && previous[8]===9 && a[8]!==9)add('gainedCopy',f);
   if(a[2]===id.nFTKirbyStatusCopyFoxSpecialN || a[2]===id.nFTKirbyStatusCopyFoxSpecialAirN)add('copyMove',f);
   if(previous && a[1]===8 && previous[8]!==9 && a[8]===9)add('lostCopy',f);
   if(a[2]===id.nFTKirbyStatusSpecialLwHold)add('stone',f);
   if(a[2]===id.nFTKirbyStatusSpecialLwEnd)add('stoneEnd',f);
   previous=a;
  }
  const coverage={delayed:run.delayed,rollbacks:run.rollbacks,events:{}};
  for(const name of cfg.required){
   const frames=events[name]||[];
   const crossed=frames.filter(f=>run.rewinds.some(r=>r.from<=f && f<r.to));
   coverage.events[name]={frames:frames.length,first:frames[0],last:frames.at(-1),rewoundFrames:crossed.length};
   assert.ok(frames.length,cfg.name+' did not exercise '+name+'; observed '+JSON.stringify(Object.fromEntries(Object.entries(events).map(([n,fs])=>[n,{count:fs.length,first:fs[0]}]))));
   if(run.delayed)assert.ok(crossed.length,cfg.name+' did not rewind '+name);
  }
  report.push(coverage);
 }
 return report;
}
module.exports={cases,configuration,create,verify};
