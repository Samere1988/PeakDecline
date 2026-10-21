/* Browser keyboard event -> production input host -> real native simulation ->
 * fresh draw submission. This does NOT measure controller hardware or photons.
 * A neutral remote player is delivered synchronously; no network stalls. */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..');
const build = path.resolve(process.env.SMASH_BUILD || path.join(root, '.tmp/battleship-web/build-wasm'));
const cfg = {inputDelay:Number(process.env.SMASH_INPUT_DELAY ?? 1),
    presses:Number(process.env.SMASH_PRESSES || 40), warmup:300, hashInterval:60, maxPrediction:6};
assert.ok([0,1,2,3,4].includes(cfg.inputDelay));
assert.ok(Number.isInteger(cfg.presses) && cfg.presses > 0 && cfg.presses <= 300);
const files = ['BattleShip.o2r','BattleShip.o2r.recipe','f3d.o2r','gamecontrollerdb.txt','config.yml',
    'assets/custom/fonts/Montserrat-Regular.ttf','assets/custom/fonts/Inconsolata-Regular.ttf'];
const scripts = {'rollback.js':path.join(root,'static/js/netplay/rollback.js'),
    'wasm_frame_adapter.js':path.join(root,'static/js/netplay/wasm_frame_adapter.js'),
    'rollback_adapter.js':path.join(root,'ports/smash64/rollback_adapter.js')};
const parentHtml = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:#111}iframe{border:0;width:640px;height:480px;display:block}</style>
<div id="game" data-runtime-url="/runtime"><div class="retro-frame-shell">
<div data-game-frame></div><div class="n64-touch-controls"></div></div>
<button data-game-restart hidden></button></div>
<script>
window.PeakNet={adapters:new Map(),backends:new Map()};
// Only unrelated device/UI services are stubbed. The production keyboard
// listeners, edge buffer, sampling, iframe bridge and rollback engine are used.
window.RetroControllers={create:()=>({read:()=>({buttons:0,x:0,y:0}),cancel(){}})};
window.GameFullscreen={create:()=>({bindSurface(){}})};
window.N64Touch={create:()=>({read:()=>({buttons:0,x:0,y:0}),setEnabled(){},destroy(){},reset(){}})};
window.errors=[];
window.fail=e=>{window.failed=String(e?.stack||e);};
addEventListener('error',e=>{errors.push(e.message);fail(e.message);});
addEventListener('unhandledrejection',e=>fail(e.reason));
</script><script src="/rollback.js"></script><script src="/wasm_frame_adapter.js"></script><script>
const cfg=${JSON.stringify(cfg)};
const now=()=>performance.now();
window.records=[];window.stats={frames:0,attempts:0,stalls:0,first:null,last:null,drawSubmissions:0,cachedSubmissions:0};
let current=null, lastCompleted=0, measuring=false, latestNative=null;
window.captureKey=(e,origin)=>{
    if(!measuring || e.code!=='KeyX' || e.repeat || e.type!=='keydown')return;
    if(current && current.renderAt===undefined)fail('Overlapping probes');
    current={id:records.length+1,eventAt:origin+e.timeStamp-performance.timeOrigin,
        handlerAt:now(),trusted:e.isTrusted,code:e.code,
        baselineMotion:latestNative?.motion,baselineAttack:latestNative?.attack};
    records.push(current);
};
addEventListener('keydown',e=>captureKey(e,performance.timeOrigin),true);
const socket={connected:true,on(){},off(){},emit(type,e){
    if(type==='input')session.receiveInput({epoch:1,slot:1,frame:e.frame,pad:{buttons:0,x:0,y:0}});
    if(type==='failed')fail(e.message);
}};
window.session=new PeakNet.RollbackSession({socket,epoch:1,players:2,slot:0,spectator:false,
    game:{backend:'rollback-v1',inputSchema:'n64-pad-v1',tickRate:60,
        rollback:{inputDelay:cfg.inputDelay,maxPrediction:cfg.maxPrediction,hashInterval:cfg.hashInterval}},onFailure:fail});
const bind=session.bind.bind(session);
session.bind=adapter=>{
    const sample=adapter.sampleInput;
    adapter.sampleInput=()=>{
        const pad=sample();
        if(current && current.sampleAt===undefined && (pad.buttons&0x8000)){
            current.sampleAt=now();current.targetFrame=session.frame+session.delay;
        }
        return pad;
    };
    bind(adapter);session.start();
};
const begin=session.beginAdvance.bind(session);
session.beginAdvance=()=>{
    const next=begin();if(measuring){++stats.attempts;if(!next)++stats.stalls;}return next;
};
const complete=session.completeAdvance.bind(session);
session.completeAdvance=()=>{
    const f=session.frame, accepted=complete();
    if(!accepted)return accepted;
    lastCompleted=f;
    const m=document.querySelector('iframe').contentWindow.Module;
    const data=m.HEAPU32 || document.querySelector('iframe').contentWindow.HEAPU32;
    const p=m._peak_rb_fighter_details()>>>2;
    latestNative={hold:data[p+1],tap:data[p+2],motion:data[p+7],attack:data[p+14]};
    const active=m._peak_rb_scene()===22 && m._peak_rb_status()===1;
    if(!measuring && f>cfg.warmup && active){measuring=true;window.ready=true;}
    if(measuring){
        if(!active)fail('Probe left active battle');
        const t=now();if(stats.first===null)stats.first=t;stats.last=t;++stats.frames;
        if(current && current.sampleAt!==undefined && f>=current.targetFrame){
            if(current.consumeAt===undefined && (latestNative.hold&0x8000)){
                current.consumeAt=t;current.consumeFrame=f;current.nativeTap=latestNative.tap;
            }
            if(current.consumeAt!==undefined && current.actionAt===undefined && latestNative.motion!==current.baselineMotion){
                current.actionAt=t;current.actionFrame=f;current.motion=latestNative.motion;current.attack=latestNative.attack;
            }
        }
    }
    return accepted;
};
window.present=(timestamp,draws)=>{
    if(!measuring)return;
    if(draws)++stats.drawSubmissions;else ++stats.cachedSubmissions;
    if(!current || !draws)return;
    if(current.consumeAt!==undefined && current.renderAt===undefined && lastCompleted>=current.consumeFrame){
        current.renderAt=timestamp;current.renderFrame=lastCompleted;current.drawCalls=draws;
    }
    if(current.actionAt!==undefined && current.actionRenderAt===undefined && lastCompleted>=current.actionFrame)
        current.actionRenderAt=timestamp;
};
PeakNet.registerFrameGame({id:'smash64',title:'Smash input latency test',elementId:'game'});
PeakNet.adapters.get('smash64').launch({session,canRestart:false,slot:0}).catch(fail);
</script>`;
const runtimeHtml = `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#000}</style>
<canvas id="canvas" width="640" height="480" tabindex="0"></canvas>
<script src="/rollback_adapter.js"></script><script>
window.__runHidden=true;window.__inputLagDraws=0;
addEventListener('keydown',e=>parent.captureKey(e,performance.timeOrigin),true);
window.__inputLagPresent=()=>{
    parent.present(performance.timeOrigin+performance.now()-parent.performance.timeOrigin,window.__inputLagDraws);
    window.__inputLagDraws=0;
};
window.startPeakGame=()=>{
    let bound=false;
    window.Module={peakNativeFlow:true,peakHybridRollback:true,peakCatchup:true,
        canvas:document.querySelector('canvas'),noInitialRun:true,
        print:()=>{},printErr:t=>console.warn(t),onAbort:parent.fail,
        peakAdvance(){
            if(parent.failed || parent.finished)return false;
            if(!bound){peakGameBridge.loaded(o=>createSmashRollbackAdapter(Module,o));bound=true;}
            return peakGameBridge.begin();
        },
        peakComplete(){return peakGameBridge.complete();},
        readPorts(ptr){for(let i=0;i<4;++i){const p=(ptr>>2)+i*4;HEAP32[p]=i<2?2:1;HEAP32[p+1]=HEAP32[p+2]=HEAP32[p+3]=0;}},
        preRun:[()=>{
            ENV.SSB64_BOOT_BATTLE='0,8,4,0';ENV.SSB64_BOOT_SLOTS='hhoo';ENV.SSB64_VS_INTRO='0';
            addRunDependency('assets');
            Promise.all(${JSON.stringify(files)}.map(async f=>{
                const r=await fetch('/'+f);if(!r.ok)throw Error('Missing '+f);
                FS.mkdirTree('/'+f.split('/').slice(0,-1).join('/'));FS.writeFile('/'+f,new Uint8Array(await r.arrayBuffer()));
            })).then(()=>removeRunDependency('assets')).catch(parent.fail);
        }],onRuntimeInitialized(){Module.callMain([]);}
    };
    const script=document.createElement('script');script.src='/BattleShip.js';document.body.append(script);
};
</script>`;
const originalJs=fs.readFileSync(path.join(build,'BattleShip.js'),'utf8');
function replaceExactlyOnce(source,needle,replacement){
    assert.equal(source.split(needle).length,2,'Native JS instrumentation marker must occur once: '+needle);
    return source.replace(needle,replacement);
}
// Patch only the HTTP response, never the candidate or published files. Fast3D
// uses drawArrays; cached ImGui-only presentation uses indexed drawing.
let instrumentedJs=replaceExactlyOnce(originalJs,'var _emscripten_glDrawArrays = (mode, first, count) => {',
    'var _emscripten_glDrawArrays = (mode, first, count) => {\n  ++window.__inputLagDraws;');
instrumentedJs=replaceExactlyOnce(instrumentedJs,'var _eglSwapBuffers = (dpy, surface) => {',
    'var _eglSwapBuffers = (dpy, surface) => {\n  window.__inputLagPresent();');
const server=http.createServer((req,res)=>{
    const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname).slice(1);
    res.setHeader('Cross-Origin-Opener-Policy','same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy','credentialless');
    if(!name || name==='runtime'){res.setHeader('Content-Type','text/html');return res.end(name?runtimeHtml:parentHtml);}
    if(![...files,'BattleShip.js','BattleShip.wasm',...Object.keys(scripts)].includes(name)){res.statusCode=404;return res.end();}
    res.setHeader('Content-Type',name.endsWith('.wasm')?'application/wasm':name.endsWith('.js')?'text/javascript':'application/octet-stream');
    if(name==='BattleShip.js')return res.end(instrumentedJs);
    fs.createReadStream(scripts[name]||path.join(build,name)).on('error',()=>{res.statusCode=404;res.end();}).pipe(res);
});
function distribution(values){
    const a=values.filter(Number.isFinite).sort((x,y)=>x-y);
    const at=p=>a.length?a[Math.floor((a.length-1)*p)]:null;
    return {count:a.length,min:at(0),median:at(.5),p95:at(.95),max:at(1)};
}
function sourceHash(filename){return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');}
(async()=>{
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||undefined,
        args:['--enable-unsafe-swiftshader','--autoplay-policy=no-user-gesture-required']});
    try{
        const page=await browser.newPage({viewport:{width:680,height:520}});
        const logs=[];page.on('console',m=>{if(['warning','error'].includes(m.type()))logs.push(m.text());});
        page.on('pageerror',e=>logs.push(e.stack));
        await page.goto('http://127.0.0.1:'+server.address().port);
        await page.waitForFunction(()=>window.failed||window.ready,null,{timeout:120000});
        assert.equal(await page.evaluate(()=>window.failed),undefined);
        await page.frameLocator('iframe').locator('canvas').focus();
        if(process.env.SMASH_SCREENSHOT)await page.screenshot({path:process.env.SMASH_SCREENSHOT});
        for(let i=0;i<cfg.presses;i++){
            // Deterministic, non-frame-multiple spacing varies input phase.
            await new Promise(r=>setTimeout(r,410+(i*73%137)));
            await page.keyboard.down('x');
            await new Promise(r=>setTimeout(r,55));
            await page.keyboard.up('x');
            await page.waitForFunction(n=>window.failed||(records.length===n && records[n-1].actionRenderAt!==undefined),i+1,{timeout:5000});
            assert.equal(await page.evaluate(()=>window.failed),undefined);
        }
        const result=await page.evaluate(()=>{
            window.finished=true;
            const child=document.querySelector('iframe').contentWindow;
            const gl=child.GLctx, ext=gl.getExtension('WEBGL_debug_renderer_info');
            return {records,stats,errors,failed:window.failed,frame:session.frame,confirmed:session.engine.confirmed,
                rollbacks:session.engine.rollbacks,native:session.adapter.nativeTimings(),engine:session.engine.metrics,
                renderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER)};
        });
        assert.equal(result.failed,undefined);assert.deepEqual(result.errors,[]);
        assert.equal(result.records.length,cfg.presses);
        assert.equal(result.stats.stalls,0,'Clean-path measurement must not contain simulation stalls');
        assert.equal(result.rollbacks,0,'Immediate neutral remote input must not cause corrections');
        assert.ok(result.confirmed>=result.frame-1,'All completed simulation frames must be confirmed');
        for(const r of result.records){
            assert.equal(r.trusted,true);
            assert.ok(r.handlerAt>=r.eventAt-.5 && r.sampleAt>=r.handlerAt-.5 && r.consumeAt>=r.sampleAt-.5 && r.renderAt>=r.consumeAt-.5,JSON.stringify(r));
            assert.equal(r.consumeFrame,r.targetFrame,'Input must be consumed in its intended simulation frame');
            assert.ok(r.nativeTap&0x8000,'Native fighter must see A tap');
            // A motion-count change alone could be an unrelated idle/status
            // transition. Every accepted probe must start idle and become
            // Mario jab1 (native attack ID 1) in the input's intended frame.
            assert.equal(r.baselineAttack,0,'Probe must start with no active attack');
            assert.equal(r.attack,1,'Native response must be Mario jab1');
            assert.equal(r.actionFrame,r.consumeFrame,'Attack must start when the input is consumed');
            assert.ok(r.actionAt>=r.consumeAt-.5 && r.actionRenderAt>=r.actionAt-.5);
            assert.ok(r.drawCalls>0,'Must observe a fresh game draw');
        }
        const metric=(a,b)=>distribution(result.records.map(r=>r[b]-r[a]));
        const report={measuredAt:new Date().toISOString(),config:cfg,build,browser:browser.version(),
            method:'Trusted CDP keyboard events delivered through the unmodified production keyboard/iframe host. Real candidate WASM; neutral immediate remote input; active battle after 300-frame warmup. EGL hook and drawArrays count identify fresh game CPU submission after native A consumption/attack motion. Headless SwiftShader: no physical controller, compositor presentation or photon measurement. Device/UI stubs exclude gamepad and touch.',
            hashes:Object.fromEntries([...Object.values(scripts),path.join(build,'BattleShip.js'),path.join(build,'BattleShip.wasm'),__filename].map(f=>[path.relative(root,f),sourceHash(f)])),
            fps:(result.stats.frames-1)*1000/(result.stats.last-result.stats.first),
            eventToHandlerMs:metric('eventAt','handlerAt'),eventToSampleMs:metric('eventAt','sampleAt'),
            sampleToNativeMs:metric('sampleAt','consumeAt'),eventToNativeMs:metric('eventAt','consumeAt'),
            nativeToDrawSubmissionMs:metric('consumeAt','renderAt'),eventToDrawSubmissionMs:metric('eventAt','renderAt'),
            eventToAttackMs:metric('eventAt','actionAt'),eventToAttackDrawSubmissionMs:metric('eventAt','actionRenderAt'),
            ...result,logs:logs.slice(-10)};
        if(process.env.SMASH_REPORT){fs.mkdirSync(path.dirname(process.env.SMASH_REPORT),{recursive:true});fs.writeFileSync(process.env.SMASH_REPORT,JSON.stringify(report,null,2)+'\n');}
        console.log(JSON.stringify({config:cfg,fps:report.fps,stalls:report.stats.stalls,
            eventToSampleMs:report.eventToSampleMs,eventToNativeMs:report.eventToNativeMs,
            eventToAttackDrawSubmissionMs:report.eventToAttackDrawSubmissionMs}));
    }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;server.close();});
