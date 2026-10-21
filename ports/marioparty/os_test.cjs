const assert=require('node:assert/strict');
const fs=require('node:fs'),http=require('node:http'),path=require('node:path');
const {chromium}=require(path.join(process.env.HOME,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
(async()=>{
 const directory=path.resolve('.tmp/marioparty-port');
 const server=http.createServer((req,res)=>{
  if(req.url==='/'){res.setHeader('Content-Type','text/html');return res.end('<script src="/os-test.js"></script><script>createMarioPartyOSTest().then(m=>window.probe=m)</script>');}
  if(!['/os-test.js','/os-test.wasm'].includes(req.url)){res.statusCode=404;return res.end();}
  res.setHeader('Content-Type',req.url.endsWith('.wasm')?'application/wasm':'text/javascript');res.end(fs.readFileSync(path.join(directory,req.url)));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 let browser;
 try{
  browser=await chromium.launch({headless:true,executablePath:process.env.MP_BROWSER||path.join(process.env.HOME,'.cache/ms-playwright/chromium-1243/chrome-linux64/chrome')});
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForFunction(()=>window.probe);
  // Fiber-switching exports return their initial unwind value. Read completion
  // through a separate export after the trampoline has finished switching.
  assert.equal(await page.evaluate(()=>{probe._mp_test_os();return probe._mp_test_result();}),9);
  assert.equal(await page.evaluate(()=>{probe._mp_test_os();return probe._mp_test_result();}),9);
  assert.equal(await page.evaluate(()=>{probe._mp_test_process();return probe._mp_test_process_result();}),1);
  assert.equal(await page.evaluate(()=>{probe._mp_test_process();return probe._mp_test_process_result();}),1);
  assert.deepEqual(errors,[]);
  console.log('PASS: browser OS initialization, queue overflow/underflow, jam ordering, wraparound, priority preemption, blocked sender/receiver resumption reset, VI timing, controller packing, EEPROM persistence, and process sleep/destructor cleanup.');
 }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});
