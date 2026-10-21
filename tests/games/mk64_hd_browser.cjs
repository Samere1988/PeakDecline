/* Real WASM graphics comparison; run against the local development harness. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {execFileSync}=require('node:child_process');
const {chromium}=require(process.env.MK64_PLAYWRIGHT||path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const root=path.resolve(__dirname,'../..');
const base=process.env.MK64_HARNESS_URL||'http://127.0.0.1:8064/';
assert.equal(new URL(base).hostname,'127.0.0.1');
const out=path.resolve(process.env.MK64_TEST_OUTPUT||path.join(root,'.tmp/mk64-hd-20261013'));
const map=fs.readFileSync(process.env.MK64_LINK_MAP||path.join(root,'.tmp/mk64/build/link.map'),'utf8');
const symbols=Object.fromEntries(['gPlayerOne','gCourseTimer'].map(name=>{
    const m=map.match(new RegExp('^([0-9a-f]+)\\s+[^\\n]+\\s'+name+'$','m'));assert(m);return[name,parseInt(m[1],16)];
}));

(async()=>{
    fs.mkdirSync(out,{recursive:true});const report={profiles:[],errors:[]};
    const browser=await chromium.launch({headless:true,
        executablePath:process.env.MK64_BROWSER||path.join(os.homedir(),'.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'),
        args:[...(process.env.MK64_TEST_GPU==='software'?['--enable-unsafe-swiftshader']:['--enable-gpu','--disable-gpu-sandbox','--use-angle=gl']), '--autoplay-policy=no-user-gesture-required']});
    try {
        for(const baseline of [true,false]){
            const name=baseline?'baseline':'1080p-hd-aa';const context=await browser.newContext();const page=await context.newPage();
            page.on('pageerror',e=>report.errors.push({name,message:e.message}));
            await page.route(base,async route=>{const r=await route.fetch(),html=await r.text();
                await route.fulfill({response:r,body:html.replace('noInitialRun:true',`noInitialRun:true,mk64GraphicsBaseline:${baseline}`)
                    .replace('module.mk64Input = input;',`module.mk64Input = input;module.mk64RenderFps=${baseline?30:60};`)});
            });
            await page.addInitScript(({symbols,baseline})=>{
                for(const name of ['instantiate','instantiateStreaming']){const original=WebAssembly[name];WebAssembly[name]=async function(...args){const r=await original.apply(this,args);window.testMemory=(r.instance||r).exports.memory;return r;};}
                const originalContext=HTMLCanvasElement.prototype.getContext;
                HTMLCanvasElement.prototype.getContext=function(kind,options){const gl=originalContext.call(this,kind,kind==='webgl'?{...options,preserveDrawingBuffer:true}:options);if(kind==='webgl')window.testGL=gl;return gl;};
                let takeover=false,program=null,framebuffer=null;
                const aaLocations=new Map();window.testCaptures={};
                for(const method of ['useProgram','bindFramebuffer','getUniformLocation','drawArrays']){
                    const original=WebGLRenderingContext.prototype[method];
                    WebGLRenderingContext.prototype[method]=function(...args){
                        if(method==='useProgram')program=args[0];
                        if(method==='bindFramebuffer')framebuffer=args[1];
                        const value=original.apply(this,args);
                        if(method==='getUniformLocation'&&args[1]==='uAA'&&value)aaLocations.set(args[0],value);
                        if(method==='drawArrays'&&window.mk64&&mk64._web_frame()===1300&&framebuffer===null&&aaLocations.has(program)&&!testCaptures.normal&&
                            (baseline||mk64._web_render_frames()%2===1)){
                            testCaptures.normal=document.querySelector('canvas').toDataURL();
                            if(!baseline){
                                const location=aaLocations.get(program);
                                this.uniform1i(location,0);original.apply(this,args);
                                testCaptures.noAA=document.querySelector('canvas').toDataURL();
                                this.uniform1i(location,1);original.apply(this,args);
                            }
                        }
                        return value;
                    };
                }
                window.mk64InputAtFrame=frame=>{
                    if(frame>=1040){if(!takeover){const v=new DataView(testMemory.buffer),p=v.getUint32(symbols.gPlayerOne,true);v.setUint16(p,v.getUint16(p,true)|0x1000,true);takeover=true;}return{buttons:0x8000,x:0,y:0};}
                    if(frame>=300&&frame<305)return{buttons:0x1000,x:0,y:0};
                    for(let i=1;i<=8;i++)if(frame>=300+i*60&&frame<305+i*60)return{buttons:0x8000,x:0,y:0};
                    return{buttons:0,x:0,y:0};
                };
            },{symbols,baseline});
            await page.goto(base);await page.waitForFunction(()=>window.mk64?._web_frame()>=1050,null,{timeout:150000});
            const sample=()=>page.evaluate(address=>({frame:mk64._web_frame(),render:mk64._web_render_frames(),time:new DataView(testMemory.buffer).getFloat32(address,true),now:performance.now()}),symbols.gCourseTimer);
            const before=await sample();await page.waitForTimeout(6000);const after=await sample(),elapsed=(after.now-before.now)/1000;
            await page.waitForFunction(()=>mk64._web_frame()>=1330,null,{timeout:60000});
            const row=await page.evaluate(()=>{
                const ext=testGL.getExtension('WEBGL_debug_renderer_info'),errors=[];
                let error;while((error=testGL.getError())!==testGL.NO_ERROR)errors.push(error);
                return{width:mk64.canvas.width,height:mk64.canvas.height,renderer:ext?testGL.getParameter(ext.UNMASKED_RENDERER_WEBGL):'unknown',
                    aaFrames:mk64._web_aa_frames(),hd:mk64.mk64HD?.stats||null,captures:testCaptures,glErrors:errors,
                    hashes:Array.from({length:1150},(_,i)=>mk64._web_hash_for_frame(150+i)>>>0)};
            });
            row.name=name;row.simulationFPS=(after.frame-before.frame)/elapsed;row.renderFPS=(after.render-before.render)/elapsed;row.gameSpeed=(after.time-before.time)/elapsed;
            assert(row.hashes.every(Boolean));assert.equal(row.width,baseline?640:1920);assert.equal(row.height,baseline?480:1080);
            assert.deepEqual(row.glErrors,[]);assert(row.captures.normal,'Capture the original pass at an exact simulation frame');
            fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(row.captures.normal.split(',')[1],'base64'));
            if(!baseline){
                assert(row.aaFrames>2000);assert(row.hd.applied>100);assert(row.hd.groups.karts>10);assert(row.hd.groups.common_data>10);
                assert((row.hd.groups.other_textures||0)+(row.hd.groups.tracks||0)>10);assert.equal(row.hd.failed,0);
                assert(row.hd.bitmapBytes<=64*1024*1024);assert(row.captures.noAA);
                fs.writeFileSync(path.join(out,'1080p-hd-no-aa.png'),Buffer.from(row.captures.noAA.split(',')[1],'base64'));
            }
            const stopped=await page.evaluate(()=>{mk64._web_stop();return mk64._web_frame();});
            await page.waitForFunction(()=>mk64._web_is_stopped(),null,{timeout:3000});await page.waitForTimeout(500);
            assert(await page.evaluate(f=>mk64._web_frame()<=f+1,stopped));
            if(!baseline)assert.equal(await page.evaluate(()=>mk64.mk64HD.stats.bitmapBytes),0);
            delete row.captures;report.profiles.push(row);console.log(name,row.simulationFPS,row.renderFPS,row.hd?.groups);
            await context.close();
        }
        assert.deepEqual(report.profiles[0].hashes,report.profiles[1].hashes,'1080p/HD/AA must preserve original gameplay');
        report.matchingFrames=1150;for(const row of report.profiles)delete row.hashes;
        report.aaPixels=JSON.parse(execFileSync(process.env.MK64_PYTHON||'python3',['-c',
            'from PIL import Image,ImageChops,ImageStat\nimport sys,json\na=Image.open(sys.argv[1]).convert("RGB");b=Image.open(sys.argv[2]).convert("RGB");d=ImageChops.difference(a,b);print(json.dumps({"changedPixels":sum(any(c>2 for c in p) for p in d.getdata()),"meanDifference":sum(ImageStat.Stat(d).mean)/3}))',
            path.join(out,'1080p-hd-aa.png'),path.join(out,'1080p-hd-no-aa.png')],{encoding:'utf8'}));
        assert(report.aaPixels.changedPixels>1000,'AA must change actual edge pixels');assert(report.aaPixels.meanDifference<20);
        assert.deepEqual(report.errors,[]);report.result='passed';
        fs.writeFileSync(path.join(out,'graphics-report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
    }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
