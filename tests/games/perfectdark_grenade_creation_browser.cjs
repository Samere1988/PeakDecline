/* Missing airborne-grenade creation and future identity recovery. Isolated --perfectdark fixture. */
const assert = require('node:assert/strict');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const withoutPresentation = process.argv.includes('--no-present');
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
            if (instance === 1 && withoutPresentation) await page.evaluate(()=>peakPdEngine.setPresentation(false));
            const setup = await page.evaluate(instance => {
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
                // Only the authority throws: create real disagreement using input,
                // without directly editing memory or using a native spawn helper.
                smokeStep({buttons:instance===0?1:0});
                for(let tick=0;tick<49;tick++)smokeStep({});
                const state=peakPdEngine.capturePlayerState({grenadeCreation:true});
                return {tick:state.tick,grenades:state.grenades.length,source:state.smoke.sources,slot:smokeSlot};
            },instance);
            console.log('Airborne grenade fixture:',setup);
        }
        const capture=page=>page.evaluate(()=>peakPdEngine.capturePlayerState({grenadeCreation:true}));
        const authority=await capture(pages[0]), recipient=await capture(pages[1]);
        assert.equal(authority.schema,'pd-player-grenades-v3');
        assert.equal(authority.grenades.length,1);assert.equal(recipient.grenades.length,0);
        assert.equal(authority.tick,recipient.tick);
        const created=authority.grenades[0].entity;
        assert.ok(authority.smoke.sources.includes(created));
        console.log('Creation contract:',authority.allocation,authority.grenades[0].birth,authority.grenades[0].fields.slice(0,14));
        await pages[1].evaluate(({authority,recipient,created})=>{
            const read=()=>JSON.stringify({state:peakPdEngine.capturePlayerState({grenadeCreation:true}),components:peakPdEngine.captureComponents()});
            const before=read();
            for(const fault of ['legacy','asset','owner','future-id','watermark','allocation-state','armed','flags','birth','missing-order','late-player','epoch','capacity']) {
                const bad=structuredClone(authority),g=bad.grenades[0];
                if(fault==='legacy')bad.schema='pd-player-grenades-v2';
                if(fault==='asset')g.fields[0]++;
                if(fault==='owner')g.fields[11]=0xfffffffe;
                if(fault==='future-id')g.entity=bad.allocation[0]+1;
                if(fault==='watermark')bad.allocation[0]=0;
                if(fault==='allocation-state')bad.allocation[1]=9999;
                if(fault==='armed')g.fields[55]=1;
                if(fault==='flags')g.fields[2]=0xffffffff;
                if(fault==='birth')g.birth[2]=0;
                if(fault==='missing-order')bad.smoke.order=bad.smoke.order.filter(id=>id!==created);
                if(fault==='late-player')bad.players.at(-1).movement[0]=1e20;
                if(fault==='epoch')bad.epoch++;
                if(fault==='capacity'){
                    bad.grenades=Array.from({length:32},(_,i)=>({...structuredClone(g),entity:created+i}));
                    bad.allocation[0]=created+33;
                    bad.smoke.order.push(...bad.grenades.slice(1).map(g=>g.entity));
                }
                let rejected=false;try{peakPdEngine.restorePlayerState(bad);}catch{rejected=true;}
                if(!rejected||read()!==before)throw new Error('Invalid creation mutated the world: '+fault);
            }
        },{authority,recipient,created});
        if(!control){
            await pages[1].evaluate(snapshot=>{
                peakPdEngine.restorePlayerState(snapshot);
                const once=JSON.stringify(peakPdEngine.captureComponents());
                peakPdEngine.restorePlayerState(snapshot);
                if(once!==JSON.stringify(peakPdEngine.captureComponents()))throw new Error('Creation is not idempotent');
                if(peakPdEngine.drainEvents().length)throw new Error('Creation emitted gameplay events');
            },authority);
            assert.deepEqual(await capture(pages[1]),authority);
        }
        const traces=[];
        for(const page of pages)traces.push(await page.evaluate(()=>{
            const trace=[];
            for(let i=0;i<200;i++){
                const events=smokeStep({buttons:i===60?1:0});
                if(i%30===0)peakPdEngine.present();
                const c=peakPdEngine.captureComponents(), grenadeIds=Object.keys(c).filter(k=>k.startsWith('weapon:')&&c[k].weapon===30).map(k=>k.split(':')[2]);
                trace.push({projectiles:Object.fromEntries(Object.entries(c).filter(([key])=>key.startsWith('projectile:')||key.startsWith('weapon:')||(key.startsWith('prop:')||key.startsWith('object:'))&&grenadeIds.includes(key.split(':')[2]))),smoke:peakPdEngine.captureSmokeState(),
                    random:Array.from({length:4},(_,j)=>Module._peakPdRandomWord(j)),
                    events:events.map(({type,tick,data})=>({type,tick,data}))});
            }
            return trace;
        }));
        require('node:fs').writeFileSync('.tmp/perfectdark/grenade-creation'+(control?'-control':'')+'.json',JSON.stringify(traces));
        assert.ok(traces[0].some(t=>t.events.some(e=>e.type==='explosion')),'Authority grenade must explode');
        const nextIds=traces[0].flatMap(t=>Object.keys(t.projectiles).filter(key=>key.startsWith('projectile:')).map(key=>Number(key.split(':')[2])));
        const nextThrow=traces[0].flatMap(t=>t.events).find(e=>e.data.attack==='throw'&&e.data.entity>created);
        assert.ok(nextThrow && nextIds.includes(nextThrow.data.entity),'Replay must include a controller-triggered subsequent native throw');
        if(control)assert.notDeepEqual(traces[0],traces[1],'Missing grenade must cause native divergence');
        else assert.deepEqual(traces[0],traces[1]);
        if(!control) for(const page of pages) await page.evaluate(old=>{
            const epoch=peakPdEngine.captureEntities().meta.epoch;
            peakPdEngine.startCombat(37,Array(6).fill(28));
            for(let i=0;i<120;i++)smokeStep({});
            if(peakPdEngine.captureEntities().meta.epoch===epoch)throw new Error('Stage epoch did not change');
            const before=JSON.stringify(peakPdEngine.captureComponents());
            let rejected=false;try{peakPdEngine.restorePlayerState(old);}catch{rejected=true;}
            if(!rejected||before!==JSON.stringify(peakPdEngine.captureComponents()))throw new Error('Old creation checkpoint crossed a stage boundary');
        },authority);
        assert.deepEqual(errors,[]);
        console.log(control?'Missing grenade control diverged.':'Missing grenade creation, future spawn identities and 200-tick replay passed.');
    }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
