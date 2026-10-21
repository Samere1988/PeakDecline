const assert=require('node:assert/strict'),path=require('node:path');
const {chromium}=require(path.join(process.env.HOME,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:path.join(process.env.HOME,'.cache/ms-playwright/chromium-1243/chrome-linux64/chrome')});
 try{
  const account='save-test-'+Date.now();
  async function pc(user,initial={}){
   const page=await (await browser.newContext()).newPage();
   await page.goto('http://127.0.0.1:8076/test-login/'+user);
   await page.addScriptTag({url:'/static/js/netplay/account_saves.js'});
   await page.evaluate(async({user,initial})=>{
    document.body.dataset.saveUrl='/games/retro/saves/devilutionx';document.body.dataset.saveKey=user;
    window.files=initial;
    const fs={readdir:()=>Object.keys(files),readFile:p=>new TextEncoder().encode(files[p.split('/').pop()]),unlink:p=>delete files[p.split('/').pop()],writeFile:(p,v)=>files[p.split('/').pop()]=new TextDecoder().decode(v),syncfs:(populate,cb)=>cb()};
    window.store=await PeakAccountSaves(fs,'/saves',/^multi_[0-9]+\.sv$/,s=>window.saveStatus=s);
   },{user,initial});return page;
  }
  const first=await pc(account,{'multi_0.sv':'original hero'});
  const second=await pc(account);
  assert.deepEqual(await second.evaluate(()=>files),{'multi_0.sv':'original hero'});
  const other=await pc(account+'-other');assert.deepEqual(await other.evaluate(()=>files),{});
  await first.evaluate(async()=>{files['multi_0.sv']='advanced hero';await store.flush();});
  const conflict=await second.evaluate(async()=>{files['multi_0.sv']='stale hero';try{await store.flush();return '';}catch(e){return e.message;}});
  assert.match(conflict,/conflict/i);
  assert.equal(await second.evaluate(()=>files['multi_0.sv']),'stale hero');
  const third=await pc(account);assert.equal(await third.evaluate(()=>files['multi_0.sv']),'advanced hero');
  console.log('PASS: browser migration, fresh-PC restore, account isolation, stale-session protection');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
