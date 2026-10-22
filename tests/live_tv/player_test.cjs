const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const source=fs.readFileSync(path.join(__dirname,'../../static/js/tv_player.js'),'utf8');
let passed=0;
function test(name,fn,userAgent='Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36'){
 let now=10000;
 const v={currentTime:50,paused:false,seeking:false,readyState:4,playbackRate:1,
  seekable:{length:1,start:()=>0,end:()=>100},buffered:{length:1,start:()=>0,end:()=>100},addEventListener(){},play:()=>Promise.resolve(),pause(){this.paused=true;}};
 const c=vm.createContext({console,navigator:{userAgent},performance:{now:()=>now},setTimeout,clearTimeout,setInterval,clearInterval,
  AbortController,io:()=>({on(){},emit(){}}),document:{getElementById:id=>id==='video-player'?v:{},addEventListener(){}}});
 vm.runInContext(source,c);
 vm.runInContext(`lastClockPoll=10000;clockSample={fresh:true,received:10000,rtt:0,max_extrapolation:3,target_pdt:1050,edge_pdt:1090,session:'seg_session'};
 hls={latestLevelDetails:{fragments:[{programDateTime:1000000,start:0,relurl:'seg_session_001.ts'}]}};needsAlignment=false;`,c);
 const step=(ms,drift)=>{now+=ms;vm.runInContext(`lastClockPoll=${now};clockSample.received=${now};clockSample.target_pdt=${1000+v.currentTime+drift};enforceLiveSync()`,c);};
 fn(c,v,step);passed++;console.log('PASS '+name);
}
test('alternating clock jitter never seeks', (c,v,step)=>{
 for(let i=0;i<240;i++){step(250,i%2?1.2:-1.2);assert.equal(v.currentTime,50);assert.ok([.98,1.02].includes(v.playbackRate));}
});
test('large persistent lead aligns backward after three seconds', (c,v,step)=>{
 step(0,-8);step(2999,-8);assert.equal(v.currentTime,50);
 step(1,-8);assert.equal(v.currentTime,42);assert.equal(v.playbackRate,1);
 step(1000,-8);assert.equal(v.currentTime,42);
});
test('substantial lag must persist for three seconds and correction has a fifteen second cooldown', (c,v,step)=>{
 step(0,6);step(2999,6);assert.equal(v.currentTime,50);
 step(1,6);assert.equal(v.currentTime,56);
 step(1000,6);step(13000,6);assert.equal(v.currentTime,56);
 step(1000,6);assert.equal(v.currentTime,62);
});
test('transient lag resets persistence window', (c,v,step)=>{
 step(0,6);step(2000,6);step(1000,.2);step(1000,6);step(2000,6);assert.equal(v.currentTime,50);
});
test('unbuffered targets never cause automatic seeks', (c,v,step)=>{
 v.buffered.length=0;for(let i=0;i<40;i++)step(1000,10);assert.equal(v.currentTime,50);
});
test('buffering resets automatic correction window', (c,v,step)=>{
 step(0,6);v.readyState=2;step(4000,6);assert.equal(v.currentTime,50);assert.equal(v.playbackRate,1);
 v.readyState=4;step(1000,6);assert.equal(v.currentTime,50);
});
test('paused viewers stay paused without seeks', (c,v)=>{
 v.paused=true;v.currentTime=30;vm.runInContext('enforceLiveSync()',c);assert.equal(v.currentTime,30);assert.equal(v.playbackRate,1);
});
test('small drift uses gentle rate correction and deadband', (c,v,step)=>{
 step(0,.5);assert.equal(v.playbackRate,1.02);step(0,-.5);assert.equal(v.playbackRate,.98);
 step(0,.2);assert.equal(v.playbackRate,1);assert.equal(v.currentTime,50);
});
test('stale clock does not cause a seek', (c,v)=>{
 v.currentTime=30;vm.runInContext('clockSample.received=0;enforceLiveSync()',c);assert.equal(v.currentTime,30);assert.equal(v.playbackRate,1);
});
test('replacement stream never uses prior timestamp mapping', (c,v)=>{
 v.currentTime=30;vm.runInContext("clockSample.session='new-session';enforceLiveSync()",c);assert.equal(v.currentTime,30);
});
test('explicit alignment still corrects both directions', (c,v)=>{
 for(const time of [30,60]){v.currentTime=time;vm.runInContext('needsAlignment=true;lastCorrection=-Infinity;enforceLiveSync()',c);assert.equal(v.currentTime,50);}
});
test('late joins map different media origins to the same program', (c,v)=>{
 vm.runInContext('needsAlignment=true;hls.latestLevelDetails.fragments[0].start=20;enforceLiveSync()',c);assert.equal(v.currentTime,70);
});
test('startup waits for buffered media at the shared target', (c,v)=>{
 v.buffered.length=0;v.paused=true;v.currentTime=30;vm.runInContext('startupPending=true;enforceLiveSync()',c);assert.equal(v.currentTime,50);assert.equal(v.paused,true);
 v.buffered.length=1;vm.runInContext('enforceLiveSync()',c);assert.equal(v.currentTime,50);
});
const firefoxUA='Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:142.0) Gecko/20100101 Firefox/142.0';
test('Firefox stays at normal speed through repeated positive and negative drift', (c,v,step)=>{
 for(let i=0;i<14400;i++){
  step(250,[.1,.5,1.2,-.5,-1.2,-8][i%6]);
  assert.equal(v.playbackRate,1);assert.equal(v.currentTime,50);
 }
},firefoxUA);
test('Firefox retains sustained buffered catch-up and cooldown', (c,v,step)=>{
 step(0,6);step(2999,6);assert.equal(v.currentTime,50);assert.equal(v.playbackRate,1);
 step(1,6);assert.equal(v.currentTime,56);
 step(1000,6);step(13000,6);assert.equal(v.currentTime,56);
 step(1000,6);assert.equal(v.currentTime,62);assert.equal(v.playbackRate,1);
},firefoxUA);
for (const drift of [-8, 3, -1.2]) test(`Firefox corrects sustained ${drift}s drift at 1x`, (c,v,step)=>{
 step(0,drift);step(2999,drift);assert.equal(v.currentTime,50);
 step(1,drift);assert.ok(Math.abs(v.currentTime-(50+drift)) < 1e-9);assert.equal(v.playbackRate,1);
},firefoxUA);
test('opposite drift directions cannot share a persistence timer',(c,v,step)=>{
 step(0,5);step(2000,-5);step(2000,-5);assert.equal(v.currentTime,50);
 step(1000,-5);assert.equal(v.currentTime,45);
});
test('Firefox retains explicit alignment, local pause, and stale-clock behavior', (c,v,step)=>{
 for(const time of [30,60]){v.currentTime=time;vm.runInContext('needsAlignment=true;lastCorrection=-Infinity;enforceLiveSync()',c);assert.equal(v.currentTime,50);}
 v.paused=true;step(4000,10);assert.equal(v.currentTime,50);assert.equal(v.playbackRate,1);
 v.paused=false;vm.runInContext('clockSample.received=0;enforceLiveSync()',c);assert.equal(v.currentTime,50);assert.equal(v.playbackRate,1);
},firefoxUA);
for(const [browser,ua] of [
 ['Edge','Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0'],
 ['Safari','Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15'],
 ['Firefox iOS','Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 FxiOS/142.0 Mobile/15E148 Safari/605.1.15']
])test(`${browser} retains existing rate correction`,(c,v,step)=>{
 step(0,.5);assert.equal(v.playbackRate,1.02);step(0,-.5);assert.equal(v.playbackRate,.98);
},ua);
console.log(`${passed} player checks passed`);
