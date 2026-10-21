/* Attached effects consume fighter commands and may be referenced by owners.
 * Quake effects produce camera motion. Retain allocation identity throughout
 * the snapshot window.
 * Animation trees/tracks use the existing DObj/AObj snapshot and retention code.
 */
typedef struct PeakEffectAllocation {
    GObj *gobj;
    u32 retired_frame;
    sb32 retired;
} PeakEffectAllocation;

static PeakEffectAllocation sPeakEffects[PEAK_EFFECT_MAX * 4];
// Replayable effects must not compete with unsnapshotted particles for EF slots.
static EFStruct sPeakEffectPool[ARRAY_COUNT(sPeakEffects)];
static sb32 sPeakEffectUsed[ARRAY_COUNT(sPeakEffects)];
/* saves, restores, creates, replay creates, retires, revives, discarded futures,
 * current live objects, retained dead objects, occupied effect slots */
static u32 sPeakEffectStats[10];

EFStruct *peak_rb_alloc_effect(sb32 is_force_return) {
    if (!peak_rb_owns_battle()) return efManagerGetNextStructAlloc(is_force_return);
    for (u32 i = 0; i < ARRAY_COUNT(sPeakEffectPool); ++i) {
        if (sPeakEffectUsed[i]) continue;
        sPeakEffectUsed[i] = TRUE;
        memset(&sPeakEffectPool[i], 0, sizeof(EFStruct));
        return &sPeakEffectPool[i];
    }
    EM_ASM({ throw new Error('Smash rollback effect capacity exceeded.'); });
    return NULL;
}

int peak_rb_release_effect(EFStruct *effect) {
    for (u32 i = 0; i < ARRAY_COUNT(sPeakEffectPool); ++i) {
        if (effect != &sPeakEffectPool[i]) continue;
        for (u32 j = 0; j < ARRAY_COUNT(sPeakEffects); ++j)
            if (sPeakEffects[j].gobj && efGetStruct(sPeakEffects[j].gobj) == effect) return TRUE;
        sPeakEffectUsed[i] = FALSE;
        return TRUE;
    }
    return FALSE;
}

static PeakEffectAllocation *peak_rb_find_effect(GObj *gobj) {
    if (!gobj) return NULL;
    for (u32 i = 0; i < ARRAY_COUNT(sPeakEffects); ++i)
        if (sPeakEffects[i].gobj == gobj) return &sPeakEffects[i];
    return NULL;
}

void peak_rb_track_effect(GObj *gobj) {
    if (!gobj || !peak_rb_owns_battle()) return;
    for (u32 i = 0; i < ARRAY_COUNT(sPeakEffects); ++i) {
        if (sPeakEffects[i].gobj) continue;
        sPeakEffects[i] = (PeakEffectAllocation){.gobj = gobj};
        ++sPeakEffectStats[2];
        if (sSYNetRollbackResimulating) ++sPeakEffectStats[3];
        return;
    }
    EM_ASM({ throw new Error('Smash rollback effect retention capacity exceeded.'); });
}

int peak_rb_dead_effect(GObj *gobj) {
    PeakEffectAllocation *entry = peak_rb_find_effect(gobj);
    return entry && entry->retired;
}

int peak_rb_retire_effect(GObj *gobj) {
    PeakEffectAllocation *entry = peak_rb_find_effect(gobj);
    if (!entry) return FALSE;
    if (!entry->retired) {
        entry->retired = TRUE;
        entry->retired_frame = sSYNetRollbackForwardFrame;
        ++sPeakEffectStats[4];
    }
    gobj->flags |= GOBJ_FLAG_HIDDEN | GOBJ_FLAG_NORUN;
    syNetRollbackSetGObjProcsPaused(gobj, TRUE);
    return TRUE;
}

static void peak_rb_free_effect(PeakEffectAllocation *entry) {
    GObj *gobj = entry->gobj;
    entry->gobj = NULL;
    if (efGetStruct(gobj)) efManagerSetPrevStructAlloc(efGetStruct(gobj));
    gcEjectGObj(gobj);
}

static void peak_rb_collect_effects(u32 frame) {
    for (u32 i = 0; i < ARRAY_COUNT(sPeakEffects); ++i) {
        PeakEffectAllocation *entry = &sPeakEffects[i];
        if (entry->gobj && entry->retired && entry->retired_frame + SYNETROLLBACK_WINDOW < frame)
            peak_rb_free_effect(entry);
    }
}

static void peak_rb_reset_effects(void) {
    for (u32 i = 0; i < ARRAY_COUNT(sPeakEffects); ++i) {
        PeakEffectAllocation *entry = &sPeakEffects[i];
        // Reset runs before the native scene arena is recycled (also at session
        // shutdown). Release live and retired effects while their nodes are valid.
        if (entry->gobj) peak_rb_free_effect(entry);
    }
}

static void peak_rb_save_effects(SYNetRollbackSnapshot *snapshot) {
    for (u32 i = 0; i < ARRAY_COUNT(sPeakEffects); ++i) {
        PeakEffectAllocation *entry = &sPeakEffects[i];
        if (!entry->gobj || entry->retired) continue;
        if (snapshot->effect_count == PEAK_EFFECT_MAX) { snapshot->restorable = FALSE; return; }
        GObj *obj = entry->gobj;
        GObjProcess *proc = obj->gobjproc_head;
        // Initialization can be lazy: func_run creates a process on the next
        // game update. Preserve that boundary when rewinding.
        if (proc && (proc->link_next || proc->kind != nGCProcessKindFunc ||
                     proc->priority > 3)) {
            snapshot->restorable = FALSE; return;
        }
        PeakEffectState *state = &snapshot->effects[snapshot->effect_count++];
        *state = (PeakEffectState){.gobj = obj,
            .anim_frame = obj->anim_frame, .flags = obj->flags, .func_run = obj->func_run,
            .has_process = proc != NULL, .process_paused = proc ? proc->is_paused : FALSE,
            .process_func = proc ? proc->exec.func : NULL, .process_priority = proc ? proc->priority : 0};
        if (efGetStruct(obj)) state->effect = *efGetStruct(obj);
        syNetRollbackSaveGObjDObjs(snapshot, obj);
        ++sPeakEffectStats[0];
    }
}

static sb32 peak_rb_restore_effects(const SYNetRollbackSnapshot *snapshot) {
    // Validate identities before touching memory held by the saved pointers.
    for (u32 n = 0; n < snapshot->effect_count; ++n)
        if (!peak_rb_find_effect(snapshot->effects[n].gobj)) return FALSE;
    for (u32 i = 0; i < ARRAY_COUNT(sPeakEffects); ++i) {
        PeakEffectAllocation *entry = &sPeakEffects[i];
        if (!entry->gobj) continue;
        const PeakEffectState *state = NULL;
        for (u32 n = 0; n < snapshot->effect_count; ++n)
            if (snapshot->effects[n].gobj == entry->gobj) { state = &snapshot->effects[n]; break; }
        if (!state) {
            // Already-dead allocations may be needed by older snapshots. An
            // effect absent from this snapshot but created later is discarded.
            if (!(entry->retired && entry->retired_frame < snapshot->frame)) {
                peak_rb_free_effect(entry);
                ++sPeakEffectStats[6];
            }
            continue;
        }
        if (entry->retired) ++sPeakEffectStats[5];
        entry->retired = FALSE;
        GObj *obj = entry->gobj;
        if (efGetStruct(obj)) *efGetStruct(obj) = state->effect;
        obj->anim_frame = state->anim_frame;
        obj->flags = state->flags;
        obj->func_run = state->func_run;
        if (!state->has_process) {
            while (obj->gobjproc_head) gcEndGObjProcess(obj->gobjproc_head);
        } else {
            GObjProcess *proc = obj->gobjproc_head;
            if (proc && (proc->exec.func != state->process_func || proc->priority != state->process_priority)) {
                gcEndGObjProcess(proc); proc = NULL;
            }
            if (!proc) proc = gcAddGObjProcess(obj, state->process_func, nGCProcessKindFunc, state->process_priority);
            if (!proc) return FALSE;
            proc->is_paused = state->process_paused;
        }
        ++sPeakEffectStats[1];
    }
    return TRUE;
}

EMSCRIPTEN_KEEPALIVE const u32 *peak_rb_effect_stats(void) {
    sPeakEffectStats[7] = sPeakEffectStats[8] = sPeakEffectStats[9] = 0;
    for (u32 i = 0; i < ARRAY_COUNT(sPeakEffects); ++i)
        if (sPeakEffects[i].gobj) ++sPeakEffectStats[sPeakEffects[i].retired ? 8 : 7];
    for (u32 i = 0; i < ARRAY_COUNT(sPeakEffectUsed); ++i)
        if (sPeakEffectUsed[i]) ++sPeakEffectStats[9];
    return sPeakEffectStats;
}

/* No snapshotted owner may resurrect a recycled cosmetic particle transform.
 * Stage handles are preserved across restore; invalidate them on actual free. */
void peak_rb_forget_transform(LBTransform *xf) {
    if (!peak_rb_owns_battle() || !xf) return;
    if (gSCManagerBattleState->gkind == nGRKindPupupu) {
        if (gGRCommonStruct.pupupu.leaves_xf == xf) gGRCommonStruct.pupupu.leaves_xf = NULL;
        if (gGRCommonStruct.pupupu.dust_xf == xf) gGRCommonStruct.pupupu.dust_xf = NULL;
    } else if (gSCManagerBattleState->gkind == nGRKindHyrule) {
        if (gGRCommonStruct.hyrule.twister_xf == xf) gGRCommonStruct.hyrule.twister_xf = NULL;
    }
    for (GObj *obj = gGCCommonLinks[nGCCommonLinkIDEffect]; obj; obj = obj->link_next) {
        EFStruct *ep = efGetStruct(obj);
        if (ep && ep->xf == xf) ep->xf = NULL;
    }
}
