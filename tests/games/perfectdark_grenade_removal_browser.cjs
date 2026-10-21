/* Extra airborne-grenade removal. Isolated --perfectdark fixture. */
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
                // Only the recipient throws: create real disagreement using input,
                // without directly editing memory or using a native spawn helper.
                smokeStep({buttons:instance===1?1:0});
                for(let tick=0;tick<49;tick++)smokeStep({});
                const state=peakPdEngine.capturePlayerState({grenadeRemovals:true});
                return {tick:state.tick,grenades:state.grenades.length,source:state.smoke.sources,slot:smokeSlot};
            },instance);
            console.log('Airborne grenade fixture:',setup);
        }
        const capture=page=>page.evaluate(()=>peakPdEngine.capturePlayerState({grenadeRemovals:true}));
        const authority=await capture(pages[0]), recipient=await capture(pages[1]);
        assert.equal(authority.schema,'pd-player-grenades-v2');
        assert.equal(authority.grenades.length,0);assert.equal(recipient.grenades.length,1);
        assert.equal(authority.tick,recipient.tick);
        const removed=recipient.grenades[0].entity;
        assert.ok(recipient.smoke.sources.includes(removed),'Recipient must have native linked smoke');
        await pages[1].evaluate(({authority,recipient,removed})=>{
            const read=()=>JSON.stringify({state:peakPdEngine.capturePlayerState({grenadeRemovals:true}),components:peakPdEngine.captureComponents()});
            const before=read();
            for(const fault of ['legacy','dangling-source','retained-order','unrelated-order','late-player','epoch','missing-authority']) {
                const bad=structuredClone(authority);
                if(fault==='legacy')bad.schema='pd-player-grenades-v1';
                if(fault==='dangling-source'){
                    bad.smoke=structuredClone(recipient.smoke);
                    bad.smoke.order=bad.smoke.order.filter(id=>id!==removed);
                }
                if(fault==='retained-order')bad.smoke.order.push(removed);
                if(fault==='unrelated-order')bad.smoke.order=bad.smoke.order.slice(1);
                if(fault==='late-player')bad.players.at(-1).movement[0]=1e20;
                if(fault==='epoch')bad.epoch++;
                if(fault==='missing-authority')bad.grenades=[{...recipient.grenades[0],entity:0xfffffffe}];
                let rejected=false;try{peakPdEngine.restorePlayerState(bad);}catch{rejected=true;}
                if(!rejected||read()!==before)throw new Error('Invalid removal mutated the world: '+fault);
            }
        },{authority,recipient,removed});
        if(!control){
            await pages[1].evaluate(snapshot=>{
                peakPdEngine.restorePlayerState(snapshot);
                const once=JSON.stringify(peakPdEngine.captureComponents());
                peakPdEngine.restorePlayerState(snapshot);
                if(once!==JSON.stringify(peakPdEngine.captureComponents()))throw new Error('Removal is not idempotent');
                if(peakPdEngine.drainEvents().length)throw new Error('Removal emitted gameplay events');
            },authority);
            assert.deepEqual(await capture(pages[1]),authority);
        }
        const traces=[];
        for(const page of pages)traces.push(await page.evaluate(()=>{
            const trace=[];
            for(let i=0;i<200;i++){
                const events=smokeStep({});
                const c=peakPdEngine.captureComponents(), grenadeIds=Object.keys(c).filter(k=>k.startsWith('weapon:')&&c[k].weapon===30).map(k=>k.split(':')[2]);
                trace.push({projectiles:Object.fromEntries(Object.entries(c).filter(([key])=>key.startsWith('projectile:')||key.startsWith('weapon:')||(key.startsWith('prop:')||key.startsWith('object:'))&&grenadeIds.includes(key.split(':')[2]))),smoke:peakPdEngine.captureSmokeState(),
                    random:Array.from({length:4},(_,j)=>Module._peakPdRandomWord(j)),
                    events:events.map(({type,tick,data})=>({type,tick,data}))});
            }
            return trace;
        }));
        require('node:fs').writeFileSync('.tmp/perfectdark/grenade-removal'+(control?'-control':'')+'.json',JSON.stringify(traces));
        assert.ok(!traces[0].some(t=>t.events.some(e=>e.type==='explosion')),'Authority never threw a grenade');
        if(control)assert.ok(traces[1].some(t=>t.events.some(e=>e.type==='explosion')),'Uncorrected extra grenade must explode');
        else assert.deepEqual(traces[0],traces[1]);
        assert.deepEqual(errors,[]);
        console.log(control?'Unremoved extra grenade produced a native explosion.':'Extra grenade removal, atomic validation and 200-tick replay passed.');
    }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
