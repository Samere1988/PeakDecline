/* Egg effects determine gameplay (escape timing), unlike ordinary cosmetic
 * effects. Keep their allocation identity valid throughout the snapshot window.
 * Animation trees/tracks use the existing DObj/AObj snapshot and retention code.
 */
typedef struct PeakEggAllocation {
    GObj *gobj;
    u32 retired_frame;
    sb32 retired;
} PeakEggAllocation;

static PeakEggAllocation sPeakEggs[GMCOMMON_PLAYERS_MAX * (SYNETROLLBACK_WINDOW + 3)];
// Cosmetic effects are skipped during replay and can exhaust their small pool
// differently on each client. Gameplay eggs must not depend on that pool.
static EFStruct sPeakEggEffects[ARRAY_COUNT(sPeakEggs)];
static sb32 sPeakEggEffectUsed[ARRAY_COUNT(sPeakEggs)];
/* saves, restores, creates, replay creates, retires, revives, discarded futures,
 * current live objects, retained dead objects, occupied effect slots */
static u32 sPeakEggStats[10];

EFStruct *peak_rb_alloc_egg_effect(void) {
    if (!peak_rb_owns_battle()) return efManagerGetNextStructAlloc(TRUE);
    for (u32 i = 0; i < ARRAY_COUNT(sPeakEggEffects); ++i) {
        if (sPeakEggEffectUsed[i]) continue;
        sPeakEggEffectUsed[i] = TRUE;
        memset(&sPeakEggEffects[i], 0, sizeof(EFStruct));
        return &sPeakEggEffects[i];
    }
    EM_ASM({ throw new Error('Smash rollback egg effect capacity exceeded.'); });
    return NULL;
}

int peak_rb_release_egg_effect(EFStruct *effect) {
    for (u32 i = 0; i < ARRAY_COUNT(sPeakEggEffects); ++i) {
        if (effect != &sPeakEggEffects[i]) continue;
        sPeakEggEffectUsed[i] = FALSE;
        return TRUE;
    }
    return FALSE;
}

static PeakEggAllocation *peak_rb_find_egg(GObj *gobj) {
    if (!gobj) return NULL;
    for (u32 i = 0; i < ARRAY_COUNT(sPeakEggs); ++i)
        if (sPeakEggs[i].gobj == gobj) return &sPeakEggs[i];
    return NULL;
}

void peak_rb_track_egg(GObj *gobj) {
    if (!gobj || !peak_rb_owns_battle()) return;
    for (u32 i = 0; i < ARRAY_COUNT(sPeakEggs); ++i) {
        if (sPeakEggs[i].gobj) continue;
        sPeakEggs[i] = (PeakEggAllocation){.gobj = gobj};
        ++sPeakEggStats[2];
        if (sSYNetRollbackResimulating) ++sPeakEggStats[3];
        return;
    }
    EM_ASM({ throw new Error('Smash rollback egg retention capacity exceeded.'); });
}

int peak_rb_dead_egg(GObj *gobj) {
    PeakEggAllocation *entry = peak_rb_find_egg(gobj);
    return entry && entry->retired;
}

int peak_rb_retire_egg(GObj *gobj) {
    PeakEggAllocation *entry = peak_rb_find_egg(gobj);
    if (!entry) return FALSE;
    if (!entry->retired) {
        entry->retired = TRUE;
        entry->retired_frame = sSYNetRollbackForwardFrame;
        ++sPeakEggStats[4];
    }
    gobj->flags |= GOBJ_FLAG_HIDDEN | GOBJ_FLAG_NORUN;
    syNetRollbackSetGObjProcsPaused(gobj, TRUE);
    return TRUE;
}

static void peak_rb_free_egg(PeakEggAllocation *entry) {
    GObj *gobj = entry->gobj;
    entry->gobj = NULL;
    efManagerSetPrevStructAlloc(efGetStruct(gobj));
    gcEjectGObj(gobj);
}

static void peak_rb_collect_eggs(u32 frame) {
    for (u32 i = 0; i < ARRAY_COUNT(sPeakEggs); ++i) {
        PeakEggAllocation *entry = &sPeakEggs[i];
        if (entry->gobj && entry->retired && entry->retired_frame + SYNETROLLBACK_WINDOW < frame)
            peak_rb_free_egg(entry);
    }
}

static void peak_rb_reset_eggs(void) {
    for (u32 i = 0; i < ARRAY_COUNT(sPeakEggs); ++i) {
        PeakEggAllocation *entry = &sPeakEggs[i];
        // Reset runs before the native scene arena is recycled (also at session
        // shutdown). Release live and retired eggs while their nodes are valid.
        if (entry->gobj) peak_rb_free_egg(entry);
    }
}

static void peak_rb_save_eggs(SYNetRollbackSnapshot *snapshot) {
    for (u32 i = 0; i < ARRAY_COUNT(sPeakEggs); ++i) {
        PeakEggAllocation *entry = &sPeakEggs[i];
        if (!entry->gobj || entry->retired) continue;
        if (snapshot->egg_count == GMCOMMON_PLAYERS_MAX) { snapshot->restorable = FALSE; return; }
        GObj *obj = entry->gobj;
        GObjProcess *proc = obj->gobjproc_head;
        // Egg initialization is lazy: func_run creates one function process on
        // the following game update. Preserve that boundary when rewinding.
        if (proc && (proc->link_next || proc->kind != nGCProcessKindFunc ||
                     proc->exec.func != efManagerYoshiEggLayProcUpdate || proc->priority != 3)) {
            snapshot->restorable = FALSE; return;
        }
        PeakEggState *state = &snapshot->eggs[snapshot->egg_count++];
        *state = (PeakEggState){.gobj = obj, .effect = *efGetStruct(obj),
            .anim_frame = obj->anim_frame, .flags = obj->flags, .func_run = obj->func_run,
            .has_process = proc != NULL, .process_paused = proc ? proc->is_paused : FALSE};
        syNetRollbackSaveGObjDObjs(snapshot, obj);
        ++sPeakEggStats[0];
    }
}

static sb32 peak_rb_restore_eggs(const SYNetRollbackSnapshot *snapshot) {
    // Validate identities before touching memory held by the saved pointers.
    for (u32 n = 0; n < snapshot->egg_count; ++n)
        if (!peak_rb_find_egg(snapshot->eggs[n].gobj)) return FALSE;
    for (u32 i = 0; i < ARRAY_COUNT(sPeakEggs); ++i) {
        PeakEggAllocation *entry = &sPeakEggs[i];
        if (!entry->gobj) continue;
        const PeakEggState *state = NULL;
        for (u32 n = 0; n < snapshot->egg_count; ++n)
            if (snapshot->eggs[n].gobj == entry->gobj) { state = &snapshot->eggs[n]; break; }
        if (!state) {
            // Already-dead allocations may be needed by older snapshots. An
            // effect absent from this snapshot but created later is discarded.
            if (!(entry->retired && entry->retired_frame < snapshot->frame)) {
                peak_rb_free_egg(entry);
                ++sPeakEggStats[6];
            }
            continue;
        }
        if (entry->retired) ++sPeakEggStats[5];
        entry->retired = FALSE;
        GObj *obj = entry->gobj;
        *efGetStruct(obj) = state->effect;
        obj->anim_frame = state->anim_frame;
        obj->flags = state->flags;
        obj->func_run = state->func_run;
        if (!state->has_process) {
            while (obj->gobjproc_head) gcEndGObjProcess(obj->gobjproc_head);
        } else {
            GObjProcess *proc = obj->gobjproc_head;
            if (!proc) proc = gcAddGObjProcess(obj, efManagerYoshiEggLayProcUpdate, nGCProcessKindFunc, 3);
            if (!proc) return FALSE;
            proc->is_paused = state->process_paused;
        }
        ++sPeakEggStats[1];
    }
    return TRUE;
}

EMSCRIPTEN_KEEPALIVE const u32 *peak_rb_egg_stats(void) {
    sPeakEggStats[7] = sPeakEggStats[8] = sPeakEggStats[9] = 0;
    for (u32 i = 0; i < ARRAY_COUNT(sPeakEggs); ++i)
        if (sPeakEggs[i].gobj) ++sPeakEggStats[sPeakEggs[i].retired ? 8 : 7];
    for (u32 i = 0; i < ARRAY_COUNT(sPeakEggEffectUsed); ++i)
        if (sPeakEggEffectUsed[i]) ++sPeakEggStats[9];
    return sPeakEggStats;
}
