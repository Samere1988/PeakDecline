const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require(path.join(process.env.HOME,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
(async()=>{
 const root=path.resolve('.tmp/marioparty2-port');
 const server=http.createServer((req,res)=>{
  if(req.url==='/'){res.setHeader('Content-Type','text/html');return res.end('<canvas id="canvas" width="640" height="480"></canvas><script src="/palette-test.js"></script><script>createPaletteTest().then(m=>window.probe=m)</script>');}
  if(!['/palette-test.js','/palette-test.wasm'].includes(req.url)){res.statusCode=404;return res.end();}
  res.setHeader('Content-Type',req.url.endsWith('.wasm')?'application/wasm':'text/javascript');fs.createReadStream(root+req.url).pipe(res);
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({headless:true,executablePath:path.join(process.env.HOME,'.cache/ms-playwright/chromium-1243/chrome-linux64/chrome')});
 try {
  const page=await browser.newPage();page.on('pageerror',e=>console.error(e.message));await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForFunction(()=>window.probe);
  const results=await page.evaluate(()=>{
   const results=[];
   for(const fourbit of [0,1])for(const swapped of [0,1])for(const rgba of [0,1]) {
    probe._mp_test_palette(rgba,fourbit,swapped);
    const gl=document.getElementById('canvas').getContext('webgl'),pixels=new Uint8Array(640*480*4);gl.readPixels(0,0,640,480,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
    let red=0,green=0,hash=2166136261;for(let i=0;i<pixels.length;i+=4){if(pixels[i]>240&&pixels[i+1]<10)red++;if(pixels[i+1]>240&&pixels[i]<10)green++;for(let c=0;c<4;c++)hash=Math.imul(hash^pixels[i+c],16777619);}
    results.push({fourbit,swapped,rgba,red,green,hash:hash>>>0,error:gl.getError()});
   }return results;
  });
  for(let i=0;i<results.length;i+=2){const a=results[i],b=results[i+1];assert.equal(a.error,0);assert.equal(b.error,0);assert.ok(a.red>0&&a.green>0,JSON.stringify(a));assert.equal(a.hash,b.hash);}
  assert.notEqual(results[0].hash,results[2].hash);assert.notEqual(results[4].hash,results[6].hash);
  console.log('PASS: RGBA-tagged 4/8-bit textures match CI pixels, display both palette colours, and update when the palette changes.');
 }finally{await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
