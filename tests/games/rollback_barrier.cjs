/* Unsafe native scene side effects must run once, with confirmed input, in
 * the original coroutine—even when late inputs discover them during replay. */
const assert = require('node:assert/strict');
const {RollbackEngine}=require('../../static/js/netplay/rollback.js');
const pad=buttons=>({buttons,x:0,y:0});
function fixture(){
 let state=0,confirmed=0,blocked=false,commits=0;
 const adapter={
  saveState(context){confirmed=context.confirmed;blocked=false;return state;},
  restoreState(saved){state=saved;blocked=false;},
  simulateFrame(pads,{frame,replaying}){
   if(pads.some(p=>p.buttons===1)){
    if(replaying||frame>confirmed){blocked=true;state+=1000;return;}
    ++commits;
   }
   ++state;
  },
  needsConfirmation:()=>blocked,hashState:()=>state
 };
 const engine=new RollbackEngine({players:2,adapter,maxPrediction:6});
 return {engine,adapter,state:()=>state,commits:()=>commits};
}
{
 const f=fixture(),e=f.engine;
 e.receive(0,1,pad(1));
 assert.equal(e.advance(),false);
 assert.equal(e.frame,1);assert.equal(f.state(),0);assert.equal(f.commits(),0);
 assert.equal(e.beginAdvance(),false);
 e.receive(1,1,pad(0));
 assert.equal(e.advance(),true);assert.equal(f.commits(),1);assert.equal(f.state(),1);
}
{
 const f=fixture(),e=f.engine;
 for(let n=1;n<=4;n++){e.receive(0,n,pad(0));assert.ok(e.advance());}
 e.receive(1,1,pad(0));e.receive(1,2,pad(1));
 const pending=e.beginAdvance();
 assert.equal(pending.frame,2,'Replay must discard all frames after the transition');
 assert.equal(f.state(),1);assert.equal(f.commits(),0);
 assert.deepEqual([...e.hashes.keys()],[1]);
 f.adapter.simulateFrame(pending.pads,{frame:pending.frame,replaying:false});
 assert.ok(e.completeAdvance());assert.equal(f.commits(),1);assert.equal(f.state(),2);
}
{
 const f=fixture(),e=f.engine;
 e.receive(0,1,pad(1));const pending=e.beginAdvance();
 f.adapter.simulateFrame(pending.pads,{frame:1,replaying:false});
 e.receive(1,1,pad(2)); // Arrives while the native coroutine is pending.
 assert.equal(e.completeAdvance(),false);assert.equal(e.dirty,null);
 assert.ok(e.advance());assert.equal(f.commits(),1);
}
console.log('Rollback confirmation barriers: speculative transitions, replay truncation, pending input race passed.');
