/* Isolated browser smoke test. Does not register Smash or open production DBs. */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {chromium,firefox} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..');
const build = path.resolve(process.env.SMASH_BUILD || path.join(root, '.tmp/battleship-web/build-wasm'));
const slots=process.env.SMASH_SLOTS;
if(slots && !/^[hco]{4}$/.test(slots))throw Error('Invalid Smash slot roles.');
const frameLimit=Number(process.env.SMASH_FRAMES||600),players=Number(process.env.SMASH_PLAYERS||2);
if(slots && (slots.slice(0,players)!=='h'.repeat(players) || slots.slice(players).includes('h')))
    throw Error('Human slot roles must match SMASH_PLAYERS and occupy the first ports.');
const fighters=(process.env.SMASH_FIGHTERS||'0,8,2,3').split(',').map(Number),stage=Number(process.env.SMASH_STAGE||4);
if(fighters.length!==4 || fighters.some(n=>!Number.isInteger(n)||n<0||n>11) || !Number.isInteger(stage)||stage<0||stage>8)throw Error('Invalid Smash fighters/stage.');
if(!Number.isInteger(frameLimit)||frameLimit<1||frameLimit>3600||![1,2,4].includes(players))throw Error('Invalid Smash test configuration.');
if(process.env.SMASH_PROBE && !['boot','save'].includes(process.env.SMASH_PROBE)) throw new Error('SMASH_PROBE must be boot or save.');
const files = ['BattleShip.o2r', 'f3d.o2r', 'gamecontrollerdb.txt', 'config.yml',
    'assets/custom/fonts/Montserrat-Regular.ttf', 'assets/custom/fonts/Inconsolata-Regular.ttf'];
const recipe = fs.existsSync(path.join(build, 'BattleShip.o2r.recipe')) ?
    fs.readFileSync(path.join(build, 'BattleShip.o2r.recipe'), 'utf8').trim() :
    fs.readFileSync(path.join(build, 'build.ninja'), 'utf8').match(/SSB64_ASSET_RECIPE_HASH=\\"([a-f0-9]+)/)[1];
const gameplayCase=process.env.SMASH_GAMEPLAY_CASE;
const gameplay=gameplayCase?require('./smash_gameplay_scenarios.cjs'):null;
const gameplayConfig=gameplay?.configuration(gameplayCase,root);
let recordedGameplayInputs=null;
const gameplayRuns=[];
const fingerprint={
    wasm:require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(build,'BattleShip.wasm'))).digest('hex'),
    sources:Object.fromEntries(['tests/games/smash_browser.cjs','tests/games/smash_gameplay_scenarios.cjs',
        'tests/games/smash_gameplay_extended.cjs','ports/smash64/prepare_effects.py','ports/smash64/rollback_exports.c','ports/smash64/prepare_rollback.py']
        .map(p=>[p,require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(root,p))).digest('hex')]))
};
const html = `<!doctype html><canvas id="canvas" width="640" height="480"></canvas>
<script>window.PeakNet={backends:new Map()};</script><script src="/rollback.js"></script><script src="/rollback_adapter.js"></script><script>
window.__runHidden = true;
window.errors = []; window.addEventListener('error', e => { errors.push(e.message);window.failed=e.message; });
window.frameHashes=[];
window.eggPredictions=0;
window.digests={}; window.weaponDetails={};
window.confirmedHashes={}; window.pending=[]; window.wallTick=0;
const delayed=new URLSearchParams(location.search).has('delayed');
const probe=new URLSearchParams(location.search).get('probe');
const frameLimit=${frameLimit},players=${players};
${gameplay ? `const gameplay=(${gameplay.create.toString()})(${JSON.stringify(gameplayConfig)});
window.gameplayInputs={};window.gameplayStates={};window.gameplayExtras={};window.gameplayRewinds=[];
const replayInputs=__GAMEPLAY_RECORDED_INPUTS__;
const gameplayRead=()=>{
 if(!Module._peak_rb_gameplay_details)throw Error('Rebuild Smash for gameplay diagnostics.');
 const p=Module._peak_rb_gameplay_details()>>>2;
 return Array.from(HEAP32.subarray(p,p+64));
};
const gameplayExtra=()=>{
 if(!Module._peak_rb_gameplay_extra)throw Error("Rebuild Smash for extended gameplay diagnostics.");
 const p=Module._peak_rb_gameplay_extra()>>>2;
 return Array.from(HEAP32.subarray(p,p+129+HEAP32[p+128]*12));
};
const gameplaySample=(f,slot)=>{
 if(!gameplayInputs[f])gameplayInputs[f]=replayInputs?replayInputs[f]:gameplay.input(f,gameplayRead(),gameplayExtra());
 if(!gameplayInputs[f])throw Error('Missing recorded gameplay input '+f);
 return gameplayInputs[f][slot];
};` : ''}
const input=(f,slot)=>(${process.env.SMASH_KO ? '{buttons:0,x:slot===1?(f%24<12?-80:-79):0,y:0}' : `{buttons:${process.env.SMASH_SPECIALS ? 'f%90<8?16384:' : ''}f%60<10?32768:0,x:(f+slot*30)%120<60?45:-45,y:0}`});
${process.env.SMASH_ANIMATION_MOVES ? `
const animationInput=(f,slot)=>{
 const phase=(f+slot*17)%240;
 const special=phase%25<6?16384:0;
 if(phase<25)return {buttons:8192,x:0,y:0};
 if(phase<50)return {buttons:special,x:0,y:-65};
 if(phase<75)return {buttons:special,x:0,y:65};
 if(phase<100)return {buttons:special,x:slot%2?-45:45,y:0};
 if(phase<125)return {buttons:phase%25<6?8:0,x:slot%2?-45:45,y:0};
 return {buttons:phase%35<8?32768:0,x:(f+slot*30)%120<60?45:-45,y:0};
};` : ''}
var Module = {
 ${process.env.SMASH_HYBRID ? 'peakNativeFlow:true, peakHybridRollback:true,' : ''}
 canvas: document.querySelector('canvas'),
 print: t => console.log(t), printErr: t => console.warn(t),
 peakAdvance() {
   if(window.failed || window.finished) return;
   try {
     if(!window.engine) {
       console.log('PEAK creating adapter');
       const adapter=createSmashRollbackAdapter(Module,{sampleInput:()=>({buttons:0,x:0,y:0})});
       ${gameplay ? `
       const gameplaySave=adapter.saveState,gameplayRestore=adapter.restoreState,savedGameplay=new Map();
       adapter.saveState=context=>{
         const state=[...gameplayRead(),...gameplayExtra()],handle=gameplaySave(context);
         savedGameplay.set(handle,state);
         for(const f of savedGameplay.keys())if(f<handle-16)savedGameplay.delete(f);
         return handle;
       };
       adapter.restoreState=handle=>{
         gameplayRewinds.push({from:handle,to:engine.frame});
         gameplayRestore(handle);
         const actual=[...gameplayRead(),...gameplayExtra()],expected=savedGameplay.get(handle);
         if(!expected || actual.length!==expected.length || actual.some((v,i)=>v!==expected[i]))throw Error('Gameplay state did not round-trip at '+handle+': '+JSON.stringify({expected,actual}));
       };
       const gameplayHash=adapter.hashState;
       adapter.hashState=()=>{const h=gameplayHash();const f=HEAPU32[Module._peak_rb_digest()>>>2];gameplayStates[f]=gameplayRead();gameplayExtras[f]=gameplayExtra();return h;};
       ` : ''}
       ${process.env.SMASH_REQUIRE_MATERIALS ? `
       const restoreMaterials=adapter.restoreState;
       adapter.restoreState=handle=>{
         restoreMaterials(handle);
         if(!Module._peak_rb_verify_materials || !Module._peak_rb_verify_materials(handle))
           throw Error('Material animation did not round-trip at frame '+handle);
       };` : ''}
       const canPredict=adapter.canPredict;
       adapter.canPredict=context=>{
         const allowed=canPredict(context);
         if(allowed && Module._peak_rb_egg_stats){
           Module._peak_rb_hash();
           const p=Module._peak_rb_digest()>>>2;
           if(Array.from(HEAPU32.subarray(p+28,p+32)).includes(178))++eggPredictions;
         }
         return allowed;
       };
       const hash=adapter.hashState;adapter.hashState=()=>{const h=hash();if(Module._peak_rb_digest){const p=Module._peak_rb_digest()>>2;const d=Array.from(HEAPU32.subarray(p,p+60));if(Module._peak_rb_fighter_details){const q=Module._peak_rb_fighter_details()>>2;d.push(...HEAPU32.subarray(q,q+64));}digests[d[0]]=d;if(${!!process.env.SMASH_OBJECT_DETAILS} && Module._peak_rb_weapon_details){const w=Module._peak_rb_weapon_details()>>>2;weaponDetails[d[0]]=Array.from(HEAPU32.subarray(w,w+1+HEAPU32[w]*96));}}return h;};
       for(const name of ['saveState','simulateFrame','hashState']) { const original=adapter[name]; adapter[name]=(...args)=>{if(frameHashes.length<2)console.log('PEAK '+name+' begin');const value=original(...args);if(frameHashes.length<2)console.log('PEAK '+name+' end');return value;}; }
       ${process.env.SMASH_TRACE ? "for(const name of ['saveState','restoreState','simulateFrame']){const original=adapter[name];adapter[name]=(...args)=>{console.log('TRACE',name,engine?.frame,JSON.stringify(args));const value=original(...args);console.log('TRACE done',name);return value;};}" : ''}
       window.engine=new PeakNet.RollbackEngine({players,maxPrediction:6,adapter});
     }
     if(probe) {
       if(!window.probed) {window.probed=true;if(probe==='save')engine.adapter.saveState();}
       return;
     }
     ++wallTick;
     const sample=${gameplay ? 'gameplaySample' : process.env.SMASH_ANIMATION_MOVES ? 'animationInput' : 'input'};
     for(const p of pending.filter(p=>p.at<=wallTick)) engine.receive(p.slot,p.f,sample(p.f,p.slot));
     pending=pending.filter(p=>p.at>wallTick);
     const f=engine.frame;
     if(f<=frameLimit) {
       engine.receive(0,f,sample(f,0));
       for(let slot=1;slot<players;slot++) {
         if(!delayed || f<400) engine.receive(slot,f,sample(f,slot));
         else if(!pending.some(p=>p.f===f&&p.slot===slot) && !engine.actual.get(f)?.[slot]) pending.push({f,slot,at:wallTick+3});
       }
       const next=engine.beginAdvance();
       if(next) {engine.adapter.queueFrame(next);return true;}
     } else engine.reconcile();
     for(const [n,h] of engine.hashes) if(n<=engine.confirmed) confirmedHashes[n]=h;
     if(engine.frame>frameLimit && engine.confirmed>=frameLimit) window.finished=true;
   } catch(e) {window.failed=String(e.stack||e);errors.push(failed);}
 },
 peakComplete() {
   try { const f=engine.frame; const advanced=engine.completeAdvance(); frameHashes.push(engine.hashes.get(f)); for(const [n,h] of engine.hashes) if(n<=engine.confirmed) confirmedHashes[n]=h; return advanced; }
   catch(e) {window.failed=String(e.stack||e);errors.push(failed);return false;}
 },
 readPorts(ptr) { for (let i=0;i<4;i++) { const p=(ptr>>2)+i*4; HEAP32[p]=i<players?2:1; HEAP32[p+1]=0; HEAP32[p+2]=0; HEAP32[p+3]=0; } },
 preRun: [function () {
   ENV.SSB64_BOOT_BATTLE='${fighters[0]},${fighters[1]},${stage},0'; ENV.SSB64_VS_INTRO='0';
   ${process.env.SMASH_KO ? "ENV.SSB64_STOCKS='1';" : ''}
   if(players===4) {ENV.SSB64_BOOT_BATTLE='${fighters[0]},${fighters[1]},${stage},0,${fighters[2]},${fighters[3]}';ENV.SSB64_BOOT_SLOTS='hhhh';}
   if(players===1) {ENV.SSB64_BOOT_BATTLE='${fighters[0]},${fighters[1]},${stage},1';ENV.SSB64_BOOT_SLOTS='hcoo';}
   ${process.env.SMASH_ITEMS ? "ENV.SSB64_BOOT_SLOTS='h'.repeat(players)+(players===1?'coo':'o'.repeat(4-players));" : ''}
   ${slots ? `ENV.SSB64_BOOT_BATTLE='${fighters[0]},${fighters[1]},${stage},0,${fighters[2]},${fighters[3]}'; ENV.SSB64_BOOT_SLOTS='${slots}';` : ''}
   ${gameplay ? Object.entries(gameplayConfig.env).map(([k,v])=>`ENV[${JSON.stringify(k)}]=${JSON.stringify(v)};`).join('\n') : ''}
   addRunDependency('assets');
   Promise.all(${JSON.stringify(files)}.map(async f => {
     const response = await fetch('/'+f); if(!response.ok) throw Error('Missing '+f);
     FS.mkdirTree('/'+f.split('/').slice(0,-1).join('/')); FS.writeFile('/'+f,new Uint8Array(await response.arrayBuffer()));
   })).then(() => { FS.writeFile('/BattleShip.o2r.recipe', ${JSON.stringify(recipe)}); removeRunDependency('assets'); }).catch(e => errors.push(String(e)));
 }],
 onRuntimeInitialized() { window.ready=true; Module.callMain([]); }
};
if(probe==='boot') delete Module.peakAdvance;
</script><script src="/BattleShip.js"></script>`;
const server = http.createServer((req,res) => {
    const name = decodeURIComponent(new URL(req.url,'http://localhost').pathname).slice(1);
    res.setHeader('Cross-Origin-Opener-Policy','same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy','credentialless');
    if(!name) {res.setHeader('Content-Type','text/html'); return res.end(html.replace('__GAMEPLAY_RECORDED_INPUTS__',JSON.stringify(recordedGameplayInputs)));}
    const scripts = {'rollback.js':path.join(root,'static/js/netplay/rollback.js'),'rollback_adapter.js':path.join(build,'rollback_adapter.js')};
    if(![...files,'BattleShip.js','BattleShip.wasm',...Object.keys(scripts)].includes(name)) {res.statusCode=404;return res.end();}
    res.setHeader('Content-Type', name.endsWith('.wasm')?'application/wasm':name.endsWith('.js')?'text/javascript':'application/octet-stream');
    fs.createReadStream(scripts[name]||path.join(build,name)).on('error',()=>{res.statusCode=404;res.end();}).pipe(res);
});
(async () => {
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    const browser = await chromium.launch({executablePath:process.env.BROWSER_EXECUTABLE || undefined,headless:true,args:['--enable-unsafe-swiftshader','--autoplay-policy=no-user-gesture-required']});
    let alternate=browser;
    try {
        if(process.env.SMASH_MIXED_BROWSERS)alternate=await firefox.launch({headless:true,
            executablePath:process.env.FIREFOX_EXECUTABLE || undefined,
            firefoxUserPrefs:{'webgl.force-enabled':true,'gfx.webrender.software':true}});
        let reference;
        const comparisons=[];
        let referenceDigests,referenceWeapons;
        for(const delayed of (process.env.SMASH_PROBE?[false]:[false,true])) {
        const page=await (delayed?alternate:browser).newPage(); const logs=[];
        let hangTimer;
        if(process.env.SMASH_DEBUG_HANG){
            const cdp=await page.context().newCDPSession(page);
            await cdp.send('Debugger.enable');
            cdp.on('Debugger.paused',async event=>{
                console.error('Paused native stack',JSON.stringify(event.callFrames.map(f=>({name:f.functionName,location:f.location}))));
                for(const scope of event.callFrames[0].scopeChain)if(scope.type==='local')
                    console.error('Native locals',JSON.stringify(await cdp.send('Runtime.getProperties',{objectId:scope.object.objectId,ownProperties:true})));
                cdp.send('Debugger.resume').catch(()=>{});
            });
            hangTimer=setTimeout(()=>cdp.send('Debugger.pause').catch(()=>{}),75000);
        }
        const logPath=(process.env.SMASH_LOG_PREFIX || path.join(root,'.tmp/smash-smoke'))+(delayed?'-delayed':'')+'.log';fs.writeFileSync(logPath,'');
        page.on('console',m=>{logs.push(m.text());fs.appendFileSync(logPath,m.text()+'\n');}); page.on('pageerror',e=>{logs.push('ERROR '+e.stack);fs.appendFileSync(logPath,'ERROR '+e.stack+'\n');});
        await page.goto('http://127.0.0.1:'+server.address().port+(process.env.SMASH_PROBE?'/?probe='+process.env.SMASH_PROBE:delayed?'/?delayed=1':''));
        try {
            await page.waitForFunction(()=>window.failed || (window.ready && Module._port_debug_movement && HEAPF32[Module._port_debug_movement()>>2]===1),{},{timeout:120000});
            if(process.env.SMASH_PROBE) await page.waitForTimeout(3000);
            else await page.waitForFunction(()=>window.failed || window.finished,{},{timeout:120000});
            console.log(await page.evaluate(()=>({errors,frames:frameHashes.length,rollbacks:window.engine?.rollbacks||0,maxItems:Math.max(0,...Object.values(digests).map(d=>d[4])),maxWeapons:Math.max(0,...Object.values(digests).map(d=>d[5])), fighter:Array.from(HEAPF32.subarray(Module._port_debug_movement()>>2,(Module._port_debug_movement()>>2)+12))})));
            if(process.env.SMASH_SCREENSHOT)await page.screenshot({path:path.join(root,'.tmp/smash-smoke.png'),timeout:15000});
            if(await page.evaluate(()=>errors.length)) throw new Error('Smash runtime errors; see .tmp/smash-smoke.log');
            if(process.env.SMASH_ASSERT_CLEAN_RELOC && logs.some(line=>/invalid\/stale token/.test(line)))
                throw new Error('Unexpected relocation warning; inspect native log.');
            if(process.env.SMASH_REQUIRE_EGG && !await page.evaluate(()=>
                Object.values(digests).some(d=>d.slice(28,32).includes(178))))
                throw new Error('Yoshi regression must exercise a fighter trapped in an egg.');
            if(process.env.SMASH_REQUIRE_EGG_ROLLBACK){
                const coverage=await page.evaluate(()=>{
                    if(!Module._peak_rb_egg_stats)throw Error('Rebuild Smash for egg snapshot diagnostics.');
                    const p=Module._peak_rb_egg_stats()>>>2;
                    return {predictions:eggPredictions,stats:Array.from(HEAPU32.subarray(p,p+10))};
                });
                console.log('Egg rollback coverage',coverage);
                if(delayed && (!coverage.predictions || !coverage.stats[1] || !coverage.stats[3] ||
                               !coverage.stats[5] || !coverage.stats[6]))
                    throw new Error('Egg regression must predict, restore, recreate, revive and discard speculative eggs.');
            }
            if(process.env.SMASH_REQUIRE_MATERIALS){
                const coverage=await page.evaluate(()=>{
                    if(!Module._peak_rb_material_stats)throw Error('Rebuild Smash for material snapshot diagnostics.');
                    const p=Module._peak_rb_material_stats()>>>2;
                    return Array.from(HEAPU32.subarray(p,p+7));
                });
                console.log('Material rollback coverage',coverage);
                if(delayed && (!coverage[1] || !coverage[4]))
                    throw Error('Material regression must capture and restore materials.');
                const effects=await page.evaluate(()=>{
                    const p=Module._peak_rb_effect_stats()>>>2;
                    return Array.from(HEAPU32.subarray(p,p+10));
                });
                console.log('Effect rollback coverage',effects);
                if(delayed && process.env.SMASH_REQUIRE_EFFECTS && !effects[1])
                    throw Error('Effect regression must restore effects.');
                const roots=await page.evaluate(()=>{
                    const p=Module._peak_rb_item_root_stats()>>>2;
                    return Array.from(HEAPU32.subarray(p,p+4));
                });
                console.log('Item root rollback coverage',roots);
                if(delayed && process.env.SMASH_REQUIRE_ITEM_ROOTS && !roots[2])
                    throw Error('Item root regression must undo a pickup or release.');
            }
            if(delayed && process.env.SMASH_HYBRID && stage===4 && frameLimit>=3600 &&
               !await page.evaluate(()=>Module._peak_rb_barrier_count()>0))
                throw new Error('Hyrule stress test did not exercise a native confirmation barrier.');
            if(process.env.SMASH_KO && !await page.evaluate(()=>Module._peak_rb_finished())) throw new Error('Knockout scenario did not finish the match.');
            const hashes=await page.evaluate(()=>confirmedHashes);
            comparisons.push({delayed,browser:(delayed?alternate:browser).browserType().name(),
                version:(delayed?alternate:browser).version(),hashes,rollbacks:await page.evaluate(()=>engine.rollbacks)});
            if(gameplay){
                const observed=await page.evaluate(()=>({inputs:gameplayInputs,hashes:confirmedHashes,states:gameplayStates,extras:gameplayExtras,weaponDetails,rewinds:gameplayRewinds,rollbacks:engine.rollbacks,
                    weapons:Object.fromEntries(Object.entries(digests).map(([f,d])=>[f,d[5]]))}));
                if(!delayed)recordedGameplayInputs=observed.inputs;
                gameplayRuns.push({delayed,...observed});
                fs.writeFileSync((process.env.SMASH_REPORT || path.join(root,'.tmp/smash-gameplay.json'))+'.coverage.json',JSON.stringify(gameplayRuns,null,2));
                // Reject an ineffective input script before spending another
                // browser run on it. Successful cases still require both runs.
                if(!delayed)gameplay.verify(gameplayConfig,[gameplayRuns[0],gameplayRuns[0]]);
            }
            if(!delayed) {reference=hashes;referenceDigests=await page.evaluate(()=>digests);referenceWeapons=await page.evaluate(()=>weaponDetails);}
            else for(let f=1;f<=frameLimit;f++) if(!Number.isInteger(hashes[f]) || !Number.isInteger(reference[f]) || hashes[f]!==reference[f]) {
                const actual=await page.evaluate(f=>digests[f],f);
                const differences=referenceDigests[f]?.map((v,i)=>v!==actual?.[i]?{word:i,reference:v,actual:actual?.[i]}:null).filter(Boolean);
                console.log('Digest differences',differences);
                const report={build,players,fighters,stage,slots,frame:f,referenceHash:reference[f],actualHash:hashes[f],differences,
                    reference:referenceDigests[f],actual,referenceWeapons:referenceWeapons[f],actualWeapons:await page.evaluate(f=>weaponDetails[f],f)};
                fs.writeFileSync(process.env.SMASH_REPORT || path.join(root,'.tmp/smash-divergence.json'),JSON.stringify(report,null,2));
                throw new Error('Smash rollback diverged at frame '+f+': '+hashes[f]+' != '+reference[f]);
            }
            if(process.env.SMASH_REQUIRE_EGG_ROLLBACK || process.env.SMASH_REQUIRE_EGG_CLEANUP || process.env.SMASH_REQUIRE_MATERIALS){
                const retained=await page.evaluate(()=>{
                    const before=Module._peak_rb_egg_stats()>>>2;
                    const live=HEAPU32[before+7];
                    Module._peak_rb_end();
                    Module._peak_rb_end(); // Repeated shutdown must be safe.
                    const p=Module._peak_rb_egg_stats()>>>2;
                    return {live,remaining:Array.from(HEAPU32.subarray(p+7,p+10))};
                });
                if(process.env.SMASH_REQUIRE_EGG_CLEANUP && !retained.live)
                    throw Error('Cleanup regression must stop with a live egg.');
                if(retained.remaining.some(Boolean))throw Error('Egg allocations survived session cleanup: '+retained.remaining);
                console.log('Egg cleanup',retained);
                if(process.env.SMASH_REQUIRE_MATERIALS){
                    const count=await page.evaluate(()=>HEAPU32[(Module._peak_rb_material_stats()>>>2)+6]);
                    if(count)throw Error('Material allocations survived session cleanup: '+count);
                    const effects=await page.evaluate(()=>{
                        const p=Module._peak_rb_effect_stats()>>>2;
                        return Array.from(HEAPU32.subarray(p+7,p+10));
                    });
                    if(effects.some(Boolean))throw Error('Effect allocations survived session cleanup: '+effects);
                    const roots=await page.evaluate(()=>HEAPU32[(Module._peak_rb_item_root_stats()>>>2)+3]);
                    if(roots)throw Error('Item roots survived session cleanup: '+roots);
                }
            }
        } finally {clearTimeout(hangTimer);fs.writeFileSync(logPath,logs.join('\n'));await Promise.race([page.close(),new Promise(resolve=>setTimeout(resolve,5000))]);}
        }
        if(gameplay){
            const coverage=gameplay.verify(gameplayConfig,gameplayRuns);
            fs.writeFileSync(process.env.SMASH_REPORT || path.join(root,'.tmp/smash-gameplay.json'),JSON.stringify({passed:true,case:gameplayCase,build,frameLimit,stage,fighters,env:gameplayConfig.env,fingerprint,coverage},null,2));
            console.log('Gameplay coverage',JSON.stringify(coverage));
        }else if(!process.env.SMASH_PROBE){
            const report=process.env.SMASH_REPORT || (process.env.SMASH_LOG_PREFIX || path.join(root,'.tmp/smash-smoke'))+'-comparison.json';
            fs.writeFileSync(report,JSON.stringify({passed:true,build,players,frameLimit,stage,fighters,slots,
                fingerprint,cleanRelocationCheck:!!process.env.SMASH_ASSERT_CLEAN_RELOC,comparisons},null,2));
        }
        console.log('Smash comparison passed:',players,'players,',frameLimit,'frames, stage',stage,'fighters',fighters,
            'browsers',browser.version(),alternate.version());
    } finally {if(alternate!==browser)await alternate.close();await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;server.close();});
