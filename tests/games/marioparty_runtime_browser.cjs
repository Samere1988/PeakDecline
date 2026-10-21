// Uses only the loopback fixture. MP_NATIVE_FILES verifies the staged HTTP assets.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require(path.join(process.env.HOME,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:path.join(process.env.HOME,'.cache/ms-playwright/chromium-1243/chrome-linux64/chrome')});
 try{
  const pages=[],errors=[],playerCount=Number(process.env.MP_ROOM_PLAYERS||1);
  assert.ok(playerCount>=1&&playerCount<=4);
  const release=process.env.MP_BUILD_DIR;
  for(const user of [...Array.from({length:playerCount},(_,i)=>'native-player-'+i),'native-watcher']){
   const context=await browser.newContext();
   if(!process.env.MP_NATIVE_FILES)await context.route('**/games/retro/build/marioparty/*',async route=>{
    const name=new URL(route.request().url()).pathname.split('/').pop();
    if(name==='marioparty.js')return route.fulfill({contentType:'text/javascript',body:fs.readFileSync(release?path.join(release,'marioparty.js'):'.tmp/marioparty-port/boot-probe.js','utf8').replaceAll('createMarioPartyBootProbe','createMarioParty')});
    if(name.endsWith('.wasm'))return route.fulfill({contentType:'application/wasm',path:release?path.join(release,'marioparty.wasm'):'.tmp/marioparty-port/boot-probe.wasm'});
    await route.abort();
   });
   const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));pages.push(page);
   await page.goto('http://127.0.0.1:8078/test-login/'+user);
  }
  const host=pages[0],watcher=pages.at(-1);
  await host.locator('#retro-open-create').click();await host.locator('#retro-game-select').selectOption('marioparty');
  await host.locator('#retro-room-name').fill('Native MP room');await host.locator('#retro-room-create').click();
  await host.locator('#retro-lobby').waitFor({state:'visible'});
  for(const page of pages.slice(1)){
   await page.getByRole('button',{name:'Join room',exact:true}).click();
   await page.locator('#retro-lobby').waitFor({state:'visible'});
   await page.locator(page===watcher?'#retro-choose-spectator':'#retro-choose-player').click();
  }
  for(const page of pages.slice(0,playerCount))await page.locator('#retro-ready').click();
  await host.locator('#retro-start-race').click();
  const playerPages=pages.slice(0,playerCount);
  const frames=await Promise.all(playerPages.map(async page=>{await page.locator('#marioparty-play-area iframe').waitFor({state:'visible'});const frame=await page.locator('#marioparty-play-area iframe').contentFrame();await frame.locator('#status').waitFor({state:'hidden',timeout:120000});return frame;}));
  await Promise.all(frames.map(frame=>frame.locator('canvas').waitFor({state:'visible'})));
  await host.waitForFunction(()=>document.querySelector('#marioparty-play-area iframe')?.contentWindow?.Module?._mp_rendered_frames()>100,{},{timeout:60000});
  for(const page of playerPages){assert.equal(await page.locator('#marioparty-play-area').isVisible(),true);assert.equal(await page.locator('#retro-error').count()?await page.locator('#retro-error').textContent():'','');}
  const counts=await Promise.all(playerPages.map(page=>page.evaluate(()=>{const m=document.querySelector('#marioparty-play-area iframe').contentWindow.Module;return {frames:m._mp_rendered_frames(),audio:m._mp_audio_tasks()};})));
  assert.ok(counts.every(c=>c.frames>80&&c.audio>80));assert.ok(counts.every(c=>Math.abs(counts[0].frames-c.frames)<15));
  await host.locator('#marioparty-play-area iframe').contentFrame().locator('canvas').click();
  await host.waitForFunction(()=>document.querySelector('#marioparty-play-area iframe').contentWindow.Module.mpAudio?.context.state==='running');
  await watcher.waitForFunction(()=>{const v=document.querySelector('#retro-spectator-video');return v && v.videoWidth>0 && v.getVideoPlaybackQuality().totalVideoFrames>=80;},null,{timeout:60000});
  await watcher.screenshot({path:'.tmp/marioparty-spectator-room.png'});assert.deepEqual(errors,[]);
  console.log(`PASS: real shared lobby launches ${playerCount} native players and a spectator through the production runtime template; players render past checksum exchange and the spectator decodes live video, and a user gesture resumes audio.`);
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
