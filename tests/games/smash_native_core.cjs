/* The native Smash adapter must wait for remote controllers and preserve Start.
 * Full scene transitions are covered separately by smash_netplay.cjs. */
const assert = require('node:assert/strict');
const create = require('../../ports/smash64/rollback_adapter.js');
const {RollbackEngine} = require('../../static/js/netplay/rollback.js');
const neutral = {buttons:0,x:0,y:0};
let queued, frame=0;
const moduleFixture = {
    peakNativeFlow:true,
    _peak_rb_begin(){}, _peak_rb_end(){},
    _peak_rb_native_flow:()=>1,
    _peak_rb_save:n=>n,
    _peak_rb_restore(){throw Error('Native scenes must never be restored');},
    _peak_rb_can_predict:()=>0,
    _peak_rb_queue(...args){queued=args;},
    _peak_rb_step(){throw Error('Native scenes must never be replayed');},
    _peak_rb_hash:()=>frame,
    _peak_rb_finished:()=>1,
    _peak_rb_in_battle:()=>1
};
const adapter=create(moduleFixture,{sampleInput:()=>neutral});
assert.equal(adapter.confirmedInputMode(),false,'Older builds without phase exports keep the base delay');
let scene=16,status=0;
const phaseAdapter=create({...moduleFixture,_peak_rb_scene:()=>scene,_peak_rb_status:()=>status},{sampleInput:()=>neutral});
assert.equal(phaseAdapter.confirmedInputMode(),true);
scene=22;
for(status of [0,2,3,5,6,7])assert.equal(phaseAdapter.confirmedInputMode(),true);
status=1;assert.equal(phaseAdapter.confirmedInputMode(),false,'Go keeps combat delay even if prediction is temporarily unsafe');
const engine=new RollbackEngine({players:2,adapter});
engine.receive(0,1,{buttons:0x1000,x:-80,y:80});
assert.equal(engine.beginAdvance(),false,'Wait for the other controller before touching native state');
engine.receive(1,1,neutral);
const next=engine.beginAdvance();
adapter.queueFrame(next);
assert.equal(queued[1]&0xffff,0x1000,'Start must reach the native pause/results handlers');
assert.equal((queued[1]>>>16)&255,176);
assert.equal(queued[1]>>>24,80);
frame=1;
engine.completeAdvance();
assert.equal(adapter.isFinished(),false,'Native Game Set is not the end of the network session');
assert.equal(engine.snapshots.size,0,'Do not retain native scene handles across confirmed frames');
assert.equal(engine.rollbacks,0);
assert.throws(()=>adapter.simulateFrame([neutral,neutral],{frame:1,replaying:true}),/cannot be replayed/);
engine.dispose();
assert.throws(()=>create({...moduleFixture,_peak_rb_native_flow:undefined},{sampleInput:()=>neutral}),/updated game build/);
console.log('Smash native flow: confirmed input, Start, persistent session and build compatibility passed.');
// Hybrid mode keeps native menus, forwards Start, and allows battle replay.
let hybridContext, hybridPacked;
const hybridModule={...moduleFixture,peakHybridRollback:true,
 _peak_rb_hybrid:()=>1,_peak_rb_context:n=>{hybridContext=n;},
 _peak_rb_barrier:()=>1,_peak_rb_restore:()=>1,
 _peak_rb_can_predict:()=>1,
 _peak_rb_step:(n,...values)=>{hybridPacked=values;}
};
const hybrid=create(hybridModule,{sampleInput:()=>neutral});
hybrid.saveState({confirmed:12});assert.equal(hybridContext,12);
assert.equal(hybrid.skipConfirmedSnapshots,false,'Older hybrid builds still need capture to advance retirement clocks');
const optimized=create({...hybridModule,_peak_rb_timing:()=>0,_peak_rb_catchup_debt:()=>0},{sampleInput:()=>neutral});
assert.equal(optimized.skipConfirmedSnapshots,true,'Compatible native clocks allow confirmed capture skipping');
hybrid.prepareFrame({confirmed:15});assert.equal(hybridContext,15,'Confirmed frames still publish barrier context without a snapshot');
assert.equal(hybrid.nativeTimings(),null,'Older builds may omit optional performance diagnostics');
assert.equal(hybrid.canPredict({confirmed:12}),true);
hybrid.simulateFrame([{buttons:0x1000,x:0,y:0}],{frame:13,replaying:true});
assert.equal(hybridPacked[0]&0xffff,0x1000,'Replay must detect Start and request a confirmation barrier');
assert.equal(hybrid.needsConfirmation(),true);
assert.equal(hybrid.isFinished(),false);
assert.throws(()=>create({...hybridModule,_peak_rb_hybrid:undefined},{sampleInput:()=>neutral}),/updated game build/);
console.log('Smash hybrid adapter: feature handshake, confirmation context, Start replay and persistent session passed.');
