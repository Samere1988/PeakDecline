const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const nodes=new Map(),listeners={},timers=[],mediaListeners={};
function node(id){if(!nodes.has(id))nodes.set(id,{value:'native',textContent:'',style:{},options:['auto','native','720','480'].map(value=>({value})),classList:{toggle(){}},setAttribute(){},contains(){return false;},addEventListener:(e,fn)=>listeners[id+e]=fn});return nodes.get(id);}
const player={levels:[{height:480},{height:720},{height:1080}],currentLevel:2,nextLevel:2,on:(e,fn)=>mediaListeners[e]=fn};
const c=vm.createContext({console,hls:player,video:{paused:false},Hls:{Events:{LEVEL_SWITCHED:'switched'}},
    setTimeout:fn=>{timers.push(fn);return timers.length;},clearTimeout(){},
    document:{getElementById:node,addEventListener(){}},window:{addEventListener:(e,fn)=>listeners[e]=fn},
    showPlayerStatus(){throw Error('Quality metadata must not replace playback status');}});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../../static/js/live_quality.js'),'utf8'),c);
const update=detail=>listeners['live-quality-levels']({detail});
const select=value=>{node('live-quality-select').value=value;listeners['live-quality-selectchange']();};
update({levels:player.levels,supported:true});select('native');assert.equal(node('live-quality-note').textContent,'Using native resolution.');
select('auto');assert.equal(node('live-quality-note').textContent,'Automatic quality enabled.');
player.currentLevel=2;update({levels:player.levels,supported:true});
assert.equal(player.currentLevel,-1);assert.equal(node('live-quality-status').textContent,'Quality: Auto (adaptive)');
c.video.paused=true;select('480');assert.match(node('live-quality-note').textContent,/Applies when playback resumes/);
c.video.paused=false;mediaListeners.switched();assert.equal(node('live-quality-note').textContent,'Using 480p.');
// Loading selection has not reached the playing level yet.
Object.defineProperty(player,'currentLevel',{get:()=>0,set(){},configurable:true});
select('720');assert.equal(node('live-quality-note').textContent,'Switching to 720p…');
timers.at(-1)();assert.match(node('live-quality-note').textContent,/taking longer/);
const staleTimer=timers.at(-1);
c.hls={...player,levels:player.levels,currentLevel:2,on(){}};
update({levels:player.levels,supported:true});const nextNote=node('live-quality-note').textContent;
staleTimer();assert.equal(node('live-quality-note').textContent,nextNote);
update({levels:[],supported:false});assert.equal(node('live-quality-select').value,'auto');
assert.match(node('live-quality-note').textContent,/used by this browser/);
assert.ok(node('live-quality-select').options.filter(o=>o.value!=='auto').every(o=>o.disabled));
console.log('PASS quality success, pending selection, paused selection, Auto, delayed change, old-player timer and native-browser feedback');
