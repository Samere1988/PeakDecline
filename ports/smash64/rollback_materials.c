/* Included in the native snapshot translation unit after rollback_exports.c. */
static sb32 peak_rb_bytes_equal(const void *a, const void *b, u32 size) {
    const u8 *left = a, *right = b;
    for (u32 i = 0; i < size; ++i) if (left[i] != right[i]) return FALSE;
    return TRUE;
}
static struct { MObj *ptr; u32 frame; } sPeakRetiredMaterials[4096];
static u32 sPeakRetiredMaterialCount;
static sb32 sPeakCollectingMaterials;
/* materials saved/restored, revived, discarded; peak snapshot count;
 * active material tracks restored; retained allocations */
static u32 sPeakMaterialStats[7];

int peak_rb_retire_material(MObj *ptr) {
    if (!peak_rb_owns_battle() || sPeakCollectingMaterials) return FALSE;
    for (u32 i = 0; i < sPeakRetiredMaterialCount; ++i)
        if (sPeakRetiredMaterials[i].ptr == ptr) return TRUE;
    if (sPeakRetiredMaterialCount == ARRAY_COUNT(sPeakRetiredMaterials)) {
        EM_ASM({ throw new Error('Smash rollback material retention capacity exceeded.'); });
        return TRUE;
    }
    sPeakRetiredMaterials[sPeakRetiredMaterialCount].ptr = ptr;
    sPeakRetiredMaterials[sPeakRetiredMaterialCount++].frame = sSYNetRollbackForwardFrame;
    return TRUE;
}

static void peak_rb_reactivate_material(MObj *ptr) {
    for (u32 i = 0; i < sPeakRetiredMaterialCount; ++i)
        if (sPeakRetiredMaterials[i].ptr == ptr) {
            sPeakRetiredMaterials[i] = sPeakRetiredMaterials[--sPeakRetiredMaterialCount];
            ++sPeakMaterialStats[2];
            return;
        }
}

static void peak_rb_collect_materials(u32 frame) {
    sPeakCollectingMaterials = TRUE;
    for (u32 i = 0; i < sPeakRetiredMaterialCount;) {
        if (sPeakRetiredMaterials[i].frame + SYNETROLLBACK_WINDOW < frame) {
            // Their tracks were retired separately at removal time.
            gcSetMObjPrevAlloc(sPeakRetiredMaterials[i].ptr);
            sPeakRetiredMaterials[i] = sPeakRetiredMaterials[--sPeakRetiredMaterialCount];
        } else ++i;
    }
    sPeakCollectingMaterials = FALSE;
}
static void peak_rb_reset_materials(void) { peak_rb_collect_materials(UINT32_MAX); }

static u32 peak_rb_save_tracks(AObj *node, PeakAnimTrackState *dst, u32 capacity, sb32 *restorable) {
    u32 count = 0;
    for (; node; node = node->next) {
        if (count == capacity) { *restorable = FALSE; break; }
        dst[count++] = (PeakAnimTrackState){.ptr = node, .state = *node};
    }
    return count;
}

static void peak_rb_restore_tracks(AObj **head, const PeakAnimTrackState *saved, u32 count) {
    for (AObj *node = *head, *next; node; node = next) {
        next = node->next;
        u32 i;
        for (i = 0; i < count; ++i) if (saved[i].ptr == node) break;
        if (i == count) gcSetAObjPrevAlloc(node);
    }
    for (u32 i = 0; i < count; ++i) {
        peak_rb_reactivate_aobj(saved[i].ptr);
        *saved[i].ptr = saved[i].state;
    }
    *head = count ? saved[0].ptr : NULL;
}

static void peak_rb_save_materials(SYNetRollbackSnapshot *snapshot) {
    for (u32 d = 0; d < snapshot->dobj_count; ++d) {
        SYNetRollbackDObjState *joint = &snapshot->dobjs[d];
        joint->mobj = joint->ptr->mobj;
        for (MObj *m = joint->mobj; m; m = m->next) {
            if (snapshot->material_count == PEAK_MATERIAL_MAX) { snapshot->restorable = FALSE; return; }
            PeakMaterialState *saved = &snapshot->materials[snapshot->material_count++];
            saved->ptr = m;
            saved->state = *m;
            saved->track_count = peak_rb_save_tracks(m->aobj, saved->tracks,
                PEAK_MATERIAL_TRACK_MAX, &snapshot->restorable);
            ++sPeakMaterialStats[0];
        }
    }
    if (snapshot->material_count > sPeakMaterialStats[4]) sPeakMaterialStats[4] = snapshot->material_count;
}

static void peak_rb_restore_materials(const SYNetRollbackSnapshot *snapshot) {
    for (u32 d = 0; d < snapshot->dobj_count; ++d) {
        const SYNetRollbackDObjState *joint = &snapshot->dobjs[d];
        for (MObj *m = joint->ptr->mobj, *next; m; m = next) {
            next = m->next;
            u32 i;
            for (i = 0; i < snapshot->material_count; ++i)
                if (snapshot->materials[i].ptr == m) break;
            if (i == snapshot->material_count) {
                gcRemoveAObjFromMObj(m);
                gcSetMObjPrevAlloc(m);
                ++sPeakMaterialStats[3];
            }
        }
        joint->ptr->mobj = joint->mobj;
    }
    for (u32 i = 0; i < snapshot->material_count; ++i) {
        const PeakMaterialState *saved = &snapshot->materials[i];
        MObj *m = saved->ptr;
        peak_rb_reactivate_material(m);
        peak_rb_restore_tracks(&m->aobj, saved->tracks, saved->track_count);
        *m = saved->state;
        ++sPeakMaterialStats[1];
        if (m->anim_wait != AOBJ_ANIM_NULL) sPeakMaterialStats[5] += saved->track_count;
    }
}

EMSCRIPTEN_KEEPALIVE const u32 *peak_rb_material_stats(void) {
    sPeakMaterialStats[6] = sPeakRetiredMaterialCount;
    return sPeakMaterialStats;
}

/* Local round-trip check, called by the browser fixture immediately after
 * restore, before replay. Pointers are compared only within this instance. */
EMSCRIPTEN_KEEPALIVE int peak_rb_verify_materials(u32 frame) {
    const SYNetRollbackSnapshot *s = &sSYNetRollbackSnapshots[frame % SYNETROLLBACK_RING];
    if (!s->valid || s->frame != frame || !s->restorable) return FALSE;
    if (!peak_rb_bytes_equal(&gITManagerMonsterData, &s->monster_data, sizeof(ITMonsterData))) return FALSE;
    if (dGRYamabukiMonsterAttackKind != s->yamabuki_attack_kind ||
        sFTMainGroundObstaclesNum != s->obstacle_count || sFTMainGroundHazardsNum != s->hazard_count ||
        !peak_rb_bytes_equal(sFTMainGroundObstacles, s->obstacles, sizeof(s->obstacles)) ||
        !peak_rb_bytes_equal(sFTMainGroundHazards, s->hazards, sizeof(s->hazards))) return FALSE;
    for (u32 i = 0; i < s->item_count; ++i) {
        const SYNetRollbackItemState *item = &s->items[i];
        if (DObjGetStruct(item->gobj) != item->root) return FALSE;
        if (item->gobj->proc_display != item->proc_display || item->gobj->dl_link_id != item->dl_link_id ||
            item->gobj->dl_link_priority != item->dl_link_priority) return FALSE;
    }
    for (u32 i = 0; i < s->weapon_count; ++i) {
        const SYNetRollbackWeaponState *weapon = &s->weapons[i];
        if (weapon->gobj->proc_display != weapon->proc_display || weapon->gobj->dl_link_id != weapon->dl_link_id ||
            weapon->gobj->dl_link_priority != weapon->dl_link_priority) return FALSE;
    }
    for (u32 i = 0; i < s->effect_count; ++i) {
        const PeakEffectState *effect = &s->effects[i];
        GObj *obj = effect->gobj;
        GObjProcess *proc = obj->gobjproc_head;
        if (efGetStruct(obj) && !peak_rb_bytes_equal(efGetStruct(obj), &effect->effect, sizeof(EFStruct))) return FALSE;
        if (obj->anim_frame != effect->anim_frame || obj->flags != effect->flags || obj->func_run != effect->func_run) return FALSE;
        if ((proc != NULL) != effect->has_process) return FALSE;
        if (proc && (proc->link_next || proc->exec.func != effect->process_func ||
                     proc->priority != effect->process_priority || proc->is_paused != effect->process_paused)) return FALSE;
    }
    for (u32 d = 0; d < s->dobj_count; ++d) {
        const SYNetRollbackDObjState *joint = &s->dobjs[d];
        if (joint->ptr->mobj != joint->mobj || joint->ptr->dv != joint->display_list) return FALSE;
        DObj *obj = joint->ptr;
        if (obj->parent_gobj != joint->parent_gobj || obj->parent != joint->parent ||
            obj->child != joint->child || obj->sib_next != joint->sib_next ||
            obj->sib_prev != joint->sib_prev) return FALSE;
        if (obj->anim_frame != joint->anim_frame || obj->anim_wait != joint->anim_wait ||
            obj->anim_speed != joint->anim_speed || obj->is_anim_root != joint->is_anim_root ||
            obj->flags != joint->flags ||
            !peak_rb_bytes_equal(&obj->anim_joint, &joint->anim_joint, sizeof(AObjScript)) ||
            !peak_rb_bytes_equal(&obj->translate, &joint->translate, sizeof(GCTranslate)) ||
            !peak_rb_bytes_equal(&obj->rotate, &joint->rotate, sizeof(GCRotate)) ||
            !peak_rb_bytes_equal(&obj->scale, &joint->scale, sizeof(GCScale))) return FALSE;
        AObj *track = obj->aobj;
        for (u32 a = 0; a < joint->aobj_count; ++a) {
            const SYNetRollbackAObjState *saved = &joint->aobjs[a];
            if (track != saved->ptr || track->track != saved->track || track->kind != saved->kind ||
                track->interpolate != saved->interpolate || track->length_invert != saved->length_invert ||
                track->length != saved->length || track->value_base != saved->value_base ||
                track->value_target != saved->value_target || track->rate_base != saved->rate_base ||
                track->rate_target != saved->rate_target) return FALSE;
            track = track->next;
        }
        if (track) return FALSE;
        if (joint->has_fighter_parts) {
            FTParts expected = joint->fighter_parts, *actual = ftGetParts(joint->ptr);
            expected.gobj = actual->gobj;
            expected.next = actual->next;
            if (!peak_rb_bytes_equal(actual, &expected, sizeof(FTParts))) return FALSE;
        }
    }
    for (u32 i = 0; i < s->material_count; ++i) {
        const PeakMaterialState *m = &s->materials[i];
        if (!peak_rb_bytes_equal(m->ptr, &m->state, sizeof(MObj))) return FALSE;
        for (u32 j = 0; j < m->track_count; ++j)
            if (!peak_rb_bytes_equal(m->tracks[j].ptr, &m->tracks[j].state, sizeof(AObj))) return FALSE;
    }
    if (s->camera_cobj.valid) {
        const SYNetRollbackCameraState *camera = &s->camera_cobj;
        if (!peak_rb_bytes_equal(camera->ptr, &camera->camera_state, sizeof(CObj))) return FALSE;
        for (u32 j = 0; j < camera->track_count; ++j)
            if (!peak_rb_bytes_equal(camera->tracks[j].ptr, &camera->tracks[j].state, sizeof(AObj))) return FALSE;
    }
    return TRUE;
}
