// Uses the isolated fixture on port 8088. No production accounts or saves.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const {chromium, firefox} = require(process.env.PLAYWRIGHT_MODULE || path.join(process.env.HOME, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));

async function check(engine) {
 const isFirefox = engine === 'firefox';
 const browser = await (isFirefox ? firefox : chromium).launch(isFirefox ? {
  headless: true,
  executablePath: process.env.FIREFOX_PATH || path.join(process.env.HOME, '.cache/ms-playwright/firefox-1543/firefox/firefox'),
  // The Linux fixture enables WebGPU in its own temporary test profile.
  firefoxUserPrefs: {'dom.webgpu.enabled': true},
 } : {
  headless: true,
  executablePath: process.env.CHROMIUM_PATH || path.join(process.env.HOME, '.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'),
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--disable-gpu-sandbox', '--use-angle=gl', '--enable-features=Vulkan', '--use-vulkan=native', '--disable-vulkan-surface', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
 });
 const errors = [];
 try {
  const page = await browser.newPage({viewport: {width: 1280, height: 1000}});
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
   const text = message.text();
   if (/CMR2 command failure|gfx: BeginPass failed|WebGPU uncaptured error|Uncaptured WebGPU error|Parameter 'render_pass'|gfx: (shader|pipeline|clear pipeline):/i.test(text)) errors.push(text);
  });
  await page.addInitScript(() => {
   const sizes = new WeakMap();
   window.cmrGPUAllocations = {liveBytes: 0, peakBytes: 0, created: 0, destroyed: 0, bindGroups: 0, texturesCreated: 0, texturesDestroyed: 0};
   const createBuffer = GPUDevice.prototype.createBuffer;
   GPUDevice.prototype.createBuffer = function(descriptor) {
    const buffer = createBuffer.call(this, descriptor), stats = cmrGPUAllocations;
    sizes.set(buffer, descriptor.size);
    stats.liveBytes += descriptor.size;stats.created++;
    stats.peakBytes = Math.max(stats.peakBytes, stats.liveBytes);
    return buffer;
   };
   const destroy = GPUBuffer.prototype.destroy;
   GPUBuffer.prototype.destroy = function() {
    const size = sizes.get(this);
    if (size !== undefined) {cmrGPUAllocations.liveBytes -= size;cmrGPUAllocations.destroyed++;sizes.delete(this);}
    return destroy.call(this);
   };
   const createBindGroup = GPUDevice.prototype.createBindGroup;
   GPUDevice.prototype.createBindGroup = function(descriptor) {cmrGPUAllocations.bindGroups++;return createBindGroup.call(this, descriptor);};
   const createTexture = GPUDevice.prototype.createTexture;
   GPUDevice.prototype.createTexture = function(descriptor) {cmrGPUAllocations.texturesCreated++;return createTexture.call(this, descriptor);};
   const destroyTexture = GPUTexture.prototype.destroy;
   GPUTexture.prototype.destroy = function() {cmrGPUAllocations.texturesDestroyed++;return destroyTexture.call(this);};
   const request = window.requestAnimationFrame.bind(window);
   window.cmrFrameSamples = [];
   let lastFrame;
   window.requestAnimationFrame = callback => request(time => {
    const frame = window.Module?.cmr2Frames;
    if (frame !== lastFrame && window.Module?.cmr2State?.race === 8) {
     lastFrame = frame;
     cmrFrameSamples.push(time);
    }
    callback(time);
   });
  });
  await page.goto('http://127.0.0.1:8088/test-login/cmr-render-' + engine + '-' + Date.now());
  await page.goto(page.url().split('?')[0] + '?cmr2-diagnostics=1');
  const gpuInfo=await page.evaluate(async()=>{const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});if(!adapter)throw new Error('No hardware WebGPU adapter');const info=adapter.info;return {vendor:info.vendor,architecture:info.architecture,fallback:info.isFallbackAdapter};});
  assert.equal(gpuInfo.fallback,false,'Rendering performance requires a hardware WebGPU adapter');console.log(engine,'GPU',JSON.stringify(gpuInfo));
  await page.locator('#retro-open-create').click();
  await page.locator('#retro-game-select').selectOption('cmr2');
  await page.locator('#retro-room-name').fill(engine + ' rendering acceptance');
  await page.locator('#retro-room-create').click();
  await page.locator('#retro-ready').click();
  await page.locator('#retro-start-race').click();
  await page.waitForFunction(() => window.retroNetplay?.running, null, {timeout: 60000});
  await page.evaluate(()=>{window.cmrRenderReports=[];retroNetplay.socket.onAnyOutgoing((name,data)=>{if(name==='diagnostics'&&data.render)cmrRenderReports.push(data.render);});});
  const frame = page.frames().find(f => f.url().includes('/runtime/cmr2'));
  let lastMenu, lastMovie, racing = false, reported;
  const choices = {1: 0, 0: 1, 88: 2, 29: 0, 28: 0, 33: 2, 34: 2, 140: 2, 141: 3, 151: 0, 36: 0, 37: 0, 341: 1};
  for (let i = 0; i < 200; i++) {
   const value = await frame.evaluate(() => ({state: Module.cmr2State, movie: Module.cmr2Movie}));
   const s = value.state;
   const description=JSON.stringify(s);if(description!==reported){reported=description;console.log(engine,description);}
   if (s?.race === 8) {racing = true; break;}
   if (s?.menu === -1 && value.movie && value.movie.count !== lastMovie) {
    lastMovie = value.movie.count;
    await frame.evaluate(() => Module.cmr2SkipMovie = true);
   }
   const choice = s?.mode === 2 && s.count === 5 ? 3 : (choices[s?.menu] ?? (s?.mode === 0 && s.count > 0 ? 0 : undefined));
   const key = s?.mode + ':' + s?.menu;
   if (choice !== undefined && s.count > choice && key !== lastMenu) {
    lastMenu = key;
    await frame.evaluate(request => Module.cmr2MenuRequest = request, {menu: s.menu, index: choice});
   }
   await page.waitForTimeout(400);
  }
  assert(racing, engine + ' must enter a native race');
  await page.waitForTimeout(3000); // Exclude first-use shader compilation.
  await frame.locator('#canvas').screenshot({path: '.tmp/opencmr2/render-' + engine + '-start.png'});
  await frame.locator('#canvas').focus();
  const initial = await frame.evaluate(() => {
   cmrFrameSamples.length = 0;
   window.cmrNativeFrames=[];
   const original=Module.cmr2ProfileFrame;
   Module.cmr2ProfileFrame=phase=>{original?.(phase);if(phase===3)cmrNativeFrames.push(performance.now());};
   // Emulate a slow GPU-process mapping callback. Rendering must continue while
   // the single outstanding lens-flare readback remains pending.
   window.cmrMapCount=0;window.cmrOriginalMap=GPUBuffer.prototype.mapAsync;
   GPUBuffer.prototype.mapAsync=function(...args){cmrMapCount++;return cmrOriginalMap.apply(this,args).then(()=>new Promise(resolve=>setTimeout(resolve,200)));};
   return {frame: Module.cmr2Frames, time: performance.now(), car: Module.cmr2Cars[0]};
  });
  await page.keyboard.down('ArrowUp');
  await page.waitForTimeout(30000);
  await page.keyboard.up('ArrowUp');
  await page.waitForTimeout(10000);
  const result = await frame.evaluate(initial => {
   GPUBuffer.prototype.mapAsync=cmrOriginalMap;
   const time = performance.now(), gaps = cmrNativeFrames.slice(1).map((t, i) => t - cmrNativeFrames[i]).sort((a, b) => a - b);
   return {fps: (Module.cmr2Frames - initial.frame) * 1000 / (time - initial.time), p95Ms: gaps[Math.floor(gaps.length * .95)], p99Ms:gaps[Math.floor(gaps.length*.99)], maxMs: gaps[gaps.length - 1], over100:gaps.filter(g=>g>100).length, delayedMaps:cmrMapCount, car: Module.cmr2Cars[0], frames: Module.cmr2Frames - initial.frame};
  }, initial);
  assert(result.delayedMaps>0,'Exercise GPU download completion during driving');
  assert(result.fps>=50&&result.p99Ms<50&&result.over100===0,'Delayed readbacks must not stall presentation: '+JSON.stringify(result));
  const reports=await page.evaluate(()=>cmrRenderReports);
  assert(reports.some(r=>r.samples>100&&r.p95Ms>0&&r.renderMs>=0),'Opt-in native frame timing must reach the room diagnostics transport');
  result.diagnosticReports=reports.length;
  await frame.locator('#canvas').screenshot({path: '.tmp/opencmr2/render-' + engine + '-drive.png'});
  result.sceneColors=await frame.evaluate(()=>{
   const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;
   const ctx=canvas.getContext('2d');ctx.drawImage(Module.canvas,0,0,320,180);
   const bytes=ctx.getImageData(0,0,320,180).data,colors=new Set();
   for(let y=45;y<145;y++)for(let x=25;x<295;x++){const i=(y*320+x)*4;colors.add((bytes[i]>>3)*1024+(bytes[i+1]>>3)*32+(bytes[i+2]>>3));}
   return colors.size;
  });
  // Withheld browser callbacks must not suspend the native race indefinitely.
  const stalled = await frame.evaluate(() => {
   window.cmrOriginalRAF = window.requestAnimationFrame;
   window.cmrOriginalCancelRAF = window.cancelAnimationFrame;
   const before = {frames: Module.cmr2Frames, tick: Module.cmr2State.tick, fallbacks: Module.cmr2FrameFallbacks || 0};
   window.requestAnimationFrame = () => 0;
   window.cancelAnimationFrame = () => {};
   return before;
  });
  await page.waitForTimeout(4000);
  const recovered = await frame.evaluate(() => {
   window.requestAnimationFrame = window.cmrOriginalRAF;
   window.cancelAnimationFrame = window.cmrOriginalCancelRAF;
   return {frames: Module.cmr2Frames, tick: Module.cmr2State.tick, fallbacks: Module.cmr2FrameFallbacks || 0};
  });
  assert(recovered.frames > stalled.frames + 80, 'Withheld callbacks must retain responsive presentation, not fall back to 10 FPS');
  assert(recovered.tick > stalled.tick, 'Race simulation must survive withheld frame callbacks');
  assert(recovered.fallbacks > stalled.fallbacks, 'Withheld callbacks must exercise timer recovery');
  console.log(engine, 'callback recovery', JSON.stringify({stalled, recovered}));
  const fast = await frame.evaluate(() => {
   window.requestAnimationFrame = callback => setTimeout(() => callback(performance.now()), 6);
   window.cancelAnimationFrame = clearTimeout;
   return {frames: Module.cmr2Frames, time: performance.now()};
  });
  await page.waitForTimeout(4000);
  const paced = await frame.evaluate(before => {
   window.requestAnimationFrame = window.cmrOriginalRAF;
   window.cancelAnimationFrame = window.cmrOriginalCancelRAF;
   return (Module.cmr2Frames - before.frames) * 1000 / (performance.now() - before.time);
  }, fast);
  assert(paced <= 65, 'High-refresh displays must not run an unbounded native loop: ' + paced);
  console.log(engine, 'high-refresh capped FPS', paced);
  const memoryStart = await frame.evaluate(() => ({...cmrGPUAllocations}));
  const soakFrameStart = await frame.evaluate(() => Module.cmr2Frames);
  let previous = await frame.evaluate(() => ({frames: Module.cmr2Frames, tick: Module.cmr2State.tick}));
  const soakPeriods = Math.ceil(Number(process.env.CMR2_SOAK_SECONDS || 180) / 10);
  for (let period = 0; period < soakPeriods; period++) {
   await page.waitForTimeout(10000);
   const current = await frame.evaluate(() => ({frames: Module.cmr2Frames, tick: Module.cmr2State.tick, race: Module.cmr2State.race, memory: {...cmrGPUAllocations}, handles: typeof WebGPU !== "undefined" ? Object.keys(WebGPU.Internals.jsObjects).length : null}));
   assert(current.frames > previous.frames + 100, 'Race presentation stalled during soak');
   assert(current.tick > previous.tick, 'Race simulation stalled during soak');
   assert.equal(current.race, 8, 'Soak must remain in the race');
   previous = current;
   console.log(engine, 'race soak', period + 1, JSON.stringify(current));
  }
  const memoryEnd = await frame.evaluate(() => ({...cmrGPUAllocations}));
  assert(memoryEnd.destroyed > memoryStart.destroyed + 100, 'Race must explicitly destroy completed GPU buffers');
  assert(memoryEnd.liveBytes < memoryStart.liveBytes + 16 * 1024 * 1024, 'GPU buffer memory must stay bounded during the race');
  result.bindGroupsPerFrame = (memoryEnd.bindGroups - memoryStart.bindGroups) / (previous.frames - soakFrameStart);
  assert(result.bindGroupsPerFrame < 10, 'Race must reuse bind groups across frames: ' + result.bindGroupsPerFrame);
  result.gpuMemory = {start: memoryStart, end: memoryEnd};
  result.callbackRecovery = recovered;
  result.highRefreshFps = paced;
  result.soakSeconds = soakPeriods * 10;
  assert(result.sceneColors>=128,engine+' must render a textured race scene, not a blank canvas');
  assert(result.p95Ms<50,engine+' steady-race frame gaps are too large: '+result.p95Ms);

  assert(result.car.x !== initial.car.x || result.car.z !== initial.car.z, 'The car must move');
  assert.deepEqual(errors, [], engine + ' must not reject race render commands');
  assert(result.fps >= Number(process.env.CMR2_MIN_FPS || 30), engine + ' steady-race frame rate too low: ' + result.fps.toFixed(1));
  console.log('PASS', engine, JSON.stringify(result));
  return {engine, version: browser.version(), gpu:gpuInfo, ...result};
 } finally {
  await browser.close();
 }
}

(async () => {
 const results = [];
 for (const engine of (process.env.CMR2_BROWSERS || 'firefox').split(',')) results.push(await check(engine));
 const crypto = require('node:crypto'), directory = '.tmp/opencmr2/browser-build/game';
 const sha256 = Object.fromEntries(['opencmr2.js', 'opencmr2.wasm'].map(name => [name, crypto.createHash('sha256').update(fs.readFileSync(directory + '/' + name)).digest('hex')]));
 fs.writeFileSync(directory + '/render-verified.json', JSON.stringify({passed: true, checkedAt: new Date().toISOString(), results, sha256}, null, 2) + '\n');
})().catch(error => {console.error(error);process.exitCode = 1;});
