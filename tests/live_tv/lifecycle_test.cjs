const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const source=fs.readFileSync(path.join(__dirname,'../../static/js/tv_player.js'),'utf8');
const flush=()=>new Promise(setImmediate);
function state(id,revision){return{is_streaming:id!==null,current_channel_id:id,current_channel_name:'Channel '+id,stream_epoch:'test',stream_revision:revision,stream_session:id===null?null:'session-'+revision};}
function fixture(){
 const socketHandlers={},domHandlers={},pending=[],loads=[],nodes=new Map();
 function element(){return{value:'',textContent:'',innerHTML:'',children:[],paused:true,playbackRate:1,
  setAttribute(){},addEventListener(){},appendChild(child){this.children.push(child);},pause(){this.paused=true;},removeAttribute(){},load(){}};}
 const c=vm.createContext({console,loads,performance:{now:()=>100},AbortController,
  setTimeout:()=>1,clearTimeout(){},setInterval(){},clearInterval(){},
  io:()=>({on:(e,f)=>socketHandlers[e]=f,emit(){}}),
  document:{hidden:false,getElementById:id=>{if(!nodes.has(id))nodes.set(id,element());return nodes.get(id);},
   createElement:element,createTextNode:text=>({textContent:text}),addEventListener:(e,f)=>domHandlers[e]=f},
  fetch:url=>new Promise(resolve=>pending.push({url,resolve}))});
 vm.runInContext(source,c);vm.runInContext('initPlayer=()=>loads.push(currentChannelId)',c);
 const respond=(request,data,ok=true)=>request.resolve({ok,json:async()=>data});
 return{c,socketHandlers,domHandlers,pending,loads,nodes,respond};
}
async function main(){let count=0;
 async function test(name,fn){await fn();count++;console.log('PASS '+name);}
 await test('late initial status cannot undo channel broadcast',async()=>{
  const f=fixture();f.domHandlers.DOMContentLoaded();
  f.socketHandlers.channel_changed(state(2,4));f.respond(f.pending.find(p=>p.url==='/api/status'),state(1,2));await flush();assert.deepEqual(f.loads,[2]);
 });
 await test('broadcast and POST response initialize once',async()=>{
  const f=fixture();f.c.data=state(1,2);vm.runInContext('applyLiveState(data)',f.c);f.loads.length=0;
  const done=vm.runInContext('playChannel(2)',f.c);f.c.data=state(2,4);vm.runInContext('applyLiveState(data)',f.c);
  f.respond(f.pending.find(p=>p.url==='/api/play/2'),{state:state(2,4)});await done;assert.deepEqual(f.loads,[2]);
 });
 await test('older POST state cannot undo newer selection',async()=>{
  const f=fixture();f.c.data=state(2,4);vm.runInContext('applyLiveState(data)',f.c);f.c.data=state(1,2);vm.runInContext('applyLiveState(data)',f.c);assert.deepEqual(f.loads,[2]);
 });
 await test('HTTP failure allows retry of the same channel',async()=>{
  const f=fixture();let done=vm.runInContext('playChannel(3)',f.c);f.respond(f.pending[0],{state:state(null,2),error:'Unavailable'},false);await done;
  done=vm.runInContext('playChannel(3)',f.c);assert.equal(f.pending.length,2);f.respond(f.pending[1],{state:state(3,4)});await done;assert.deepEqual(f.loads,[3]);
 });
 await test('search filters cached data without more requests',async()=>{
  const f=fixture();f.domHandlers.DOMContentLoaded();f.respond(f.pending.find(p=>p.url==='/api/channels'),[{id:1,name:'Sports',Favorites:true}]);await flush();
  const n=f.pending.length;for(let i=0;i<10;i++)vm.runInContext('renderChannels()',f.c);assert.equal(f.pending.length,n);
 });
 await test('foregrounding does not corrupt in-flight clock timing',async()=>{
  const f=fixture();vm.runInContext('currentChannelId=1;pollLiveClock()',f.c);f.domHandlers.visibilitychange();
  f.respond(f.pending[0],{channel_id:1,target_pdt:100,edge_pdt:106,max_extrapolation:3,fresh:true});await flush();
  assert.equal(vm.runInContext('clockSample.rtt',f.c),0);
 });
 console.log(`${count} lifecycle checks passed`);
}
main().catch(e=>{console.error(e);process.exitCode=1;});
