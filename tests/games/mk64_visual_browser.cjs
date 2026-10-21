/* Real WASM visual regression on the localhost development harness.
 * Default: two-player GP countdown and an injected lap-sign transition while
 * moving. MK64_VISUAL_ENDURANCE=1 completes a CPU-steered three-lap GP and
 * checks every scorecard row in six consecutive presentations instead.
 * Supply the link map from the exact candidate; no production state is used.
 * Captures and GPU vertex measurements expose missing rows and alternating
 * Lakitu size, rather than treating a successful boot as a graphics test.
 */
const fs=require('node:fs'),assert=require('node:assert/strict'),path=require('node:path'),os=require('node:os');
const {chromium}=require(process.env.MK64_PLAYWRIGHT||path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const base=process.env.MK64_HARNESS_URL||'http://127.0.0.1:8064/';
assert.equal(new URL(base).hostname,'127.0.0.1','Use the isolated local fixture');
const out=process.env.MK64_TEST_OUTPUT||'.tmp/mk64-visual-audit/regression';fs.mkdirSync(out,{recursive:true});
const short=process.env.MK64_VISUAL_ENDURANCE!=='1';
const profile=process.env.MK64_VISUAL_PROFILE||'hd60';
assert(['hd60','hd30','nohd60'].includes(profile));
const map=fs.readFileSync(process.env.MK64_LINK_MAP||'.tmp/mk64/build/link.map','utf8');
const symbols=Object.fromEntries(['gPlayerOne','gCourseTimer','gGlobalTimer','gObjectList','gIndexLakituList','gModeSelection','gMenuItems','gLapCountByPlayerId'].map(n=>{const m=map.match(new RegExp('^([0-9a-f]+)\\s+[^\\n]+\\s'+n+'$','m'));assert(m,n);return[n,parseInt(m[1],16)];}));
(async()=>{const b=await chromium.launch({headless:true,executablePath:process.env.MK64_BROWSER||path.join(os.homedir(),'.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'),args:['--enable-gpu','--disable-gpu-sandbox','--use-angle=gl','--autoplay-policy=no-user-gesture-required']});const page=await b.newPage();const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.log(e.message)});
try{
await page.route(base,async route=>{const r=await route.fetch();await route.fulfill({response:r,body:(await r.text()).replace('module.mk64Input = input;',`module.mk64Input = input;module.mk64RenderFps=${profile==='hd30'?30:60};${profile==='nohd60'?'module.mk64HD=null;':''} module.mk64Network={catchingUp:()=>window.fastForward,frameReady:()=>1,getFrame:f=>window.mk64InputsAtFrame(f)};`)});});
await page.addInitScript(({symbols})=>{
window.symbols=symbols;window.fastForward=false;window.controls=[{buttons:0,x:0,y:0},{buttons:0,x:0,y:0}];window.mk64Multiplayer=true;window.mk64NativeMenus=true;window.mk64PlayerCount=2;window.trace=[];window.captures={};window.cpu=false;
for(const n of ['instantiate','instantiateStreaming']){const orig=WebAssembly[n];WebAssembly[n]=async function(...args){const r=await orig.apply(this,args);window.mem=(r.instance||r).exports.memory;return r;};}
const ctx=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(k,o){const gl=ctx.call(this,k,k==='webgl'?{...o,preserveDrawingBuffer:true}:o);if(k==='webgl')window.gl=gl;return gl;};
window.resultsSamples=[];window.lakituFrames=[];window.spriteDraws=[];const texInfo=new WeakMap();let vertices=null;
const bd=WebGLRenderingContext.prototype.bufferData;WebGLRenderingContext.prototype.bufferData=function(...a){if(a[0]===this.ARRAY_BUFFER&&ArrayBuffer.isView(a[1]))vertices=new Float32Array(a[1].buffer,a[1].byteOffset,a[1].byteLength/4);return bd.apply(this,a);};
const ti=WebGLRenderingContext.prototype.texImage2D;WebGLRenderingContext.prototype.texImage2D=function(...a){if(a.length===9){const texture=this.getParameter(this.TEXTURE_BINDING_2D);texInfo.set(texture,{w:a[3],h:a[4]});}return ti.apply(this,a);};let firstVisible=null,lastKind=-1;let fb=null;const bind=WebGLRenderingContext.prototype.bindFramebuffer;WebGLRenderingContext.prototype.bindFramebuffer=function(...a){fb=a[1];return bind.apply(this,a);};
const draw=WebGLRenderingContext.prototype.drawArrays;WebGLRenderingContext.prototype.drawArrays=function(...a){if(fb!==null&&window.mk64&&vertices){const tx=texInfo.get(this.getParameter(this.TEXTURE_BINDING_2D));if(tx&&((tx.w===56&&tx.h===36)||(tx.w===72&&tx.h===28))){const stride=vertices.length/a[2];const pts=[];for(let i=0;i<a[2];i++){const off=i*stride;pts.push([vertices[off]/vertices[off+3],vertices[off+1]/vertices[off+3]]);}spriteDraws.push({frame:mk64._web_frame(),render:mk64._web_render_frames(),w:tx.w,h:tx.h,viewport:Array.from(this.getParameter(this.VIEWPORT)),pts});}}const r=draw.apply(this,a);if(fb===null&&window.mk64&&window.mem){const v=new DataView(mem.buffer);for(let i=0;i<32&&resultsSamples.length<6;i++){const item=symbols.gMenuItems+i*40;if(v.getInt32(item,true)===0xab&&v.getInt32(item+4,true)===3&&v.getInt32(item+12,true)===0){const canvas=document.createElement('canvas');canvas.width=1920;canvas.height=1080;const c=canvas.getContext('2d');c.drawImage(document.querySelector('canvas'),0,0);const rows=[];for(let rank=0;rank<8;rank++){const x=rank<4?330:1070,y=rank<4?195+rank*72:640+(rank-4)*72;const pixels=c.getImageData(x,y,580,62).data;let count=0;for(let j=0;j<pixels.length;j+=4)if(Math.max(pixels[j],pixels[j+1],pixels[j+2])>80)count++;rows.push(count);}const key='stable-results-'+resultsSamples.length;captures[key]=document.querySelector('canvas').toDataURL();resultsSamples.push({frame:mk64._web_frame(),render:mk64._web_render_frames(),rows});break;}}}
if(fb===null&&window.mk64&&window.mem){const v=new DataView(mem.buffer),idx=v.getInt32(symbols.gIndexLakituList,true),obj=symbols.gObjectList+idx*0xe0;const f=mk64._web_frame();if(mk64._web_state()===4&&(v.getInt32(obj+0x54,true)&16)){const kind=v.getUint8(obj+0xd8);if(kind!==lastKind){firstVisible=f;lastKind=kind;}if(firstVisible===null)firstVisible=f;if(f>=firstVisible+30&&f<firstVisible+36){const key='lakitu-kind'+kind+'-'+f+'-'+mk64._web_render_frames();captures[key]=document.querySelector('canvas').toDataURL();lakituFrames.push({key,status:v.getInt32(obj+0x54,true),pos:[4,8,12].map(o=>v.getFloat32(obj+o,true)),tex:v.getUint32(obj+0x64,true),pal:v.getUint32(obj+0x60,true),anim:v.getInt8(obj+0xd2),alpha:v.getInt16(obj+0xa0,true)});}}}if(fb===null&&window.mk64&&window.captureNext){captures[window.captureNext]=document.querySelector('canvas').toDataURL();window.captureNext=null;}return r;};
window.mk64InputsAtFrame=frame=>{if(window.mem){const v=new DataView(mem.buffer);if(window.mk64&&frame%30===0)trace.push({frame,race:mk64._web_race_state(),game:mk64._web_state(),time:v.getFloat32(symbols.gCourseTimer,true),laps:[0,1].map(i=>v.getInt32(symbols.gLapCountByPlayerId+4*i,true))});if(cpu&&window.mk64?._web_state()===4){const p=v.getUint32(symbols.gPlayerOne,true);for(let i=0;i<2;i++)v.setUint16(p+i*0xdd8,v.getUint16(p+i*0xdd8,true)|0x1000,true);}}return controls;};
},{symbols});
await page.goto(base);await page.waitForFunction(()=>window.mk64?._web_frame()>200,null,{timeout:90000});
assert(await page.evaluate(()=>new DataView(mem.buffer).getInt32(symbols.gGlobalTimer,true)===mk64._web_frame()),'Link map must match served WASM');
const state=()=>page.evaluate(()=>({frame:mk64._web_frame(),menu:mk64._web_menu(),stage:mk64._web_main_menu_selection(),players:mk64._web_selected_players(),selected:[0,1].map(i=>mk64._web_character_selected(i)),game:mk64._web_state(),race:mk64._web_race_state(),mode:new DataView(mem.buffer).getInt32(symbols.gModeSelection,true)}));
async function step(n){const f=await page.evaluate(()=>mk64._web_frame());await page.waitForFunction(f=>mk64._web_frame()>=f,f+n,{timeout:60000});}
async function tap(i,buttons=0,x=0,y=0){await page.evaluate(({i,buttons,x,y})=>controls[i]={buttons,x,y},{i,buttons,x,y});await step(4);await page.evaluate(i=>controls[i]={buttons:0,x:0,y:0},i);await step(18);}
for(let i=0;i<10;i++){const s=await state();if(s.menu===11&&s.stage===3)break;await tap(0,s.menu===10?0x1000:0x4000);}
assert.equal((await state()).stage,3);
for(let i=0;i<4&&(await state()).players!==2;i++)await tap(0,0,80);
assert.equal((await state()).players,2);
for(let i=0;i<8&&(await state()).menu!==12;i++)await tap(0,0x8000);
for(let i=0;i<2;i++)for(let j=0;j<8&&!(await state()).selected[i];j++){if(j)await tap(i,0,80);await tap(i,0x8000);}
for(let i=0;i<12&&(await state()).game!==4;i++)await tap(0,0x8000);
console.log('race entry',await state());assert.equal((await state()).mode,0);
await page.evaluate(()=>{cpu=true;controls=[{buttons:0x8000,x:0,y:0},{buttons:0x8000,x:0,y:0}];});
for(let i=0;i<12;i++){await step(8);await page.evaluate(i=>window.captureNext='countdown-'+i,i);await step(1);}
await page.waitForFunction(()=>mk64._web_race_state()===3,null,{timeout:60000});
if(short){
await step(160);
await page.evaluate(()=>{const v=new DataView(mem.buffer);for(let i=0;i<2;i++){const obj=symbols.gObjectList+v.getInt32(symbols.gIndexLakituList+4*i,true)*0xe0;for(const offset of [0x54,0x58,0x5c])v.setInt32(obj+offset,0,true);for(const offset of [0xcb,0xcd,0xcf])v.setUint8(obj+offset,0);v.setInt16(obj+0xa6,1,true);v.setUint8(obj+0xd8,4);}});
await step(100);
}
if(!short){await page.evaluate(()=>fastForward=true);
let done=false;
for(let i=0;i<80;i++){await page.waitForTimeout(3000);const s=await page.evaluate(()=>trace.at(-1));if(i%5===0)console.log(s);if(s.laps.every(l=>l>=3)){done=true;break;}}
assert(done,'finish 2p GP');await page.evaluate(()=>{fastForward=false;controls=[{buttons:0,x:0,y:0},{buttons:0,x:0,y:0}];});
for(let i=0;i<6;i++){await step(60);await page.evaluate(i=>window.captureNext='results-'+i,i);await step(1);}
}
const result=await page.evaluate(()=>({resultsSamples,spriteDraws,lakituFrames,trace,captures,hd:mk64.mk64HD?.stats,glError:gl.getError(),frame:mk64._web_frame()}));for(const[n,img]of Object.entries(result.captures))fs.writeFileSync(`${out}/${n}.png`,Buffer.from(img.split(',')[1],'base64'));delete result.captures;result.errors=errors;
assert.deepEqual(errors,[]);assert.equal(result.glError,0);
if(result.hd)assert.equal(result.hd.failed,0);
if(short&&profile!=='hd30'){
    const frames=[...new Set(result.lakituFrames.filter(row=>row.key.startsWith('lakitu-kind4-')).map(row=>Number(row.key.split('-')[2])))];
    assert.equal(frames.length,6,'Capture both lap-sign passes on six consecutive simulation frames');
    result.lakituWidthChange=[];
    for(const frame of frames)for(const viewY of [0,540]){
        const draws=result.spriteDraws.filter(row=>row.frame===frame&&row.w===72&&row.viewport[1]===viewY);
        const passes=[...new Set(draws.map(row=>row.render))];assert.equal(passes.length,2);
        const widths=passes.map(pass=>{const pts=draws.filter(row=>row.render===pass).flatMap(row=>row.pts);return Math.max(...pts.map(p=>p[0]))-Math.min(...pts.map(p=>p[0]));});
        const change=Math.abs(widths[1]-widths[0])/widths[1];
        result.lakituWidthChange.push({frame,viewY,change});
        assert(change<.02,`Lakitu size must not oscillate between presentation passes: ${change}`);
    }
}
if(!short){
    assert.equal(result.resultsSamples.length,6,'Reach the settled GP points panel');
    for(const sample of result.resultsSamples)assert(sample.rows.every(count=>count>500),`All eight result rows must be visible: ${sample.rows}`);
}
result.passed=true;
fs.writeFileSync(`${out}/report.json`,JSON.stringify(result,null,2));console.log('done',result.frame,result.glError,errors);
}finally{await b.close();}})().catch(e=>{console.error(e);process.exitCode=1});
