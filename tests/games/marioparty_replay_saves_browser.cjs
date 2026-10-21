/* Replay must start from the match save and never upload intermediate EEPROM. */
const assert=require('node:assert/strict'),path=require('node:path');
const {chromium}=require(path.join(process.env.HOME,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:path.join(process.env.HOME,'.cache/ms-playwright/chromium-1243/chrome-linux64/chrome')});
 try {
  const page=await browser.newPage();await page.goto('http://127.0.0.1:8078/test-login/replay-saves-'+Date.now());
  await page.addScriptTag({url:'/static/js/account_sync.js'});
  const result=await page.evaluate(async()=>{
   const url='/games/saves/marioparty', file=value=>({'marioparty.eep':PeakSaves.encode(new Uint8Array(512).fill(value))});
   let files={};const read=async()=>files,write=async f=>{files=f;};
   const original=await (await fetch(url)).json();
   const first=await PeakSaves.connect({url,read,write});files=file(7);await first.stop();
   let replaying=true;
   const replay=await PeakSaves.connect({url,read,write,initial:original,replay:()=>replaying});
   const initialFiles=files;
   files=file(3);await replay.flush();
   const during=await(await fetch(url)).json();
   replaying=false;files=file(9);await replay.flush();
   const after=await(await fetch(url)).json();
   // A concurrent update after recovery starts must still trigger conflict handling.
   const response=await fetch(url,{method:'PUT',headers:{'Content-Type':'application/json','X-CSRF-Token':after.csrf},body:JSON.stringify({revision:after.revision,files:file(10)})});
   if(!response.ok)throw Error('Could not set up concurrent save');
   files=file(11);let conflict;
   try{await replay.stop();}catch(e){conflict=e.message;}
   return {initialFiles,during:PeakSaves.decode(during.files['marioparty.eep'])[0],after:PeakSaves.decode(after.files['marioparty.eep'])[0],conflict};
  });
  assert.deepEqual(result.initialFiles,{});assert.equal(result.during,7);assert.equal(result.after,9);assert.match(result.conflict,/conflict/i);
  console.log('PASS: original match save restored, replay uploads suppressed, recovered save uploaded, concurrent save conflict preserved.');
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
