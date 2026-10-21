/* Run real-game scenarios sequentially so latency measurements do not compete
 * with other browser runs. Start retro_test.py --serve --smash beforehand. */
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'../..');
const cases={
 quit:{scenario:'quit',frames:3000},
 teams:{scenario:'teams',players:4,frames:3600},
 rules:{scenario:'rules',frames:5000},
 solo:{scenario:'stock',solo:true,frames:4000},
 timed:{scenario:'timed',frames:6200,matches:1},
 sudden:{scenario:'sudden',frames:6400,matches:1},
 soak:{scenario:'stock',frames:18000,matches:10},
 baseline:{scenario:'stock',frames:3600},
 latency:{scenario:'stock',frames:3600,delay:85,jitter:20,burst:250},
 buffered:{scenario:'stock',frames:3600,delay:85,jitter:20,burst:250,url:'http://127.0.0.1:8067'}
};
const requested=process.argv.slice(2);
// "buffered" additionally needs an isolated fixture on 8067 with input delay 4.
const names=requested.length?requested:Object.keys(cases).filter(name=>name!=='buffered');
for(const name of names)if(!cases[name])throw Error('Unknown Smash scenario: '+name);
const out=path.resolve(process.env.SMASH_SUITE_OUTPUT || path.join(root,'.tmp/smash-suite'));fs.mkdirSync(out,{recursive:true});
(async()=>{
 const summary=[];
 for(const name of names){
  const c=cases[name],log=path.join(out,name+'.log'),report=path.join(out,name+'.json');
  fs.rmSync(report,{force:true});
  const fd=fs.openSync(log,'w'),started=Date.now();
  console.log('Starting Smash',name,JSON.stringify(c));
  const env={...process.env,SMASH_SCENARIO:c.scenario,SMASH_NATIVE_FLOW:'1',SMASH_FULL_INTRO:'',SMASH_EPOCHS:'1',
   SMASH_PLAYERS:String(c.players||2),SMASH_SOLO:c.solo?'1':'',SMASH_FRAMES:String(c.frames),
   SMASH_DELAY_MS:String(c.delay||0),SMASH_JITTER_MS:String(c.jitter||0),SMASH_BURST_MS:String(c.burst||0),
   SMASH_MIN_MATCHES:String(c.matches||2),SMASH_REPORT:report,SMASH_URL:c.url || process.env.SMASH_URL || 'http://127.0.0.1:8066'};
  const code=await new Promise((resolve,reject)=>{
   const child=spawn(process.execPath,[path.join(__dirname,'smash_netplay.cjs')],{cwd:root,env,stdio:['ignore',fd,fd]});
   child.on('error',reject);child.on('exit',resolve);
  }).finally(()=>fs.closeSync(fd));
  summary.push({name,passed:code===0,elapsedMs:Date.now()-started,log,report});
  fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify(summary,null,2));
  console.log('Finished Smash',name,code===0?'PASS':'FAIL',Date.now()-started+' ms');
  if(code!==0){console.error(fs.readFileSync(log,'utf8').slice(-4000));process.exitCode=1;return;}
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
