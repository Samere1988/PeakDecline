const {chromium}=require('C:/Users/Plex/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',args:['--enable-unsafe-swiftshader','--autoplay-policy=no-user-gesture-required']});
 try {for(const game of ['fzerox','smash64']) {
  const context=await browser.newContext();
  await context.addInitScript(()=>{
   window.testAudioOutputs=[];
   const connect=AudioNode.prototype.connect;
   AudioNode.prototype.connect=function(target,...args){
    if(target===this.context.destination)window.testAudioOutputs.push(this);
    return connect.call(this,target,...args);
   };
  });
  const page=await context.newPage();
  await page.goto('http://127.0.0.1:8066/test-login/volume-'+game);
  await page.locator('#retro-open-create').click();await page.locator('#retro-game-select').selectOption(game);
  await page.locator('#retro-room-name').fill('Volume '+game);await page.locator('#retro-room-create').click();
  await page.locator('#retro-ready').click();await page.locator('#retro-start-race').click();
  const area=page.locator('#'+game+'-play-area'), slider=area.locator('[data-game-volume]');
  await page.waitForFunction(game=>document.querySelector('#'+game+'-play-area iframe')?.contentWindow.testAudioOutputs?.length>0,game,{timeout:120000});
  async function check(value){
   await slider.fill(String(value));await slider.dispatchEvent('input');
   await page.waitForTimeout(200);
   const outputs=await area.locator('iframe').evaluate(e=>e.contentWindow.testAudioOutputs.map(n=>({gain:n.gain?.value,state:n.context.state})));
   assert.ok(outputs.length);for(const output of outputs)assert.ok(Math.abs(output.gain-value/100)<0.001,JSON.stringify(outputs));
   assert.equal(await area.locator('[data-game-volume-value]').textContent(),value+'%');
   assert.equal(await page.evaluate(game=>localStorage.getItem(game+'-volume'),game),String(value/100));
  }
  await check(25);await check(0);await check(65);
  await area.locator('[data-game-restart]').click();
  await page.waitForFunction(game=>window.retroNetplay?.epoch===1 && document.querySelector('#'+game+'-play-area iframe')?.contentWindow.testAudioOutputs?.length>0,game,{timeout:120000});
  await check(65);
  assert.equal(await page.evaluate(()=>retroNetplay.failed),false);
  console.log(game+': actual audio master gain, mute, restore and restart persistence passed.');
  await context.close();
 }}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
