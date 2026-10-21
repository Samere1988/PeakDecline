/* Four real native runtimes through the disposable loopback fixture.
 * Delays are ordered application-level input delays, not WAN packet emulation. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require(process.env.PLAYWRIGHT_PATH || path.join(process.env.HOME, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const game = process.env.MP_GAME || 'marioparty';
assert.ok(['marioparty', 'marioparty2'].includes(game));
const target = Number(process.env.MP_NET_FRAMES || 1800);
assert.ok(Number.isInteger(target) && target >= 600);
const base = process.env.MP_TEST_URL || 'http://127.0.0.1:8078';
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(base).hostname));
(async () => {
 const browser = await chromium.launch({headless:true, executablePath:process.env.BROWSER_PATH || path.join(process.env.HOME, '.cache/ms-playwright/chromium-1243/chrome-linux64/chrome')});
 const pages = [], errors = [];
 try {
  for (let seat = 0; seat < 4; seat++) {
   const context = await browser.newContext();
   await context.route('**/static/js/netplay/session.js*', async route => {
    const response = await route.fetch();
    await route.fulfill({response, body:(await response.text()) + `
     (() => {
      const original = PeakNet.Session.prototype.bind;
      PeakNet.Session.prototype.bind = function(adapter) {
       window.netTest = {session:this, hashes:[], inputs:0, delayed:0, burst:false};
       const test = window.netTest, emit = this.socket.emit.bind(this.socket);
       let delivery = 0;
       this.socket.emit = (event, data) => {
        if (event !== 'input') return emit(event, data);
        test.inputs++;
        if (${seat} === 3) {
         let delay = 35 + (data.frame % 5) * 15;
         if (!test.burst && data.frame >= 300) { delay += 1500; test.burst = true; }
         delivery = Math.max(delivery, performance.now() + delay);
         test.delayed++;
         setTimeout(() => emit(event, data), Math.max(0, delivery - performance.now()));
         return this.socket;
        }
        return emit(event, data);
       };
       const hash = adapter.hashForFrame;
       adapter.hashForFrame = frame => { const value = hash(frame); test.hashes.push([frame,value]); return value; };
       return original.call(this, adapter);
      };
     })();`});
   });
   const page = await context.newPage();
   page.on('pageerror', e => { errors.push(e.message); console.error('PAGE ERROR',e.message); }); pages.push(page);
   await page.goto(base + '/test-login/netcheck-' + game + '-' + seat);
  }
  const host = pages[0];
  await host.locator('#retro-open-create').click();
  await host.locator('#retro-game-select').selectOption(game);
  await host.locator('#retro-room-name').fill('Four-player network qualification');
  await host.locator('#retro-room-create').click();
  await host.locator('#retro-lobby').waitFor({state:'visible'});
  for (const page of pages.slice(1)) {
   await page.getByRole('button',{name:'Join room',exact:true}).click();
   await page.locator('#retro-lobby').waitFor({state:'visible'});
   await page.locator('#retro-choose-player').click();
  }
  for (const page of pages) await page.locator('#retro-ready').click();
  await host.locator('#retro-start-race').click();
  await Promise.all(pages.map(page => page.waitForFunction(() => window.netTest?.session.running, null, {timeout:120000})));
  // Distinct real keyboard input for each seat traverses adapter, socket, server and native pads.
  for (let seat=0;seat<4;seat++) await pages[seat].keyboard.down(['KeyX','KeyC','ArrowLeft','ArrowRight'][seat]);
  await Promise.all(pages.map(page => page.waitForFunction(n => window.netTest.session.frame >= n || window.netTest.session.failed, target, {timeout:Math.max(180000, target * 120)})));
  const result = await Promise.all(pages.map(page => page.evaluate(() => ({
   frame:netTest.session.frame, failed:netTest.session.failed, hashes:netTest.hashes,
   inputs:netTest.inputs, delayed:netTest.delayed, burst:netTest.burst,
   pads:netTest.session.getFrame(netTest.session.frame-1)
  }))));
  for (const peer of result) { assert.equal(peer.failed,false); assert.ok(peer.frame>=target); }
  const common = Math.min(...result.map(peer=>peer.hashes.length));
  assert.ok(common >= Math.floor(target/60)-1);
  for (const peer of result.slice(1)) assert.deepEqual(peer.hashes.slice(0,common),result[0].hashes.slice(0,common));
  for (const peer of result) assert.deepEqual(peer.pads, [
   {buttons:0x8000,x:0,y:0}, {buttons:0x4000,x:0,y:0},
   {buttons:0,x:-80,y:0}, {buttons:0,x:80,y:0}
  ]);
  assert.ok(result[3].burst && result[3].delayed >= target);
  if (process.env.MP_RELOAD === '1') {
   const recoveryResults = [];
   // Test reload of the host, then close/reopen a guest without sessionStorage.
   for (const [seat, kind] of [[0,'reload'], [2,'reopen']]) {
    const old = pages[seat], context = old.context(), url = old.url();
    const before = Math.max(...await Promise.all(pages.map(page=>page.evaluate(()=>netTest.session.frame))));
    if (kind === 'reload') await old.reload();
    else {
     await old.close();
     const page = await context.newPage();
     page.on('pageerror', e=>{errors.push(e.message);console.error('PAGE ERROR',e.message);});
     pages[seat] = page;
     await page.goto(url);
    }
    const restored = pages[seat];
    try {
     await restored.waitForFunction(()=>window.netTest?.session.running && !netTest.session.rebuilding && !netTest.session.failed,null,{timeout:180000});
    } catch(error) {
     console.error(await restored.evaluate(()=>({text:document.body.innerText,session:window.netTest && {frame:netTest.session.frame,running:netTest.session.running,failed:netTest.session.failed,rebuilding:netTest.session.rebuilding,paused:netTest.session.transportSuspended},errors:window.retroNetplay?.failureMessage})));
     throw error;
    }
    const resumedTarget = before + 180;
    await Promise.all(pages.map(page=>page.waitForFunction(n=>netTest?.session.frame>=n || netTest?.session.failed,resumedTarget,{timeout:90000})));
    const peers = await Promise.all(pages.map(page=>page.evaluate(()=>({frame:netTest.session.frame,slot:netTest.session.slot,
     failed:netTest.session.failed,hashes:netTest.hashes,inputs:netTest.inputs}))));
    for(let i=0;i<4;i++){assert.equal(peers[i].slot,i);assert.equal(peers[i].failed,false);assert.ok(peers[i].frame>=resumedTarget);}
    const hashes = peers.map(peer=>new Map(peer.hashes));
    const commonFrames = [...hashes[0].keys()].filter(frame=>frame>before && hashes.every(map=>map.has(frame)));
    assert.ok(commonFrames.length>=2);
    for(const frame of commonFrames) assert.equal(new Set(hashes.map(map=>map.get(frame))).size,1);
    recoveryResults.push({kind,seat,before,resumedTarget,commonFrames,peers});
   }
   assert.deepEqual(errors,[]);
   fs.mkdirSync('.tmp/marioparty-netplay',{recursive:true});
   fs.writeFileSync('.tmp/marioparty-netplay/'+game+'-reload.json',JSON.stringify({game,target,recoveryResults},null,2));
   console.log(`PASS ${game}: four players survive host reload and guest tab closure/reopen; original slots and native checksums match after both recoveries.`);
   return;
  }
  // Break the real socket without disposing its native runtime. Hold beyond
  // MK64's 15-second grace and the legacy client's 18-second timeout.
  await host.evaluate(() => {
   window.savedModule = document.querySelector('iframe').contentWindow.Module;
   netTest.session.socket.io.reconnection(false);
   netTest.session.socket.io.engine.close();
  });
  await Promise.all(pages.map(page=>page.waitForFunction(()=>netTest.session.transportSuspended,null,{timeout:15000})));
  const paused = await Promise.all(pages.map(page=>page.evaluate(()=>netTest.session.frame)));
  await host.waitForTimeout(20000);
  for (let seat=0;seat<4;seat++) {
   assert.deepEqual(await pages[seat].evaluate(()=>({frame:netTest.session.frame, failed:netTest.session.failed})),
    {frame:paused[seat], failed:false});
  }
  await host.evaluate(()=>{netTest.session.socket.io.reconnection(true);netTest.session.socket.connect();});
  const resumedTarget = Math.max(...paused) + 180;
  await Promise.all(pages.map(page=>page.waitForFunction(n=>netTest.session.frame>=n || netTest.session.failed,resumedTarget,{timeout:60000})));
  assert.equal(await host.evaluate(()=>savedModule===document.querySelector('iframe').contentWindow.Module),true);
  const recovered = await Promise.all(pages.map(page=>page.evaluate(()=>({frame:netTest.session.frame,failed:netTest.session.failed,hashes:netTest.hashes}))));
  const recoveredCommon = Math.min(...recovered.map(peer=>peer.hashes.length));
  assert.ok(recoveredCommon > common);
  for(const peer of recovered) {
   assert.equal(peer.failed,false); assert.ok(peer.frame>=resumedTarget);
   assert.deepEqual(peer.hashes.slice(0,recoveredCommon),recovered[0].hashes.slice(0,recoveredCommon));
  }
  assert.deepEqual(errors,[]);
  fs.mkdirSync('.tmp/marioparty-netplay',{recursive:true});
  fs.writeFileSync('.tmp/marioparty-netplay/'+game+'.json',JSON.stringify({game,target,common,reconnectPauseMs:20000,recoveredCommon,recovered,result},null,2));
  console.log(`PASS ${game}: four native players, ${target} frames, ${common} matching checksums per player, four distinct controller inputs, 35–95 ms ordered delay plus 1.5 s interruption recovered, 20-second host disconnect pauses and reconnects the same runtime with matching checksums.`);
 } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
