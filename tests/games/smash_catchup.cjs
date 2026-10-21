/* Compile the actual coroutine-loop policy with controlled bridge/clock hooks.
 * The real WASM integration suite separately exercises frame/state hashes. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const source = fs.readFileSync(path.join(__dirname, '../../ports/smash64/rollback_exports.c'), 'utf8');
const marker = 'static sb32 peak_rb_catchup_safe(void)';
assert.ok(source.includes(marker));
const policy = source.slice(source.indexOf(marker))
    .replace('EM_ASM_INT({ return Module.peakAdvance() ? 1 : 0; })', 'bridge_begin()')
    .replace('EM_ASM_INT({ return Module.peakComplete() ? 1 : 0; })', 'bridge_complete()');
const step = source.slice(source.indexOf('EMSCRIPTEN_KEEPALIVE void peak_rb_step('),
    source.indexOf('EMSCRIPTEN_KEEPALIVE int peak_rb_finished('));
const harness = `
#include <assert.h>
#include <stdint.h>
typedef uint32_t u32;
typedef uint64_t u64;
typedef int sb32;
typedef int8_t s8;
#define EMSCRIPTEN_KEEPALIVE
#define FALSE 0
#define SYNETROLLBACK_WINDOW 6
#define nSCBattleGameStatusGo 1
#define nSCBattleGameStatusEnd 2
#define nSYNetInputSourceSaved 0
static int sPeakCatchupEnabled = 1, sPeakHybrid = 1, active = 1;
static struct { int game_status; } battle = {1}, *gSCManagerBattleState = &battle;
static u32 sPeakCatchupDebt, sPeakCatchupCount, now;
static int available, completed = 1, steps, begin_calls, step_cost, stop_after;
static u32 sSYNetRollbackForwardFrame, sPeakExecuting, sPeakConfirmed, sPeakPredictedCount, sPeakFrame;
static sb32 sSYNetRollbackResimulating, sPeakBarrier;
static u32 expected_retirement_frame, last_cleanup_frame;
typedef struct { int unused; } SYNetInputFrame;
static void syNetInputMakeFrame(SYNetInputFrame *p,u32 f,u32 b,s8 x,s8 y,int s,int v) { (void)p;(void)f;(void)b;(void)x;(void)y;(void)s;(void)v; }
static void syNetInputPublishFrame(int i,SYNetInputFrame *p) { (void)i;(void)p; }
static void syNetInputPublishMainController(void) {}
static void syNetInputSetTick(u32 frame) { (void)frame; }
static void ifCommonBattleUpdateInterfaceAll(void) { assert(sSYNetRollbackForwardFrame==expected_retirement_frame); }
static void syNetRollbackPostFrame(u32 frame) { last_cleanup_frame=frame; }
static void peak_rb_record_timing(u32 metric,u32 elapsed) { (void)metric;(void)elapsed; }
static sb32 peak_rb_owns_battle(void) { return active; }
static u64 port_netplay_monotonic_us(void) { return now; }
static u32 syNetRollbackElapsedUs(u64 begin) { return now - begin; }
static int bridge_begin(void) { ++begin_calls; return available; }
static int bridge_complete(void) { return completed; }
static void peak_rb_forward(void) {
    ++steps; now += step_cost;
    if (stop_after && steps >= stop_after) battle.game_status = 0;
}
${step}
${policy}
static void reset(void) {
    sPeakCatchupDebt=sPeakCatchupCount=now=steps=begin_calls=step_cost=stop_after=0;
    sPeakCatchupEnabled=available=completed=active=sPeakHybrid=battle.game_status=1;
}
int main(void) {
    // No snapshot capture precedes these fully confirmed forward updates.
    expected_retirement_frame=100; peak_rb_step(100,0,0,0,0,0);
    assert(last_cleanup_frame==100);
    expected_retirement_frame=101; peak_rb_step(101,0,0,0,0,0);
    assert(last_cleanup_frame==101);
    expected_retirement_frame=99; peak_rb_step(99,0,0,0,0,1);
    assert(last_cleanup_frame==101); // Replay cannot physically collect objects.
    reset(); peak_rb_advance_battle(); assert(steps==1 && sPeakCatchupDebt==0);
    reset(); available=0;
    for (int i=0;i<100;i++) peak_rb_advance_battle();
    assert(steps==0 && sPeakCatchupDebt==6);
    available=1; peak_rb_advance_battle();
    assert(steps==3 && sPeakCatchupDebt==4 && sPeakCatchupCount==2);
    peak_rb_advance_battle(); peak_rb_advance_battle();
    assert(steps==9 && sPeakCatchupDebt==0 && sPeakCatchupCount==6);
    peak_rb_advance_battle(); assert(steps==10);
    reset(); sPeakCatchupDebt=6; step_cost=4000; peak_rb_advance_battle();
    assert(steps==1 && sPeakCatchupDebt==6);
    reset(); sPeakCatchupDebt=6; completed=0; peak_rb_advance_battle();
    assert(steps==1 && sPeakCatchupDebt==0 && sPeakCatchupCount==0);
    reset(); sPeakCatchupDebt=6; stop_after=1; peak_rb_advance_battle();
    assert(steps==1 && sPeakCatchupDebt==0);
    reset(); available=0; battle.game_status=0; peak_rb_advance_battle();
    assert(steps==0 && sPeakCatchupDebt==0);
    reset(); available=0; sPeakHybrid=0; peak_rb_advance_battle();
    assert(steps==0 && sPeakCatchupDebt==0);
    reset(); available=0; sPeakCatchupEnabled=0; peak_rb_advance_battle();
    assert(steps==0 && sPeakCatchupDebt==0);
    reset(); sPeakCatchupDebt=6; available=0; peak_rb_advance_battle();
    assert(begin_calls==1 && sPeakCatchupDebt==6);
    return 0;
}
`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smash-catchup-'));
try {
    const emcc = path.join(__dirname, '../../.tmp/emsdk/upstream/emscripten/emcc');
    const wasm = !process.env.CC && fs.existsSync(emcc);
    const file = path.join(dir, 'policy.c'), binary = path.join(dir, wasm ? 'policy.js' : 'policy');
    fs.writeFileSync(file, harness);
    execFileSync(process.env.CC || (wasm ? emcc : 'cc'), ['-std=c99', '-Wall', '-Wextra', '-Werror', file, '-o', binary,
        ...(wasm ? ['-sENVIRONMENT=node', '-sWASM_ASYNC_COMPILATION=0'] : [])]);
    if (wasm) execFileSync(process.execPath, [binary]); else execFileSync(binary);
} finally { fs.rmSync(dir, {recursive:true, force:true}); }
console.log('Smash coroutine catchup: bounded debt, progress, CPU budget and transition stops passed.');
