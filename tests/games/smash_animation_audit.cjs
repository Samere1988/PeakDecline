/* Real WASM replay regression matrix. Build/stage Smash before running. */
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const output = path.resolve(process.env.SMASH_AUDIT_OUTPUT || path.join(root, '.tmp/smash-animation-audit'));
const workers = Number(process.env.SMASH_AUDIT_WORKERS || 2);
if (!Number.isInteger(workers) || workers < 1 || workers > 3) throw Error('Use 1–3 audit workers.');
fs.mkdirSync(output, {recursive:true});
const egg = {SMASH_STAGE:'4', SMASH_PLAYERS:'2', SMASH_SPECIALS:'1', SMASH_FIGHTERS:'8,6,1,0', SMASH_SLOTS:'hhco'};
const jobs = [
    {name:'egg-long', env:{...egg, SMASH_FRAMES:'3600', SMASH_REQUIRE_EGG_ROLLBACK:'1', SMASH_REQUIRE_ITEM_ROOTS:'1', SMASH_REQUIRE_EFFECTS:'1'}},
    {name:'hybrid-hyrule-long', env:{...egg, SMASH_FRAMES:'3600', SMASH_HYBRID:'1', SMASH_REQUIRE_EFFECTS:'1'}},
    ...Array.from({length:9}, (_,stage)=>({name:'stage-'+stage, env:{
        SMASH_STAGE:String(stage), SMASH_PLAYERS:'4', SMASH_FRAMES:'900', SMASH_ANIMATION_MOVES:'1', SMASH_REQUIRE_EFFECTS:'1',
        SMASH_FIGHTERS:['0,3,6,9','1,4,7,10','2,5,8,11'][stage%3]
    }})),
    {name:'egg-cleanup', env:{...egg, SMASH_FRAMES:'600', SMASH_REQUIRE_EGG_CLEANUP:'1'}},
    {name:'hybrid-effects', env:{SMASH_STAGE:'8', SMASH_PLAYERS:'4', SMASH_FRAMES:'900',
        SMASH_ANIMATION_MOVES:'1', SMASH_FIGHTERS:'2,5,8,11', SMASH_HYBRID:'1', SMASH_REQUIRE_EFFECTS:'1'}},
];
const results = [];
async function run() {
    while (jobs.length) {
        const job = jobs.shift();
        const logPath = path.join(output, job.name+'.log');
        const fd = fs.openSync(logPath, 'w');
        const env = {...process.env};
        // Scenario flags must not leak from a caller's previous single test.
        for (const key of ['SMASH_SPECIALS','SMASH_ANIMATION_MOVES','SMASH_SLOTS','SMASH_HYBRID',
            'SMASH_KO','SMASH_PROBE','SMASH_TRACE','SMASH_REQUIRE_EGG','SMASH_REQUIRE_EGG_ROLLBACK',
            'SMASH_REQUIRE_EGG_CLEANUP','SMASH_REQUIRE_ITEM_ROOTS','SMASH_REQUIRE_EFFECTS']) delete env[key];
        Object.assign(env, job.env, {SMASH_REQUIRE_MATERIALS:'1', SMASH_OBJECT_DETAILS:'1',
            SMASH_REPORT:path.join(output,job.name+'.json'), SMASH_LOG_PREFIX:path.join(output,job.name+'-native')});
        let exitCode;
        try {
            exitCode = await new Promise((resolve,reject)=>{
                const child = spawn(process.execPath, [path.join(__dirname,'smash_browser.cjs')],
                    {cwd:root, env, stdio:['ignore',fd,fd]});
                child.once('error', reject);
                child.once('exit', code=>resolve(code ?? 1));
            });
        } finally { fs.closeSync(fd); }
        results.push({name:job.name, configuration:job.env, exitCode, logPath});
        fs.writeFileSync(path.join(output,'results.json'), JSON.stringify(results,null,2)+'\n');
        console.log(job.name+': '+(exitCode===0?'passed':'FAILED (see '+logPath+')'));
        if (exitCode !== 0) process.exitCode = 1;
    }
}
Promise.all(Array.from({length:workers},run)).catch(error=>{console.error(error);process.exitCode=1;});
