const {chromium}=require(process.env.MK64_PLAYWRIGHT||'C:/Users/Plex/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const path=require('node:path');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.MK64_BROWSER||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',args:['--enable-unsafe-swiftshader']});
 try{
  const page=await browser.newPage(),errors=[];
  await page.addInitScript(()=>{window.mk64Multiplayer=true;window.mk64InputAtFrame=frame=>({buttons:frame>300?0x8000:0,x:0,y:0});});
  page.on('pageerror',error=>{errors.push(error.message);console.log('ERROR',error.stack);});
  await page.goto('http://127.0.0.1:8064/');
  await page.waitForTimeout(20000);
  const state=await page.evaluate(()=>({frame:mk64?._web_frame(),state:mk64?._web_state(),race:mk64?._web_race_state(),pos:[0,1,2].map(axis=>mk64?._web_position(axis)),error:window.mk64Error}));
  await page.locator('canvas').screenshot({path:path.resolve(__dirname,'../../.tmp/mk64/multi-probe.png')});
  console.log(state,errors);
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
