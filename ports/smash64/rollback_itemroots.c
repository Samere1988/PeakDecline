/* Picking an item up inserts a temporary DObj above its original tree. A
 * release removes it. Retain detached roots, including their XObjs, until no
 * snapshot can still refer to them. Active roots remain owned by their GObj. */
static struct { DObj *ptr; u32 frame; } sPeakItemRoots[128];
static u32 sPeakItemRootCount;
static u32 sPeakItemRootStats[4]; /* retired, revived, root restores, retained */

int peak_rb_retire_item_root(DObj *root) {
    if (!peak_rb_owns_battle() || !root->parent_gobj ||
        root->parent_gobj->link_id != nGCCommonLinkIDItem) return FALSE;
    if (root->child || root->sib_next || root->sib_prev || root->parent != DOBJ_PARENT_NULL) {
        EM_ASM({ throw new Error('Unsupported Smash item root removal.'); });
        return FALSE;
    }
    for (u32 i = 0; i < sPeakItemRootCount; ++i)
        if (sPeakItemRoots[i].ptr == root) return TRUE;
    if (sPeakItemRootCount == ARRAY_COUNT(sPeakItemRoots)) {
        EM_ASM({ throw new Error('Smash rollback item root capacity exceeded.'); });
        return FALSE;
    }
    sPeakItemRoots[sPeakItemRootCount].ptr = root;
    sPeakItemRoots[sPeakItemRootCount++].frame = sSYNetRollbackForwardFrame;
    ++sPeakItemRootStats[0];
    return TRUE;
}

static void peak_rb_collect_item_roots(u32 frame) {
    for (u32 i = 0; i < sPeakItemRootCount;) {
        if (sPeakItemRoots[i].frame + SYNETROLLBACK_WINDOW < frame) {
            DObj *root = sPeakItemRoots[i].ptr;
            // Its old owner can already have been recycled. Eject against a
            // temporary owner so freeing this detached node cannot unlink a
            // current item tree or dereference an obsolete owner.
            GObj owner = {0};
            owner.obj = root;
            owner.obj_kind = nGCCommonAppendDObj;
            root->parent_gobj = &owner;
            gcEjectDObj(root);
            sPeakItemRoots[i] = sPeakItemRoots[--sPeakItemRootCount];
        } else ++i;
    }
}
static void peak_rb_reset_item_roots(void) { peak_rb_collect_item_roots(UINT32_MAX); }

static sb32 peak_rb_restore_item_roots(const SYNetRollbackSnapshot *snapshot) {
    for (u32 i = 0; i < snapshot->item_count; ++i) {
        const SYNetRollbackItemState *saved = &snapshot->items[i];
        GObj *obj = saved->gobj;
        DObj *live = DObjGetStruct(obj);
        if (live != saved->root) {
            // Discard a speculative pickup wrapper, but keep the original
            // child tree. It is also present in the saved DObj list.
            sb32 live_saved = FALSE;
            for (u32 d = 0; d < snapshot->dobj_count; ++d)
                if (snapshot->dobjs[d].ptr == live) { live_saved = TRUE; break; }
            if (!live_saved) {
                if (!live || !live->child || live->sib_next || live->sib_prev) return FALSE;
                lbCommonEjectTreeDObj(live);
            }
            obj->obj = saved->root;
            obj->obj_kind = nGCCommonAppendDObj;
            ++sPeakItemRootStats[2];
        }
        for (u32 n = 0; n < sPeakItemRootCount; ++n) {
            if (sPeakItemRoots[n].ptr == saved->root) {
                sPeakItemRoots[n] = sPeakItemRoots[--sPeakItemRootCount];
                ++sPeakItemRootStats[1];
                break;
            }
        }
    }
    return TRUE;
}
EMSCRIPTEN_KEEPALIVE const u32 *peak_rb_item_root_stats(void) {
    sPeakItemRootStats[3] = sPeakItemRootCount;
    return sPeakItemRootStats;
}
