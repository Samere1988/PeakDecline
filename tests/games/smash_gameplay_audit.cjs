/* Targeted, input-driven state transitions with confirmed-input replay oracles. */
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const {cases}=require('./smash_gameplay_scenarios.cjs');
const root=path.resolve(__dirname,'../..');
const out=path.resolve(process.env.SMASH_GAMEPLAY_OUTPUT||'.tmp/smash-gameplay-audit');
const jobs=process.argv.slice(2);if(!jobs.length)jobs.push(...Object.keys(cases));
for(const name of jobs)if(!cases[name])throw Error('Unknown gameplay scenario '+name);
fs.mkdirSync(out,{recursive:true});
(async()=>{
 const results=[];
 for(const name of jobs){
  const c=cases[name],log=path.join(out,name+'.log'),report=path.join(out,name+'.json');
  fs.rmSync(report,{force:true});fs.rmSync(report+'.coverage.json',{force:true});
  const env={...process.env};
  for(const key of Object.keys(env))if(key.startsWith('SMASH_') &&
   !['SMASH_BUILD','SMASH_MIXED_BROWSERS','SMASH_ASSERT_CLEAN_RELOC'].includes(key))delete env[key];
  Object.assign(env,{SMASH_GAMEPLAY_CASE:name,SMASH_PLAYERS:'2',SMASH_STAGE:String(c.stage??6),SMASH_FIGHTERS:c.fighters,
   SMASH_FRAMES:String(c.frames),SMASH_HYBRID:'1',SMASH_REQUIRE_MATERIALS:'1',SMASH_OBJECT_DETAILS:'1',
   SMASH_REPORT:report,SMASH_LOG_PREFIX:path.join(out,name+'-native')});
  const fd=fs.openSync(log,'w');console.log('Starting',name);
  const code=await new Promise((resolve,reject)=>{
   const p=spawn(process.execPath,[path.join(__dirname,'smash_browser.cjs')],{cwd:root,env,stdio:['ignore',fd,fd]});
   p.once('error',reject);p.once('exit',code=>resolve(code??1));
  }).finally(()=>fs.closeSync(fd));
  results.push({name,passed:code===0,log,report});
  fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify(results,null,2)+'\n');
  console.log(name,code===0?'PASS':'FAIL');
  if(code!==0){console.error(fs.readFileSync(log,'utf8').slice(-4500));process.exitCode=1;}
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
