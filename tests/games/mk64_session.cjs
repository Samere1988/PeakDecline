/* Focused MK64 lockstep recovery tests; no browser or production server required. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const createCore = require(path.resolve(__dirname, '../../instance/netplay/build/netplay.js'));
const source = name => fs.readFileSync(path.resolve(__dirname, '../../static/js/' + name), 'utf8');

function context() {
    const elements = new Map();
    const element = id => {
        if (!elements.has(id)) elements.set(id, {id, dataset:{buildUrl:'/mk64.js',romUrl:'/rom'},
            hidden:false, style:{setProperty(){}},classList:{toggle(){}},listeners:new Map(),
            addEventListener(event,handler){this.listeners.set(event,handler)},setAttribute(){},focus(){},replaceChildren(){},querySelectorAll(){return[]}});
        return elements.get(id);
    };
    const sandbox = {console:{debug(){},warn(){},error(){}},document:{getElementById:element,addEventListener(){}},
        GameFullscreen:{create(){}},RetroControllers:{create(){return{availablePads(){return[]},cancel(){},read(){return{buttons:0,x:0,y:0}}}}},
        localStorage:{getItem(){return null}},screen:{width:1280,height:720},performance,URL,URLSearchParams,
        setTimeout, clearTimeout, setInterval(){return 1},clearInterval(){},location:{href:'http://fixture.test'},
        fetch:async()=>({ok:true,arrayBuffer:async()=>new ArrayBuffer(0xc00000)}),
        PeakSaves:{fs:async()=>({stop:async()=>{}})},addEventListener(){}};
    sandbox.window=sandbox; vm.createContext(sandbox);
    vm.runInContext(source('netplay/session.js'),sandbox);
    return {sandbox,element};
}
const pad = frame => ({buttons:frame&65535,x:frame%81,y:-(frame%81)});
const packet = frame => ({epoch:2,frame,pads:[pad(frame),pad(frame+1)]});
async function session({spectator=false}={}) {
    const {sandbox}=context(), events=[],failures=[];
    const game={id:'mk64',tickRate:30,inputSchema:'n64-pad-v1'};
    const value=new sandbox.PeakNet.Session({socket:{emit:(event,data)=>events.push({event,data})},
        core:await createCore(),game,epoch:2,players:2,spectator,onFailure:message=>failures.push(message)});
    value.bind({deferLoaded:true,sampleInput:()=>pad(17),hashForFrame:()=>123});
    return {value,events,failures};
}
(async()=>{
    {
        const {value,events}=await session({spectator:true});
        assert.equal(events.length,0,'binding must not announce loaded before native initialization');
        assert.equal(value.frameReady(1),0);
        assert.equal(events.filter(e=>e.event==='loaded').length,1);
        value.start();
        for(let frame=1;frame<=120;frame++)value.receive(packet(frame));
        assert.equal(value.failed,false,'a briefly delayed spectator keeps confirmed history');
        assert.equal(value.catchingUp(),true);
        for(let frame=1;frame<=120;frame++){
            assert.equal(value.frameReady(frame),1);
            assert.equal(JSON.stringify(value.getFrame(frame)),JSON.stringify(packet(frame).pads));
        }
        assert.equal(value.catchingUp(),false);
        assert.equal(value.frames.size,1);
        value.receive(packet(1));
        assert.equal(value.failed,false,'old retained rows are harmless');
        value.receive(packet(1320));
        assert.equal(value.failed,true,'spectator history has a finite memory bound');
    }
    {
        const {value,events}=await session();
        value.latency(1);value.start();value.frameReady(1);
        value.receive(packet(1));assert.equal(value.frameReady(1),1);
        assert.equal(value.frameReady(2),0);
        value.suspendTransport();const before=events.length;
        assert.equal(value.frameReady(2),0);assert.equal(events.length,before);
        value.resumeTransport({epoch:2,completed:2,paused:true,frames:[packet(2)]});
        const resent=events.slice(before).filter(e=>e.event==='input');
        assert.deepEqual(resent.map(e=>e.data.frame),[3],'only unconfirmed inputs are resent');
        assert.equal(value.frameReady(2),0,'another disconnected racer keeps the barrier paused');
        value.resumeTransport({epoch:2,paused:false});
        assert.equal(value.frameReady(2),1);
        value.suspendTransport();value.resumeTransport({epoch:2,completed:4,frames:[packet(4)]});
        assert.equal(value.failed,true,'a replay hole cannot silently advance the simulation');
    }
    {
        const {value}=await session();
        value.latency(1);assert.equal(value.lead,1,'warm lobby measurement avoids four initial delayed frames');
        value.latency(100);const high=value.lead;assert.ok(high>=3);
        value.latency(1);assert.equal(value.lead,high,'a single low sample does not oscillate the delay');
        for(let i=0;i<16;i++)value.latency(1);
        assert.equal(value.lead,1);value.latency(NaN);assert.equal(value.lead,1);
    }
    {
        const {sandbox,element}=context(),events=[];
        const value=new sandbox.PeakNet.Session({socket:{emit:(event,data)=>events.push({event,data})},
            core:await createCore(),game:{id:'mk64',tickRate:30},epoch:1,players:2,spectator:false,onFailure(){}});
        sandbox.createMK64=async()=>({FS:{writeFile(){}},callMain(){throw new Error('Native initialization failed')}});
        vm.runInContext(source('netplay/mk64_adapter.js'),sandbox);
        vm.runInContext(source('mario_kart_64.js'),sandbox);
        await assert.rejects(sandbox.PeakNet.adapters.get('mk64').launch({session:value,slot:0,players:2,canRestart:true}),/Native initialization failed/);
        assert.equal(value.failed,true);
        assert.equal(events.filter(e=>e.event==='loaded').length,0);
        assert.equal(events.filter(e=>e.event==='failed').length,1);
        assert.match(element('mk64-runtime-status').textContent,/stopped/);
    }
    {
        const {sandbox}=context();let completedStop=false,created=0,mainCalls=0;
        sandbox.createMK64=async()=>{
            created++;
            if(created===2)assert.equal(completedStop,true,'replacement module waits for old native loop to unwind');
            let stopped=false;
            return {FS:{writeFile(){}},callMain(){mainCalls++},_web_stop(){setTimeout(()=>{stopped=true;completedStop=true},15)},_web_is_stopped(){return stopped}};
        };
        vm.runInContext(source('mario_kart_64.js'),sandbox);
        const online={slot:0,players:2,network:{bind(){}},canRestart:true};
        await sandbox.mk64StartOnline(online);await sandbox.mk64RestartOnline(online);
        assert.equal(created,2);assert.equal(mainCalls,2);
        await sandbox.mk64StopOnline();
    }
    {
        const {sandbox}=context();let created=0,mainCalls=0;
        sandbox.createMK64=async()=>{
            created++;let stopped=false;
            return {FS:{writeFile(){}},callMain(){mainCalls++},_web_stop(){setTimeout(()=>{stopped=true},15)},_web_is_stopped(){return stopped}};
        };
        vm.runInContext(source('mario_kart_64.js'),sandbox);
        const online={slot:0,players:2,network:{bind(){}},canRestart:true};
        await sandbox.mk64StartOnline(online);
        const restarting=sandbox.mk64RestartOnline(online);
        await Promise.all([restarting,sandbox.mk64StopOnline()]);
        assert.equal(created,1,'a cancelled restart cannot resurrect a disposed session');
        assert.equal(mainCalls,1);
    }
    {
        const {sandbox}=context();let oldOptions,resolveOld,created=0,failures=0;
        const module=()=>({FS:{writeFile(){}},callMain(){},_web_stop(){}});
        sandbox.createMK64=options=>{
            if(++created===1){oldOptions=options;return new Promise(resolve=>{resolveOld=resolve});}
            return Promise.resolve(module());
        };
        vm.runInContext(source('mario_kart_64.js'),sandbox);
        const online={slot:0,players:2,network:{bind(){},fail(){failures++}},canRestart:true};
        const oldLaunch=sandbox.mk64StartOnline(online);
        await sandbox.mk64StopOnline();
        await sandbox.mk64StartOnline(online);
        oldOptions.onAbort(new Error('Old initialization was cancelled'));
        resolveOld(module());await oldLaunch;
        assert.equal(failures,0,'an obsolete initialization callback cannot fail the current race');
        await sandbox.mk64StopOnline();
    }
    {
        const {sandbox,element}=context();let acknowledge,leaveCalls=0,timeoutMs;
        element('retro-catalog').textContent=JSON.stringify([{id:'mk64',available:true}]);
        element('retro-game-select').value='mk64';
        const socket={on(){},timeout(ms){timeoutMs=ms;return this},emit(event,callback){
            if(event==='leave'){leaveCalls++;acknowledge=callback;}
        }};
        sandbox.io=()=>socket;sandbox.location.pathname='/games/retro';
        vm.runInContext(source('netplay/lobby.js'),sandbox);
        const click=element('retro-return').listeners.get('click');
        await Promise.all([click(),click()]);
        assert.equal(leaveCalls,1,'double clicks do not submit duplicate departures');
        assert.equal(sandbox.location.href,'http://fixture.test','navigation must wait until departure is delivered');
        assert.equal(timeoutMs,2000,'an unresponsive server has a bounded navigation fallback');
        acknowledge();assert.equal(sandbox.location.href,'/games/retro');
    }
    console.log('MK64 session: initialization failure, deferred loading, spectator catch-up, bounded history, retained reconnect, stable delay and cooperative restart passed.');
})().catch(error=>{console.error(error);process.exitCode=1});
