const {chromium} = require('C:/Users/Plex/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
(async () => {
 const browser = await chromium.launch({headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 try {
 const page = await browser.newPage();
 const errors = []; page.on('pageerror', error => errors.push(error.message));
 await page.route('**/*', route => {
  const pathname = new URL(route.request().url()).pathname;
  if (pathname.startsWith('/static/')) return route.fulfill({path:path.join(root, pathname)});
  if (pathname === '/derby') return route.fulfill({path:path.join(__dirname,'horse_race.html'),contentType:'text/html'});
  return route.fulfill({body:''});
 });
 await page.clock.install();
 await page.goto('http://games.test/derby');
 for (const width of [320,390,768,1366]) {
  await page.setViewportSize({width,height:900});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true,`No overflow at ${width}`);
 }
 await page.locator('#bet-amount').fill('15'); await page.locator('#btn-start').click();
 assert.match(await page.locator('#race-announcer').innerText(), /steps of 10/);
 assert.equal(await page.locator('#bankroll-display').innerText(),'1,000');
 await page.locator('#bet-amount').fill('100'); await page.locator('#btn-start').click();
 assert.equal(await page.locator('#horse-select').isDisabled(),true);
 assert.equal(await page.locator('#bankroll-display').innerText(),'900');
 assert.equal(await page.locator('#track-overlay').isVisible(), true);
 await page.clock.runFor(5000);
 assert.equal(await page.locator('#track-overlay').isVisible(), false);
 await page.locator('.stadium').screenshot({path:path.join(__dirname,'derby-racing.png')});
 await page.locator('#btn-pause').click();
 assert.equal(await page.locator('#track-overlay').isVisible(), true);
 assert.equal(await page.locator('.leg-front').first().evaluate(el => getComputedStyle(el).animationPlayState), 'paused');
 const before = await page.locator('#horse-1').getAttribute('style');
 await page.clock.runFor(3000);
 assert.equal(await page.locator('#horse-1').getAttribute('style'), before);
 await page.locator('#btn-pause').click();
 await page.setViewportSize({width:320,height:900});
 await page.clock.runFor(22000);
 assert.equal(await page.locator('#standings-title').innerText(),'Official finish order');
 assert.match(await page.locator('#race-stats').innerText(),/1 races/);
 assert.equal(await page.locator('.winner').count(),1);
 const credits = await page.locator('#bankroll-display').innerText();
 await page.screenshot({path:path.join(__dirname,'derby-mobile.png'),fullPage:true});
 await page.locator('#btn-reset').click();
 assert.equal(await page.locator('#horse-select').isEnabled(),true);
 await page.emulateMedia({reducedMotion:'reduce'});
 assert.equal(await page.locator('.leg-front').first().evaluate(el => getComputedStyle(el).animationName), 'none');
 await page.emulateMedia({reducedMotion:'no-preference'});
 await page.reload();
 assert.equal(await page.locator('#bankroll-display').innerText(),credits);
 assert.match(await page.locator('#race-stats').innerText(),/1 races/);
 await page.setViewportSize({width:1366,height:1000});
 await page.screenshot({path:path.join(__dirname,'derby-desktop.png'),fullPage:true});
 for (const winningPick of [true, false]) {
  await page.evaluate(() => { localStorage.clear(); });
  await page.reload();
  await page.evaluate(() => {
   let call = 0;
   Math.random = () => { const index = call++; return index % 2 ? .5 : Math.floor(index / 2) / 10; };
  });
  await page.locator('#horse-select').selectOption(winningPick ? '1' : '10');
  await page.locator('#btn-start').click();
  await page.clock.runFor(21000);
  assert.equal(await page.locator('#bankroll-display').innerText(), winningPick ? '1,800' : '900');
  assert.equal(await page.locator('.winner').getAttribute('id'), 'horse-1');
 }
 assert.deepEqual(errors,[]);
 console.log('PASS: responsive layout, validation, locked stake, pause/resume, resize mid-race, finish, replay, persistence, no browser errors.');
 } finally { await browser.close(); }
})().catch(error => {console.error(error);process.exitCode=1;});
