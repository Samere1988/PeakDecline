/* Serial, alternating-order before/after comparisons against a frozen baseline.
 * Pass SMASH_BASELINE_DIR; outputs individual JSON runs plus comparison.json. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const root=path.resolve(__dirname,'../..');
const baseline=path.resolve(process.env.SMASH_BASELINE_DIR||'.tmp/smash-latency-20261013/baseline');
const output=path.resolve(process.env.SMASH_RESULTS_DIR||'.tmp/smash-latency-20261013/results');
const repeats=Number(process.env.SMASH_REPEATS||3);
const profiles={clean:{delay:0,jitter:0,burst:0},delayed:{delay:85,jitter:20,burst:250}};
const variants={baseline:{code:baseline,build:path.join(baseline,'build'),delay:2,hash:1,catchup:0},
    candidate:{code:root,build:path.join(root,'.tmp/battleship-web/build-wasm'),delay:1,hash:60,catchup:1}};
fs.mkdirSync(output,{recursive:true});
const reports=[];
function median(a){a=[...a].sort((x,y)=>x-y);return a[Math.floor(a.length/2)];}
function summarize(){
    const rows=[];
    for(const profile of Object.keys(profiles))for(const variant of Object.keys(variants)){
        const runs=reports.filter(r=>r.profile===profile&&r.variant===variant);
        if(!runs.length)continue;
        rows.push({profile,variant,runs:runs.length,fps:median(runs.map(r=>r.data.fps)),
            inputMedianMs:median(runs.map(r=>r.data.inputCompleteMs.median)),
            inputP95Ms:median(runs.map(r=>r.data.inputCompleteMs.p95)),
            nextRafMedianMs:median(runs.map(r=>r.data.nextRafMs.median)),
            stallPercent:100*median(runs.map(r=>r.data.stallRatio)),
            stepP95Ms:median(runs.map(r=>r.data.stepMs.p95)),
            hashCalls:median(runs.map(r=>r.data.costs.hashState.count)),
            saveCalls:median(runs.map(r=>r.data.costs.saveState.count)),
            rollbackCount:median(runs.map(r=>r.data.rollbacks)),
            catchupFrames:median(runs.map(r=>r.data.native?.catchupFrames||0))});
    }
    const report={method:'Three serial repetitions per configuration by default; before/after order alternates. Table values are medians of per-run statistics, not pooled percentiles.',
        limitations:'Synthetic ordered remote input delays on one real WASM instance, headless Chromium on one machine. Excludes hardware polling and display photon latency. WebRTC tested separately.',
        metricNotes:{stallPercent:'Fraction of attempted advances returning false, not wall-time stalled. Catchup makes extra attempts, so this counter is not directly comparable between versions.',
            inputTiming:'Local sample to completed native simulation; nextRaf is a callback proxy only.'},
        allCheckpointHashesMatch:true,rows,runs:reports.map(({profile,variant,repeat,file})=>({profile,variant,repeat,file}))};
    fs.writeFileSync(path.join(output,'comparison.json'),JSON.stringify(report,null,2)+'\n');return report;
}
(async()=>{
    let hashes;
    for(const [profile,net]of Object.entries(profiles))for(let repeat=0;repeat<repeats;repeat++){
        for(const variant of (repeat%2?['candidate','baseline']:['baseline','candidate'])){
            const v=variants[variant],file=path.join(output,profile+'-'+variant+'-'+(repeat+1)+'.json');
            const env={...process.env,SMASH_CODE_ROOT:v.code,SMASH_BUILD:v.build,SMASH_INPUT_DELAY:String(v.delay),
                SMASH_HASH_INTERVAL:String(v.hash),SMASH_CATCHUP:String(v.catchup),SMASH_DELAY_MS:String(net.delay),
                SMASH_JITTER_MS:String(net.jitter),SMASH_BURST_MS:String(net.burst),SMASH_REPORT:file};
            console.log('Running',profile,variant,'repeat',repeat+1);
            const exit=await new Promise((resolve,reject)=>{
                const child=spawn(process.execPath,[path.join(__dirname,'smash_latency.cjs')],{cwd:root,env,stdio:'inherit'});
                child.once('error',reject);child.once('exit',resolve);
            });
            assert.equal(exit,0,'Benchmark failed');
            const data=JSON.parse(fs.readFileSync(file,'utf8'));
            if(hashes)assert.deepEqual(data.hashes,hashes,'Confirmed gameplay changed between runs');else hashes=data.hashes;
            reports.push({profile,variant,repeat:repeat+1,file,data});summarize();
        }
    }
    console.table(summarize().rows);
})().catch(e=>{console.error(e);process.exitCode=1;});
