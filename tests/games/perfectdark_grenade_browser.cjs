/* Same-allocation airborne-grenade correction. Isolated --perfectdark fixture. */
const assert = require('node:assert/strict');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const control = process.argv.includes('--control');
(async () => {
    const browser = await chromium.launch({headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? {executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH} : {})});
    const pages = [], errors = [];
    try {
        for (let instance = 0; instance < 2; instance++) {
            const page = await browser.newPage(); pages.push(page);
            page.on('pageerror', e => errors.push(e.message));
            await page.addInitScript(() => window.peakPdLaunchOptions = {controlled: true, players: 2, seed: 12345});
            await page.request.get('http://127.0.0.1:8066/test-login/grenade-' + instance);
            await page.goto('http://127.0.0.1:8066/games/retro/preview/perfectdark');
            await page.locator('#start').click();
            await page.waitForFunction(() => window.peakPdEngine || window.peakPdError, null, {timeout: 60000});
            assert.equal(await page.evaluate(() => window.peakPdError || null), null);
            const setup = await page.evaluate(() => {
                const n = window.smokeNeutral = {buttons:0,moveX:0,moveY:0,lookX:0,lookY:0};
                for (let tick=0;tick<601;tick++) peakPdEngine.step([{...n,buttons:tick%100===0?128:0},n]);
                peakPdEngine.startCombat(37,Array(6).fill(28));
                for (let tick=0;tick<120;tick++) peakPdEngine.step([n,n]);
                const initial=peakPdEngine.captureComponents(), candidates=[];
                for (let slot=0;slot<2;slot++) {
                    const id=initial.meta.players[slot], epoch=initial.meta.epoch;
                    const player=initial[`player:${epoch}:${id}`], pos=initial[`prop:${epoch}:${id}`].position;
                    for (const [key,p] of Object.entries(initial))
                        if (key.startsWith('prop:') && p.type===1 && p.enabled && initial[key.replace('prop:','object:')]?.type===20 &&
                            Math.abs(p.position[1]-player.feetGround)<30)
                            candidates.push({slot,target:p.position,distance:Math.hypot(p.position[0]-pos[0],p.position[2]-pos[2])});
                }
                candidates.sort((a,b)=>a.distance-b.distance);
                const target=candidates[0];
                if (!target || target.distance>500) throw new Error('No original grenade ammo pickup nearby');
                window.smokeSlot=target.slot;
                window.smokeStep=command=>{
                    const row=[{...n},{...n}];row[smokeSlot]={...n,...command};
                    peakPdEngine.step(row);return peakPdEngine.drainEvents();
                };
                for (let tick=0;tick<220;tick++) {
                    const p=peakPdEngine.observe().players[smokeSlot],dx=target.target[0]-p.position[0],dz=target.target[2]-p.position[2];
                    const angle=(Math.atan2(-dx,dz)*180/Math.PI-p.yaw+540)%360-180;
                    smokeStep({moveY:Math.hypot(dx,dz)>20?100:0,lookX:Math.round(Math.max(-15,Math.min(15,angle))*32767/180)});
                }
                smokeStep({buttons:32});
                for(let tick=0;tick<90;tick++)smokeStep({});
                smokeStep({buttons:1024});
                for(let tick=0;tick<90;tick++)smokeStep({});
                const before=peakPdEngine.captureComponents();
                const hand=before[`hand:${before.meta.epoch}:${before.meta.players[smokeSlot]}:0`];
                if(hand.function!==1)throw new Error('Secondary grenade mode not selected: '+JSON.stringify(hand));
                smokeStep({buttons:1});
                for(let tick=0;tick<400;tick++) {
                    smokeStep({});
                    try {
                        const state=peakPdEngine.capturePlayerState({grenades:true});
                        if(state.smoke.sources.some(id=>id>0))return {tick:state.tick,source:state.smoke.sources,slot:smokeSlot};
                    } catch { /* Wait for native weapon transitions to finish. */ }
                }
                throw new Error('No native grenade-linked smoke found: '+JSON.stringify(peakPdEngine.captureComponents()));
            });
            console.log('Airborne grenade fixture:',setup);
        }
        const capture = page => page.evaluate(() => peakPdEngine.capturePlayerState({grenades:true}));
        const initial=await capture(pages[0]);assert.deepEqual(await capture(pages[1]),initial);
        assert.equal(initial.schema,'pd-player-grenades-v1');
        assert.equal(initial.grenades.length,1);
        await pages[1].evaluate(snapshot=>{
            const read=()=>JSON.stringify({state:peakPdEngine.capturePlayerState({grenades:true}),components:peakPdEngine.captureComponents(),tick:peakPdEngine.tick});
            const before=read();
            for(const fault of ['missing','duplicate','stale','partial','nan','asset','owner','room','fuse','late-player','epoch']) {
                const bad=structuredClone(snapshot),g=bad.grenades[0];
                if(fault==='missing')bad.grenades=[];
                if(fault==='duplicate')bad.grenades.push(structuredClone(g));
                if(fault==='stale')g.entity=0xfffffffe;
                if(fault==='partial')g.fields.pop();
                if(fault==='nan')g.fields[57]=NaN;
                if(fault==='asset')g.fields[0]++;
                if(fault==='owner')g.fields[11]=0xfffffffe;
                if(fault==='room')g.fields[17]=32767;
                if(fault==='fuse')g.fields[55]=0;
                if(fault==='late-player')bad.players.at(-1).movement[0]=1e20;
                if(fault==='epoch')bad.epoch++;
                let rejected=false;try{peakPdEngine.restorePlayerState(bad);}catch{rejected=true;}
                if(!rejected||before!==read())throw new Error('Invalid grenade changed state: '+fault);
            }
            peakPdEngine.restorePlayerState(snapshot);
            peakPdEngine.restorePlayerState(snapshot);
            if(before!==read())throw new Error('Restore must be idempotent without changing local entity identities');
            if(peakPdEngine.drainEvents().length)throw new Error('Restore emitted gameplay events');
        },initial);
        const wrong=structuredClone(initial);
        wrong.grenades[0].fields[57]+=2;
        wrong.grenades[0].fields[55]+=40;
        await pages[1].evaluate(s=>peakPdEngine.restorePlayerState(s),wrong);
        for(const page of pages)await page.evaluate(()=>{for(let i=0;i<3;i++)smokeStep({});});
        const correction=await capture(pages[0]);
        assert.notDeepEqual((await capture(pages[1])).grenades,correction.grenades,'Wrong velocity must move the original grenade');
        if(!control)await pages[1].evaluate(s=>peakPdEngine.restorePlayerState(s),correction);
        if(!control)assert.deepEqual(await capture(pages[1]),correction);
        const traces=[];
        for(const page of pages)traces.push(await page.evaluate(()=>{
            const trace=[];
            for(let i=0;i<150;i++){
                const events=smokeStep({});
                const c=peakPdEngine.captureComponents(), grenadeIds=Object.keys(c).filter(k=>k.startsWith('weapon:')&&c[k].weapon===30).map(k=>k.split(':')[2]);
                trace.push({projectiles:Object.fromEntries(Object.entries(c).filter(([key])=>key.startsWith('projectile:')||key.startsWith('weapon:')||(key.startsWith('prop:')||key.startsWith('object:'))&&grenadeIds.includes(key.split(':')[2]))),smoke:peakPdEngine.captureSmokeState(),
                    random:Array.from({length:4},(_,j)=>Module._peakPdRandomWord(j)),
                    events:events.map(({type,tick,data})=>({type,tick,data}))});
            }
            return trace;
        }));
        require('node:fs').writeFileSync('.tmp/perfectdark/grenade'+(control?'-control':'')+'.json',JSON.stringify(traces));
        const originalSource = initial.smoke.sources.find(id=>id>0);
        assert.ok(traces[0][0].smoke.sources.includes(originalSource));
        assert.ok(!traces[0].at(-1).smoke.sources.includes(originalSource), 'Native source release must clear the attachment');
        assert.ok(traces[0].some(t=>t.events.some(e=>e.type==='explosion')), 'Replay must reach the original grenade explosion');
        if(control)assert.notDeepEqual(traces[0].map(t=>t.events),traces[1].map(t=>t.events), 'Omitting grenade correction must change the native explosion outcome');
        else assert.deepEqual(traces[0],traces[1]);
        assert.deepEqual(errors,[]);
        console.log(control?'Omitted grenade correction reproduced native outcome divergence.':'Airborne grenade validation, correction and 150-tick replay passed.');
    }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
