const assert=require('node:assert/strict');
async function check(browser){
 const account='cmr-profile-'+Date.now(),base='http://127.0.0.1:8088';
 async function start(user){
  const context=await browser.newContext(),page=await context.newPage();await page.goto(base+'/test-login/'+user);
  await page.locator('#retro-open-create').click();await page.locator('#retro-game-select').selectOption('cmr2');await page.locator('#retro-room-name').fill('Profile acceptance');await page.locator('#retro-room-create').click();await page.locator('#retro-ready').click();await page.locator('#retro-start-race').click();
  await page.waitForFunction(()=>window.retroNetplay?.running,null,{timeout:60000});
  return {page,context,frame:page.frames().find(f=>f.url().includes('/runtime/cmr2'))};
 }
 const first=await start(account);let lastMenu,lastMovie,created=false;
 for(let i=0;i<200;i++){
  const value=await first.frame.evaluate(()=>({s:Module.cmr2State,movie:Module.cmr2Movie})),s=value.s;
  if(s?.menu===-1&&value.movie&&value.movie.count!==lastMovie){lastMovie=value.movie.count;await first.frame.evaluate(()=>Module.cmr2SkipMovie=true);}
  console.log('PROFILE_MENU',s);if(await first.frame.evaluate(()=>Module.FS.readdir(Module.cmr2UserDir+'/pps').some(n=>n.endsWith('.pps')))){created=true;break;}
  const choices={1:0,0:1,88:2,29:0,28:0,33:1,34:2,140:2,141:3};
  const choice=choices[s?.menu]??(s?.mode===0&&s.count>0?0:undefined),key=s?.mode+':'+s?.menu;
  if(choice!==undefined&&s.count>choice&&key!==lastMenu){lastMenu=key;await first.frame.evaluate(({menu,index})=>Module.cmr2MenuRequest={menu,index},{menu:s.menu,index:choice});}
  await first.page.waitForTimeout(400);
 }
 assert(created,'Native profile creation must reach car selection');
 await first.frame.evaluate(()=>peakFlushAccountSave());
 const snapshot=await first.page.evaluate(async()=> (await(await fetch('/games/retro/saves/cmr2')).json()).files);
 const profile=Object.keys(snapshot).find(n=>n.startsWith('pps/'));assert(profile,'Native PPS profile must be saved');await first.context.close();
 for(const [user,restore] of [[account,true],[account+'-other',false]]){
  const fresh=await start(user);
  const restored=await fresh.frame.evaluate(name=>{const path=Module.cmr2UserDir+'/'+name;return Module.FS.analyzePath(path).exists?btoa(String.fromCharCode(...Module.FS.readFile(path))):null;},profile);
  assert.equal(restored,restore?snapshot[profile]:null,'Byte-identical native profile restoration and account isolation');await fresh.context.close();
 }
 console.log('PASS native PPS creation, fresh-browser restoration, account isolation');
}
module.exports={check};
if(require.main===module){
 const path=require('node:path'),{firefox}=require(path.join(process.env.HOME,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
 (async()=>{const b=await firefox.launch({headless:true,executablePath:path.join(process.env.HOME,'.cache/ms-playwright/firefox-1543/firefox/firefox'),firefoxUserPrefs:{'dom.webgpu.enabled':true}});try{await check(b);}finally{await b.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
}
