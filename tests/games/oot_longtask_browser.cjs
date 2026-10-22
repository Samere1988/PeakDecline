/* Main-thread long tasks while OoT boots, cold (ROM extraction) and warm (cached assets).
   The runtime iframe is same-origin, so a long task also stalls the room's Socket.IO heartbeat. */
const assert=require('node:assert/strict'),path=require('node:path');
const {chromium}=require(path.join(process.env.HOME,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const LIMIT=2000;
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:path.join(process.env.HOME,'.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'),args:['--enable-unsafe-swiftshader','--autoplay-policy=no-user-gesture-required','--disable-background-timer-throttling','--disable-renderer-backgrounding']});
 const base='http://127.0.0.1:8076';
 try{
  const context=await browser.newContext({viewport:{width:1200,height:1050}});
  await context.addInitScript(()=>{
   if(window!==top)return;window.longTasks=[];
   new PerformanceObserver(list=>{for(const entry of list.getEntries())longTasks.push(Math.round(entry.duration));}).observe({type:'longtask',buffered:true});
  });
  const user='oot-longtask-'+Date.now();
  for(const run of ['cold','warm']){
   const host=await context.newPage();let warnings=0;
   host.on('console',message=>{if(message.type()==='warning')warnings++;});
   await host.goto(base+'/test-login/'+user);
   await host.locator('#retro-open-create').click();await host.locator('#retro-game-select').selectOption('oot');await host.locator('#retro-room-name').fill('Ocarina long tasks');await host.locator('#retro-room-create').click();await host.waitForFunction(()=>document.getElementById('retro-invite').value);
   await host.locator('#retro-ready').click();await host.locator('#retro-start-race').click();
   await host.waitForFunction(()=>window.retroNetplay?.running,null,{timeout:240000});
   const frame=host.frames().find(f=>f.url().includes('/runtime/oot'));
   await frame.waitForFunction(()=>window.peakNativeTicks>20,null,{timeout:180000});
   await host.waitForTimeout(3000);
   const tasks=await host.evaluate(()=>longTasks),longest=Math.max(0,...tasks);
   console.log(JSON.stringify({run,longTasks:tasks.length,longestMs:longest,consoleWarnings:warnings}));
   assert(longest<LIMIT,`${run} load blocked the main thread for ${longest} ms`);
   await host.close();
  }
  console.log('OOT LONG TASKS PASSED');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
