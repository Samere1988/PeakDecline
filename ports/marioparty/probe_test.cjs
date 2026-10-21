const assert=require('node:assert/strict');
const fs=require('node:fs'),http=require('node:http'),path=require('node:path');
const {chromium}=require(path.join(process.env.HOME,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
(async()=>{
 const directory=path.resolve('.tmp/marioparty-port');
 const server=http.createServer((req,res)=>{
  if(req.url==='/'){res.setHeader('Content-Type','text/html');return res.end('<script src="/probe.js"></script><script>createMarioPartyProbe().then(m=>window.probe=m)</script>');}
  if(!['/probe.js','/probe.wasm'].includes(req.url)){res.statusCode=404;return res.end();}
  res.setHeader('Content-Type',req.url.endsWith('.wasm')?'application/wasm':'text/javascript');res.end(fs.readFileSync(path.join(directory,req.url)));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 let browser;
 try{
  browser=await chromium.launch({headless:true,executablePath:process.env.MP_BROWSER||path.join(process.env.HOME,'.cache/ms-playwright/chromium-1243/chrome-linux64/chrome')});
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForFunction(()=>window.probe);
  const seeds=[0,1,0x7fffffff,0x80000000,0xffffffff,0x12345678];
  for(const seed of seeds){
   const actual=await page.evaluate(seed=>{probe._seed(seed);return Array.from({length:1000},()=>probe._next_random());},seed);
   let state=seed;const expected=Array.from({length:1000},()=>{state=(Math.imul(state,0x41c64e6d)+0x3039)>>>0;return ((state+1)>>>16)&255;});
   assert.deepEqual(actual,expected,'Translated RNG sequence for seed '+seed);
  }
  assert.deepEqual(errors,[]);
  console.log('PASS: 6,000 outputs from translated Mario Party rand8 executed in browser WebAssembly. No CPU interpreter. This does not boot the game.');
 }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});
