/* Repeatable real-WASM benchmark with a scripted remote player. No production
 * server/database, no hardware-to-photon claim. Run baseline and candidate
 * serially; use the same Chromium, workload, network profile and frame count. */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..');
const code = path.resolve(process.env.SMASH_CODE_ROOT || root);
const build = path.resolve(process.env.SMASH_BUILD || path.join(root, '.tmp/battleship-web/build-wasm'));
const config = {
    frames: Number(process.env.SMASH_FRAMES || 900), warmup: 300,
    inputDelay: Number(process.env.SMASH_INPUT_DELAY || 2),
    hashInterval: Number(process.env.SMASH_HASH_INTERVAL || 1),
    delayMs: Number(process.env.SMASH_DELAY_MS || 0),
    jitterMs: Number(process.env.SMASH_JITTER_MS || 0),
    burstMs: Number(process.env.SMASH_BURST_MS || 0),
    catchup: process.env.SMASH_CATCHUP !== '0',
};
assert.ok(config.frames > config.warmup && config.frames <= 3600);
assert.ok([0,1,2,3,4].includes(config.inputDelay));
const files = ['BattleShip.o2r', 'BattleShip.o2r.recipe', 'f3d.o2r', 'gamecontrollerdb.txt', 'config.yml',
    'assets/custom/fonts/Montserrat-Regular.ttf', 'assets/custom/fonts/Inconsolata-Regular.ttf'];
const html = `<!doctype html><meta charset="utf-8"><canvas id="canvas" width="640" height="480"></canvas>
<script>window.PeakNet={backends:new Map()};</script>
<script src="/rollback.js"></script><script src="/rollback_adapter.js"></script><script>
window.__runHidden = true;
const cfg = ${JSON.stringify(config)};
const neutral = () => ({buttons:0,x:0,y:0});
// Inputs are a function of target frame, including the same neutral prefix at
// every input-delay setting. Final checksums must therefore match across runs.
const pad = (f,slot) => f<=2 ? neutral() :
    ({buttons:f%90<8?16384:f%60<10?32768:0,x:(f+slot*30)%120<60?35:-35,y:0});
window.errors=[]; window.addEventListener('error',e=>{errors.push(e.message);window.failed=e.message;});
window.addEventListener('unhandledrejection',e=>{window.failed=String(e.reason);});
window.stats={attempts:0,stalls:0,activeAttempts:0,activeStalls:0,first:null,last:null,
    inputQueue:[],inputComplete:[],inputRaf:[],step:[],rafIntervals:[],costs:{},hashes:{},activeFrames:0};
const sampled=new Map(), remoteSent=new Set(), rafPending=[], stepStarted=new Map();
let deliveryAt=0, pendingWasActive=false, lastRaf=null;
function raf(now){
    if(stats.first!==null && !window.finished){if(lastRaf!==null)stats.rafIntervals.push(now-lastRaf);lastRaf=now;}
    for(const when of rafPending.splice(0))stats.inputRaf.push(performance.now()-when);
    if(!window.finished)requestAnimationFrame(raf);
}
requestAnimationFrame(raf);
function active(){return Module._peak_rb_scene()===22 && Module._peak_rb_status()===1;}
function recordHashes(){
    const end=Math.min(session.engine.confirmed,session.frame-1,(session.engine.dirty??Infinity)-1);
    for(const [f,h] of session.engine.hashes)if(f<=end && f%60===0)stats.hashes[f]=h;
}
function deliverRemote(f){
    if(remoteSent.has(f))return;remoteSent.add(f);
    const lag=cfg.delayMs+(f*17%31)/30*cfg.jitterMs+(f%180===0?cfg.burstMs:0);
    deliveryAt=Math.max(deliveryAt,performance.now()+lag);
    const receive=()=>{session.receiveInput({epoch:1,slot:1,frame:f,pad:pad(f,1)});recordHashes();};
    if(deliveryAt<=performance.now())receive();else setTimeout(receive,deliveryAt-performance.now());
}
const socket={connected:true,emit(type,event){
    if(type==='input')deliverRemote(event.frame);
    if(type==='failed')window.failed=event.message;
},on(){},off(){}};
var Module={peakNativeFlow:true,peakHybridRollback:true,peakCatchup:cfg.catchup,
    canvas:document.querySelector('canvas'),
    print:()=>{},printErr:t=>console.warn(t),onAbort:e=>{window.failed=String(e);},
    peakAdvance(){
        if(window.failed || window.finished)return false;
        try{
            if(!window.session){
                const adapter=createSmashRollbackAdapter(Module,{sampleInput:()=>{
                    const f=session.frame+session.delay;sampled.set(f,performance.now());return pad(f,0);
                }});
                for(const name of ['saveState','restoreState','simulateFrame','hashState']){
                    const original=adapter[name];stats.costs[name]=[];
                    adapter[name]=(...args)=>{const start=performance.now();try{return original(...args);}
                        finally{if(session?.frame>cfg.warmup && active())stats.costs[name].push(performance.now()-start);}};
                }
                window.session=new PeakNet.RollbackSession({socket,epoch:1,players:2,slot:0,spectator:false,
                    game:{inputSchema:'n64-pad-v1',tickRate:60,rollback:{inputDelay:cfg.inputDelay,maxPrediction:6,hashInterval:cfg.hashInterval}},
                    onFailure:e=>{window.failed=e;}});
                session.bind(adapter);session.start();
            }
            if(session.frame>cfg.frames){
                session.engine.reconcile();recordHashes();
                if(session.engine.confirmed>=cfg.frames && session.engine.dirty===null){
                    stats.rollbacks=session.engine.rollbacks;stats.replayedFrames=session.engine.replayedFrames;
                    stats.native=session.adapter.nativeTimings?.();stats.engine=session.engine.metrics;
                    stats.predicted=Module._peak_rb_predicted_count();stats.barriers=Module._peak_rb_barrier_count();
                    window.finished=true;
                }
                return false;
            }
            const measuring=session.frame>cfg.warmup && active();
            ++stats.attempts;if(measuring)++stats.activeAttempts;
            const start=performance.now(), next=session.beginAdvance();recordHashes();
            if(!next){++stats.stalls;if(measuring)++stats.activeStalls;return false;}
            pendingWasActive=measuring;
            stepStarted.set(next.frame,start);
            if(measuring){
                if(stats.first===null)stats.first=start;
                const when=sampled.get(next.frame);if(when!==undefined)stats.inputQueue.push(performance.now()-when);
            }
            session.adapter.queueFrame(next);return true;
        }catch(e){window.failed=String(e.stack||e);return false;}
    },
    peakComplete(){
        try{
            const f=session.frame, accepted=session.completeAdvance();recordHashes();
            if(accepted && pendingWasActive){
                const now=performance.now();stats.last=now;++stats.activeFrames;
                stats.step.push(now-stepStarted.get(f));
                const when=sampled.get(f);if(when!==undefined){stats.inputComplete.push(now-when);rafPending.push(when);}
            }
            if(accepted)sampled.delete(f);stepStarted.delete(f);return accepted;
        }catch(e){window.failed=String(e.stack||e);return false;}
    },
    readPorts(ptr){for(let i=0;i<4;++i){const p=(ptr>>2)+i*4;HEAP32[p]=i<2?2:1;HEAP32[p+1]=HEAP32[p+2]=HEAP32[p+3]=0;}},
    preRun:[()=>{
        ENV.SSB64_BOOT_BATTLE='0,8,4,0';ENV.SSB64_BOOT_SLOTS='hhoo';ENV.SSB64_VS_INTRO='0';
        addRunDependency('assets');
        Promise.all(${JSON.stringify(files)}.map(async f=>{
            const r=await fetch('/'+f);if(!r.ok)throw Error('Missing '+f);
            FS.mkdirTree('/'+f.split('/').slice(0,-1).join('/'));FS.writeFile('/'+f,new Uint8Array(await r.arrayBuffer()));
        })).then(()=>removeRunDependency('assets')).catch(e=>{window.failed=String(e);});
    }],onRuntimeInitialized(){Module.callMain([]);}
};
</script><script src="/BattleShip.js"></script>`;
const scripts={'rollback.js':path.join(code,'static/js/netplay/rollback.js'),
    'rollback_adapter.js':path.join(code,'ports/smash64/rollback_adapter.js')};
const server=http.createServer((req,res)=>{
    const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname).slice(1);
    res.setHeader('Cross-Origin-Opener-Policy','same-origin');res.setHeader('Cross-Origin-Embedder-Policy','credentialless');
    if(!name){res.setHeader('Content-Type','text/html');return res.end(html);}
    if(![...files,'BattleShip.js','BattleShip.wasm',...Object.keys(scripts)].includes(name)){res.statusCode=404;return res.end();}
    res.setHeader('Content-Type',name.endsWith('.wasm')?'application/wasm':name.endsWith('.js')?'text/javascript':'application/octet-stream');
    fs.createReadStream(scripts[name]||path.join(build,name)).on('error',()=>{res.statusCode=404;res.end();}).pipe(res);
});
function distribution(values){
    const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b);
    const at=p=>sorted.length?sorted[Math.floor((sorted.length-1)*p)]:null;
    return {count:sorted.length,median:at(.5),p95:at(.95),max:at(1),total:sorted.reduce((a,b)=>a+b,0)};
}
(async()=>{
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||undefined,
        args:['--enable-unsafe-swiftshader','--autoplay-policy=no-user-gesture-required']});
    try{
        const page=await browser.newPage();const logs=[];
        page.on('console',m=>{if(m.type()==='warning'||m.type()==='error')logs.push(m.text());});
        await page.goto('http://127.0.0.1:'+server.address().port);
        await page.waitForFunction(()=>window.failed||window.finished,null,{timeout:180000});
        const result=await page.evaluate(()=>({stats,failed:window.failed,errors,hybrid:Module.peakHybridRollback}));
        assert.equal(result.failed,undefined,result.failed);assert.deepEqual(result.errors,[]);
        assert.equal(result.hybrid,true);assert.ok(result.stats.activeFrames>100,'Must measure active combat');
        assert.ok(Object.hasOwn(result.stats.hashes,String(config.frames)),'Final confirmed checkpoint missing');
        const s=result.stats;
        const report={config,code,build,browser:browser.version(),measuredAt:new Date().toISOString(),
            method:'One real WASM instance with a scripted remote player; ordered synthetic delivery delays. Active battle status Go only, first 300 simulation frames excluded. rAF is a scheduling proxy, not photon latency.',
            activeFrames:s.activeFrames,fps:(s.activeFrames-1)*1000/(s.last-s.first),
            stallRatio:s.activeStalls/Math.max(1,s.activeAttempts),
            inputQueueMs:distribution(s.inputQueue),inputCompleteMs:distribution(s.inputComplete),nextRafMs:distribution(s.inputRaf),
            stepMs:distribution(s.step),rafIntervalMs:distribution(s.rafIntervals),
            costs:Object.fromEntries(Object.entries(s.costs).map(([k,v])=>[k,distribution(v)])),
            rollbacks:s.rollbacks,replayedFrames:s.replayedFrames,predicted:s.predicted,barriers:s.barriers,
            native:s.native,engine:s.engine,hashes:s.hashes,logs:logs.slice(-10)};
        if(process.env.SMASH_REPORT){fs.mkdirSync(path.dirname(process.env.SMASH_REPORT),{recursive:true});fs.writeFileSync(process.env.SMASH_REPORT,JSON.stringify(report,null,2)+'\n');}
        console.log(JSON.stringify({fps:report.fps,stallRatio:report.stallRatio,inputQueueMs:report.inputQueueMs,
            inputCompleteMs:report.inputCompleteMs,rollbacks:report.rollbacks,finalHash:s.hashes[config.frames]}));
    }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;server.close();});
