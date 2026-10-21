
/* Appended to the adapted Vita snapshot implementation by prepare_rollback.py.
 * Opaque handles are frame numbers in its private ring, never network data.
 * JS owns prediction/replay scheduling. These exports own only Smash state.
 */
static u32 sPeakFrame;
static sb32 sPeakNativeFlow;
static sb32 sPeakHybrid, sPeakBarrier;
static u32 sPeakConfirmed, sPeakExecuting;
static u32 sPeakBarrierCount, sPeakPredictedCount;
// Read-only performance counters: capture, restore, forward step, replay step.
// Each metric stores last/total/max microseconds and its call count. Doubles
// keep long sessions from wrapping the accumulated microseconds at 2^32.
static double sPeakTimings[4][4];
static u32 sPeakCatchupDebt, sPeakCatchupCount;
static sb32 sPeakCatchupEnabled;
static void peak_rb_record_timing(u32 metric, u32 elapsed) {
    double *values = sPeakTimings[metric];
    values[0] = elapsed; values[1] += elapsed;
    if (elapsed > values[2]) values[2] = elapsed;
    ++values[3];
}
EMSCRIPTEN_KEEPALIVE double peak_rb_timing(u32 metric, u32 field) {
    return metric < 4 && field < 4 ? sPeakTimings[metric][field] : 0;
}
EMSCRIPTEN_KEEPALIVE u32 peak_rb_catchup_count(void) { return sPeakCatchupCount; }
EMSCRIPTEN_KEEPALIVE u32 peak_rb_catchup_debt(void) { return sPeakCatchupDebt; }
static sb32 sPeakBattleLoop = TRUE;
static sb32 peak_rb_owns_battle(void) {
    return sPeakActive && (!sPeakNativeFlow || sPeakHybrid) && sPeakBattleLoop && gSCManagerSceneData.scene_curr == nSCKindVSBattle;
}
// Animation tracks are pooled separately from their DObjs. Retaining a DObj
// alone is insufficient: a move can free its old tracks before late input
// restores them, leaving the restored list pointing into the allocator pool.
static struct { AObj *ptr; u32 frame; } sPeakRetiredAObjs[8192];
static u32 sPeakRetiredAObjCount;
static sb32 sPeakCollectingAObjs;
int peak_rb_retire_aobj(AObj *ptr) {
    if (!peak_rb_owns_battle() || sPeakCollectingAObjs) return FALSE;
    for (u32 i = 0; i < sPeakRetiredAObjCount; ++i) {
        if (sPeakRetiredAObjs[i].ptr == ptr) return TRUE;
    }
    if (sPeakRetiredAObjCount == ARRAY_COUNT(sPeakRetiredAObjs)) {
        EM_ASM({ throw new Error('Smash rollback animation retention capacity exceeded.'); });
        return TRUE;
    }
    sPeakRetiredAObjs[sPeakRetiredAObjCount].ptr = ptr;
    sPeakRetiredAObjs[sPeakRetiredAObjCount++].frame = sSYNetRollbackForwardFrame;
    return TRUE;
}
static void peak_rb_reactivate_aobj(AObj *ptr) {
    for (u32 i = 0; i < sPeakRetiredAObjCount; ++i)
        if (sPeakRetiredAObjs[i].ptr == ptr) {
            sPeakRetiredAObjs[i] = sPeakRetiredAObjs[--sPeakRetiredAObjCount];
            return;
        }
}
static void peak_rb_collect_aobjs(u32 frame) {
    sPeakCollectingAObjs = TRUE;
    for (u32 i = 0; i < sPeakRetiredAObjCount;) {
        if (sPeakRetiredAObjs[i].frame + SYNETROLLBACK_WINDOW < frame) {
            gcSetAObjPrevAlloc(sPeakRetiredAObjs[i].ptr);
            sPeakRetiredAObjs[i] = sPeakRetiredAObjs[--sPeakRetiredAObjCount];
        } else ++i;
    }
    sPeakCollectingAObjs = FALSE;
}
static void peak_rb_reset_aobjs(void) { peak_rb_collect_aobjs(UINT32_MAX); }
EMSCRIPTEN_KEEPALIVE int peak_rb_hybrid(void) { return sPeakHybrid; }
EMSCRIPTEN_KEEPALIVE void peak_rb_context(u32 confirmed) { sPeakConfirmed = confirmed; sPeakBarrier = FALSE; }
EMSCRIPTEN_KEEPALIVE int peak_rb_barrier(void) { return sPeakBarrier; }
EMSCRIPTEN_KEEPALIVE u32 peak_rb_barrier_count(void) { return sPeakBarrierCount; }
EMSCRIPTEN_KEEPALIVE u32 peak_rb_predicted_count(void) { return sPeakPredictedCount; }
int peak_rb_defer_transition(void) {
    if (!sPeakHybrid || !peak_rb_owns_battle()) return FALSE;
    if (!sSYNetRollbackResimulating && sPeakExecuting <= sPeakConfirmed) return FALSE;
    sPeakBarrier = TRUE;
    ++sPeakBarrierCount;
    return TRUE;
}
void peak_rb_scene_end(void) {
    if (!sPeakActive) return;
    sPeakBattleLoop = FALSE;
    sPeakCatchupDebt = 0;
    syNetRollbackReset();
}
EMSCRIPTEN_KEEPALIVE int peak_rb_native_flow(void) { return sPeakNativeFlow; }
void peak_rb_mode(int battle) { sPeakBattleLoop = battle; }
EMSCRIPTEN_KEEPALIVE int peak_rb_in_battle(void) { return sPeakBattleLoop; }
EMSCRIPTEN_KEEPALIVE int peak_rb_scene(void) { return gSCManagerSceneData.scene_curr; }
EMSCRIPTEN_KEEPALIVE int peak_rb_status(void) {
    return sPeakBattleLoop && gSCManagerBattleState ? gSCManagerBattleState->game_status : -1;
}
#include <stdlib.h>
#include <malloc.h>
#include <lb/lbreloc.h>
// Read-only diagnostics for native-flow regression and repeated-scene tests.
// Never expose pointers to scene allocations or mutate game state from tests.
EMSCRIPTEN_KEEPALIVE const u32 *peak_native_diagnostics(void) {
    static u32 values[12];
    SCBattleState *battle = sPeakBattleLoop && gSCManagerBattleState ?
        gSCManagerBattleState : &gSCManagerTransferBattleState;
    values[0] = gSCManagerSceneData.scene_curr;
    values[1] = peak_rb_status();
    values[2] = gSCManagerSceneData.is_suddendeath;
    values[3] = battle->game_rules;
    values[4] = battle->stocks;
    values[5] = battle->time_limit;
    values[6] = battle->time_remain;
    values[7] = battle->is_team_battle;
    values[8] = mallinfo().uordblks;
    values[9] = battle->cp_count;
    values[10] = gSCManagerSceneData.is_reset;
    values[11] = battle->gkind;
    return values;
}
// The native animation heap is overwritten on every move. Keep networked
// animation files at stable addresses for this WASM instance's lifetime.
static struct { u32 id; void *data; } sPeakAnimations[1024];
static u32 sPeakAnimationCount;
static size_t sPeakAnimationBytes;
void *peak_rb_animation(u32 id, void *ordinary_heap) {
    if (!peak_rb_owns_battle()) return lbRelocGetForceExternHeapFile(id, ordinary_heap);
    for (u32 i = 0; i < sPeakAnimationCount; ++i)
        if (sPeakAnimations[i].id == id) return sPeakAnimations[i].data;
    size_t size = lbRelocGetAllocSize(&id, 1) + 32;
    if (sPeakAnimationCount >= 1024 || size > 64 * 1024 * 1024 - sPeakAnimationBytes) {
        EM_ASM({ throw new Error('Smash rollback animation cache capacity exceeded.'); });
        return NULL;
    }
    void *data = malloc(size);
    if (!data) { EM_ASM({ throw new Error('Smash rollback animation allocation failed.'); }); return NULL; }
    void *loaded = lbRelocGetForceExternHeapFile(id, data);
    sPeakAnimations[sPeakAnimationCount].id = id;
    sPeakAnimations[sPeakAnimationCount++].data = loaded;
    sPeakAnimationBytes += size;
    return loaded;
}
static s32 sPeakVisualSeed = 1;
// Cosmetic particles must not change gameplay RNG when replay suppresses them.
f32 peak_visual_rand_float(void) {
    if (!sPeakActive) return syUtilsRandFloat();
    s32 gameplay = syUtilsRandSeed();
    syUtilsSetRandomSeed(sPeakVisualSeed);
    f32 value = syUtilsRandFloat();
    sPeakVisualSeed = syUtilsRandSeed(); syUtilsSetRandomSeed(gameplay);
    return value;
}
u16 peak_visual_rand_ushort(void) {
    if (!sPeakActive) return syUtilsRandUShort();
    s32 gameplay = syUtilsRandSeed();
    syUtilsSetRandomSeed(sPeakVisualSeed);
    u16 value = syUtilsRandUShort();
    sPeakVisualSeed = syUtilsRandSeed(); syUtilsSetRandomSeed(gameplay);
    return value;
}
s32 peak_visual_rand_range(s32 range) {
    return (s32)((u32)peak_visual_rand_ushort() * (u32)range / 65536u);
}
static u32 sPeakQueuedFrame, sPeakQueuedPads[4];
EMSCRIPTEN_KEEPALIVE void peak_rb_queue(u32 frame, u32 p0, u32 p1, u32 p2, u32 p3) {
    sPeakQueuedFrame = frame;
    sPeakQueuedPads[0] = p0; sPeakQueuedPads[1] = p1;
    sPeakQueuedPads[2] = p2; sPeakQueuedPads[3] = p3;
}
EMSCRIPTEN_KEEPALIVE void peak_rb_begin(void) {
    syNetRollbackReset();
    sPeakFrame = 0;
    sPeakNativeFlow = EM_ASM_INT({ return Module.peakNativeFlow ? 1 : 0; });
    sPeakHybrid = sPeakNativeFlow && EM_ASM_INT({ return Module.peakHybridRollback ? 1 : 0; });
    sPeakCatchupEnabled = EM_ASM_INT({ return Module.peakCatchup !== false ? 1 : 0; });
    sPeakBarrier = FALSE;
    sPeakBarrierCount = sPeakPredictedCount = 0;
    sPeakCatchupDebt = sPeakCatchupCount = 0;
    memset(sPeakTimings, 0, sizeof(sPeakTimings));
    sPeakActive = TRUE;
}
EMSCRIPTEN_KEEPALIVE void peak_rb_end(void) {
    sPeakActive = FALSE;
    syNetRollbackReset();
}
EMSCRIPTEN_KEEPALIVE u32 peak_rb_save(u32 frame) {
    if (!sPeakActive) return 0;
    if ((sPeakNativeFlow && !sPeakHybrid) || !sPeakBattleLoop) return frame;
    if (sPeakHybrid && gSCManagerBattleState->game_status != nSCBattleGameStatusGo) return frame;
    syNetRollbackCapturePreFrame(frame);
    peak_rb_record_timing(0, sSYNetRollbackSnapshotEncodeUs);
    return sSYNetRollbackSnapshots[frame % SYNETROLLBACK_RING].restorable ? frame : 0;
}
EMSCRIPTEN_KEEPALIVE int peak_rb_restore(u32 handle) {
    if (!sPeakActive || (sPeakNativeFlow && !sPeakHybrid) || !syNetRollbackRestoreSnapshot(handle)) return 0;
    peak_rb_record_timing(1, sSYNetRollbackSnapshotRestoreUs);
    sPeakBarrier = FALSE;
    sPeakFrame = handle - 1;
    return 1;
}
EMSCRIPTEN_KEEPALIVE int peak_rb_can_predict(u32 confirmed) {
    if ((sPeakNativeFlow && !sPeakHybrid) || !sPeakBattleLoop) return 0;
    // Countdown/end-screen coroutines are not part of Vita's battle snapshot.
    // Wait for confirmed inputs while these transitions own game state.
    if (!gSCManagerBattleState || gSCManagerBattleState->game_status != nSCBattleGameStatusGo) return 0;
    return syNetRollbackSpeculationSafe(confirmed);
}
EMSCRIPTEN_KEEPALIVE void peak_rb_step(u32 frame, u32 p0, u32 p1, u32 p2, u32 p3, int replaying) {
    u64 begin = port_netplay_monotonic_us();
    u32 packed[4] = {p0, p1, p2, p3};
    sSYNetRollbackResimulating = replaying;
    // Confirmed forward frames can omit capture; object-retirement timestamps
    // must still follow the executing simulation frame.
    sSYNetRollbackForwardFrame = frame;
    sPeakExecuting = frame;
    if (sPeakHybrid && !replaying && frame > sPeakConfirmed) ++sPeakPredictedCount;
    sPeakBarrier = FALSE;
    for (int i = 0; i < 4; ++i) {
        SYNetInputFrame input;
        syNetInputMakeFrame(&input, frame, packed[i] & 0xffff,
                           (s8)(packed[i] >> 16), (s8)(packed[i] >> 24), nSYNetInputSourceSaved, FALSE);
        syNetInputPublishFrame(i, &input);
    }
    syNetInputPublishMainController();
    syNetInputSetTick(frame);
    // Hybrid battles defer irreversible transitions and retry the triggering
    // frame confirmed in this coroutine. The older battle-only test stops at End.
    if (sPeakHybrid || gSCManagerBattleState->game_status != nSCBattleGameStatusEnd)
        ifCommonBattleUpdateInterfaceAll();
    sSYNetRollbackResimulating = FALSE;
    sPeakFrame = frame;
    // Only forward execution advances deferred object cleanup.
    if (!replaying) syNetRollbackPostFrame(frame);
    peak_rb_record_timing(replaying ? 3 : 2, syNetRollbackElapsedUs(begin));
}
EMSCRIPTEN_KEEPALIVE int peak_rb_finished(void) {
    return sPeakBattleLoop && gSCManagerBattleState && gSCManagerBattleState->game_status == nSCBattleGameStatusEnd;
}
void peak_rb_menu_input(void) {
    for (int i = 0; i < 4; ++i) {
        u32 packed = sPeakQueuedPads[i];
        SYNetInputFrame input;
        syNetInputMakeFrame(&input, sPeakQueuedFrame, packed & 0xffff,
            (s8)(packed >> 16), (s8)(packed >> 24), nSYNetInputSourceSaved, FALSE);
        syNetInputPublishFrame(i, &input);
    }
    syNetInputPublishMainController();
    syNetInputSetTick(sPeakQueuedFrame);
    sPeakFrame = sPeakQueuedFrame;
}
static SYNetSyncDigest sPeakDigest;
EMSCRIPTEN_KEEPALIVE const u32 *peak_rb_fighter_details(void) {
    static u32 values[4 * 16];
    memset(values, 0, sizeof(values));
    for (GObj *o = gGCCommonLinks[nGCCommonLinkIDFighter]; o; o = o->link_next) {
        FTStruct *fp = ftGetStruct(o);
        u32 *p = &values[fp->player * 16];
        p[0]=fp->status_total_tics; p[1]=fp->input.pl.button_hold;
        p[2]=fp->input.pl.button_tap; p[3]=fp->input.pl.button_release;
        p[4]=fp->input.pl.stick_range.x; p[5]=fp->tap_stick_x;
        p[6]=fp->hold_stick_x; p[7]=fp->motion_count;
        p[8]=fp->invincible_tics; p[9]=fp->intangible_tics;
        p[10]=fp->tics_since_last_z; p[11]=fp->acid_wait;
        p[12]=fp->twister_wait; p[13]=fp->tarucann_wait;
        p[14]=fp->motion_attack_id; p[15]=fp->tap_stick_y;
    }
    return values;
}
// Pointer-free gameplay coverage for input-driven rollback regressions.
// Reading this export never spawns objects, changes fighter state or consumes RNG.
EMSCRIPTEN_KEEPALIVE const s32 *peak_rb_gameplay_details(void) {
    static s32 values[4 * 16];
    memset(values, 0, sizeof(values));
    for (GObj *o = gGCCommonLinks[nGCCommonLinkIDFighter]; o; o = o->link_next) {
        FTStruct *fp = ftGetStruct(o);
        s32 *p = &values[fp->player * 16];
        p[0] = 1; p[1] = fp->fkind; p[2] = fp->status_id;
        memcpy(&p[3], &DObjGetStruct(o)->translate.vec.f, sizeof(Vec3f));
        p[6] = fp->lr;
        p[7] = fp->item_gobj ? itGetStruct(fp->item_gobj)->kind + 1 : 0;
        p[8] = fp->fkind == nFTKindKirby ? fp->passive_vars.kirby.copy_id + 1 : 0;
        p[9] = fp->catch_gobj ? ftGetStruct(fp->catch_gobj)->player + 1 : 0;
        p[10] = fp->capture_gobj ? ftGetStruct(fp->capture_gobj)->player + 1 : 0;
        p[11] = fp->stock_count; p[12] = fp->hitstatus;
        p[13] = fp->invincible_tics; p[14] = fp->intangible_tics;
        p[15] = fp->item_gobj ? itGetStruct(fp->item_gobj)->multi : 0;
    }
    return values;
}
// Extended, pointer-free oracle. First 128 words are four 32-word fighters;
// word 128 is the item count, followed by 12 words per live item.
EMSCRIPTEN_KEEPALIVE const s32 *peak_rb_gameplay_extra(void) {
    static s32 values[129 + ITEM_ALLOC_MAX * 12];
    memset(values, 0, sizeof(values));
    for (GObj *o = gGCCommonLinks[nGCCommonLinkIDFighter]; o; o = o->link_next) {
        FTStruct *fp = ftGetStruct(o);
        s32 *p = &values[fp->player * 32];
        if (fp->fkind == nFTKindSamus) p[0] = fp->passive_vars.samus.charge_level;
        if (fp->fkind == nFTKindDonkey) p[0] = fp->passive_vars.donkey.charge_level;
        if (fp->fkind == nFTKindKirby) {
            p[0] = fp->passive_vars.kirby.copysamus_charge_level;
            p[1] = fp->passive_vars.kirby.copydonkey_charge_level;
            p[15] = fp->passive_vars.kirby.copylink_boomerang_gobj != NULL;
        }
        if (fp->fkind == nFTKindLink) p[15] = fp->passive_vars.link.boomerang_gobj != NULL;
        p[2] = fp->shield_health; p[3] = fp->percent_damage;
        p[4] = fp->hitlag_tics; p[5] = fp->ga;
        p[6] = fp->coll_data.floor_line_id; p[7] = fp->is_cliff_hold;
        p[8] = fp->breakout_wait; p[9] = fp->is_reflect;
        p[10] = fp->is_absorb; p[11] = fp->is_shield;
        p[12] = fp->is_hitstun; p[13] = fp->star_invincible_tics;
        p[14] = fp->damage_heal;
        memcpy(&p[16], &fp->physics.vel_air, sizeof(Vec3f));
        memcpy(&p[19], &fp->physics.vel_ground, sizeof(Vec3f));
        p[22] = fp->cliffcatch_wait; p[23] = fp->jumps_used;
    }
    for (GObj *o = gGCCommonLinks[nGCCommonLinkIDItem]; o; o = o->link_next) {
        if (peak_rb_object_dead(o) || values[128] >= ITEM_ALLOC_MAX) continue;
        ITStruct *ip = itGetStruct(o);
        s32 *p = &values[129 + values[128]++ * 12];
        p[0] = ip->kind; p[1] = ip->player; p[2] = ip->multi;
        p[3] = ip->percent_damage; p[4] = ip->ga;
        p[5] = ip->attack_coll.attack_state;
        // ITStruct has no status ID. Export this predicate, never the callback
        // address, so explosion coverage cannot confuse a throw with a blast.
        if (ip->kind == nITKindBombHei && ip->proc_update == itBombHeiExplodeProcUpdate)
            p[5] |= 0x100;
        memcpy(&p[6], &DObjGetStruct(o)->translate.vec.f, sizeof(Vec3f));
        memcpy(&p[9], &ip->physics.vel_air, sizeof(Vec3f));
    }
    return values;
}
EMSCRIPTEN_KEEPALIVE const SYNetSyncDigest *peak_rb_digest(void) { return &sPeakDigest; }
EMSCRIPTEN_KEEPALIVE u32 peak_rb_hash(void) {
    if (!sPeakBattleLoop) {
        u32 hash = 2166136261u;
        hash = (hash ^ sPeakFrame) * 16777619u;
        hash = (hash ^ gSCManagerSceneData.scene_curr) * 16777619u;
        hash = (hash ^ syUtilsRandSeed()) * 16777619u;
        for (int i = 0; i < 4; ++i) {
            hash = (hash ^ sPeakQueuedPads[i]) * 16777619u;
            hash = (hash ^ gSCManagerTransferBattleState.players[i].fkind) * 16777619u;
            hash = (hash ^ gSCManagerTransferBattleState.players[i].pkind) * 16777619u;
        }
        return (hash ^ gSCManagerSceneData.gkind) * 16777619u;
    }
    SYNetSyncDigest digest;
    syNetSyncComputeDeterministicDigest(sPeakFrame, &digest);
    sPeakDigest = digest;
    return (u32)digest.total_hash ^ (u32)(digest.total_hash >> 32);
}
// Called directly by the VS coroutine, never through a reentrant JS export.
// Fiber switching may unwind this call; Asyncify must see the whole C chain.
void peak_rb_forward(void) {
    peak_rb_step(sPeakQueuedFrame, sPeakQueuedPads[0], sPeakQueuedPads[1],
                 sPeakQueuedPads[2], sPeakQueuedPads[3], FALSE);
}

// Recover only frames actually missed while waiting for network input. Keep
// forward updates in the original battle coroutine, and render its final state
// once after returning to taskman. Never accumulate debt from wall-clock time,
// menus or pause, and never bypass the scheduler's prediction/transition gates.
static sb32 peak_rb_catchup_safe(void) {
    return sPeakCatchupEnabled && sPeakHybrid && peak_rb_owns_battle() && gSCManagerBattleState &&
        gSCManagerBattleState->game_status == nSCBattleGameStatusGo;
}
void peak_rb_advance_battle(void) {
    u64 begin = port_netplay_monotonic_us();
    if (!peak_rb_catchup_safe()) sPeakCatchupDebt = 0;
    for (u32 attempt = 0; attempt < 3; ++attempt) {
        if (!EM_ASM_INT({ return Module.peakAdvance() ? 1 : 0; })) {
            if (!attempt && peak_rb_catchup_safe() && sPeakCatchupDebt < SYNETROLLBACK_WINDOW)
                ++sPeakCatchupDebt;
            break;
        }
        peak_rb_forward();
        // A speculative transition can restore the frame in complete(). Do
        // not count it as progress or run another update after that barrier.
        if (!EM_ASM_INT({ return Module.peakComplete() ? 1 : 0; })) {
            sPeakCatchupDebt = 0;
            break;
        }
        if (attempt) {
            if (sPeakCatchupDebt) --sPeakCatchupDebt;
            ++sPeakCatchupCount;
        }
        if (!peak_rb_catchup_safe()) { sPeakCatchupDebt = 0; break; }
        if (!sPeakCatchupDebt || syNetRollbackElapsedUs(begin) >= 4000) break;
    }
}

/* Pointer-free weapon diagnostics for deterministic replay regressions. */
EMSCRIPTEN_KEEPALIVE const u32 *peak_rb_weapon_details(void) {
    static u32 values[1 + WEAPON_ALLOC_MAX * 96];
    memset(values, 0, sizeof(values));
    for (GObj *obj = gGCCommonLinks[nGCCommonLinkIDWeapon]; obj; obj = obj->link_next) {
        if (peak_rb_object_dead(obj)) continue;
        WPStruct *wp = wpGetStruct(obj);
        if (!wp || values[0] >= WEAPON_ALLOC_MAX) continue;
        u32 *p = &values[1 + values[0]++ * 96];
        p[0]=wp->kind; p[1]=wp->player; p[2]=wp->group_id; p[3]=wp->lifetime;
        p[4]=wp->attack_coll.attack_state; p[5]=wp->attack_coll.damage;
        p[6]=wp->attack_coll.motion_count; p[7]=wp->attack_coll.stat_count;
        p[8]=wp->attack_coll.attack_count; p[9]=wp->ga;
        memcpy(&p[10], &DObjGetStruct(obj)->translate.vec.f, sizeof(Vec3f));
        memcpy(&p[13], &wp->physics.vel_air, sizeof(Vec3f));
        MPCollData coll = wp->coll_data;
        coll.p_translate = NULL; coll.p_lr = NULL; coll.p_map_coll = NULL;
        memcpy(&p[16], &coll, sizeof(coll));
    }
    return values;
}
