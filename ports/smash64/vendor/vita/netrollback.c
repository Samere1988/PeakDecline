#include <sys/netrollback.h>

#include <ft/fighter.h>
#include <ft/ftmain.h>
#include <ft/ftmanager.h>
#include <gm/gmcamera.h>
#include <gr/ground.h>
#include <if/ifcommon.h>
#include <it/item.h>
#include <it/itmanager.h>
#include <mp/map.h>
#include <netplay/netplay_bridge.h>
#include <sc/scene.h>
#include <sys/netinput.h>
#include <sys/netsync.h>
#include <sys/objdef.h>
#include <sys/objman.h>
#include <sys/objtypes.h>
#include <sys/utils.h>
#include <wp/weapon.h>
#include <wp/wpmanager.h>

#include <string.h>

#ifdef PORT
extern void port_log(const char *fmt, ...);
#endif

#define SYNETROLLBACK_RING (SYNETROLLBACK_WINDOW + 3)
#define SYNETROLLBACK_DOBJ_MAX 384
#define SYNETROLLBACK_AOBJ_MAX 12
#define SYNETROLLBACK_ITEM_MAPOBJ_MAX 32
#define SYNETROLLBACK_ITEM_WEIGHT_MAX 64
#define SYNETROLLBACK_HASH_INTERVAL 12U
#define SYNETROLLBACK_FNV32_OFFSET 2166136261U

typedef struct SYNetRollbackAObjState
{
    AObj *ptr;
    u8 track;
    u8 kind;
    f32 length_invert;
    f32 length;
    f32 value_base;
    f32 value_target;
    f32 rate_base;
    f32 rate_target;
} SYNetRollbackAObjState;

typedef struct SYNetRollbackDObjState
{
    DObj *ptr;
    GObj *parent_gobj;
    DObj *sib_next;
    DObj *sib_prev;
    DObj *child;
    DObj *parent;
    GCTranslate translate;
    GCRotate rotate;
    GCScale scale;
    u8 flags;
    f32 anim_wait;
    f32 anim_speed;
    f32 anim_frame;
    GCUserData user_data;
    u8 aobj_count;
    SYNetRollbackAObjState aobjs[SYNETROLLBACK_AOBJ_MAX];
} SYNetRollbackDObjState;

typedef struct SYNetRollbackFighterState
{
    GObj *gobj;
    FTStruct state;
    f32 gobj_anim_frame;
    u32 tree_sig;
} SYNetRollbackFighterState;

typedef struct SYNetRollbackItemState
{
    GObj *gobj;
    ITStruct state;
    f32 gobj_anim_frame;
    u32 gobj_flags;
} SYNetRollbackItemState;

typedef struct SYNetRollbackWeaponState
{
    GObj *gobj;
    WPStruct state;
    f32 gobj_anim_frame;
    u32 gobj_flags;
} SYNetRollbackWeaponState;

typedef struct SYNetRollbackCameraState
{
    sb32 valid;
    CObj *ptr;
    CObjVec vec;
    f32 anim_wait;
    f32 anim_speed;
    f32 anim_frame;
} SYNetRollbackCameraState;

typedef struct SYNetRollbackItemManagerState
{
    u8 appear_mapobjs_num;
    u32 appear_spawn_wait;
    u8 appear_valids_num;
    u16 appear_weights_sum;
    u8 random_valids_num;
    u16 random_weights_sum;
    u8 appear_mapobjs[SYNETROLLBACK_ITEM_MAPOBJ_MAX];
    u8 appear_kinds[SYNETROLLBACK_ITEM_WEIGHT_MAX];
    u16 appear_blocks[SYNETROLLBACK_ITEM_WEIGHT_MAX];
    u8 random_kinds[SYNETROLLBACK_ITEM_WEIGHT_MAX];
    u16 random_blocks[SYNETROLLBACK_ITEM_WEIGHT_MAX];
} SYNetRollbackItemManagerState;

typedef struct SYNetRollbackSnapshot
{
    sb32 valid;
    sb32 restorable;
    u32 frame;
    s32 rng_seed;
    SCBattleState battle;
    GRStruct ground;
    GMCamera camera;
    MPAllBounds map_bounds;
    u16 map_update_tic;
    SYNetRollbackCameraState camera_cobj;
    SYNetRollbackItemManagerState item_manager;
    u16 fighter_count;
    u16 item_count;
    u16 weapon_count;
    u16 dobj_count;
    u16 yakumono_count;
    Vec3f yakumono_speeds[SYNETROLLBACK_DOBJ_MAX];
    SYNetRollbackFighterState fighters[GMCOMMON_PLAYERS_MAX];
    SYNetRollbackItemState items[ITEM_ALLOC_MAX];
    SYNetRollbackWeaponState weapons[WEAPON_ALLOC_MAX];
    SYNetRollbackDObjState dobjs[SYNETROLLBACK_DOBJ_MAX];
    sb32 hash_valid;
    u64 post_hash;
    SYNetSyncDigest post_digest;
} SYNetRollbackSnapshot;

static SYNetRollbackSnapshot sSYNetRollbackSnapshots[SYNETROLLBACK_RING];
static sb32 sSYNetRollbackResimulating;
static u32 sSYNetRollbackCount;
static u32 sSYNetRollbackMaxFrames;
static u32 sSYNetRollbackLateInputCount;
static u32 sSYNetRollbackSnapshotBytes;
static u32 sSYNetRollbackSnapshotEncodeUs;
static u32 sSYNetRollbackSnapshotRestoreUs;
static u32 sSYNetRollbackResimUs;
static u32 sSYNetRollbackLastHashSubmitted = UINT32_MAX;
static u32 sSYNetRollbackTopologyEpochFrame = UINT32_MAX;
static u32 sSYNetRollbackTopologyLogCount;

#define SYNETROLLBACK_ZOMBIE_MAX (ITEM_ALLOC_MAX + WEAPON_ALLOC_MAX)

typedef struct SYNetRollbackZombie
{
    GObj *gobj;
    void *struct_ptr;
    u32 destroy_frame;
    sb32 is_weapon;
    sb32 active;
} SYNetRollbackZombie;

static SYNetRollbackZombie sSYNetRollbackZombies[SYNETROLLBACK_ZOMBIE_MAX];
static u32 sSYNetRollbackForwardFrame;

#define SYNETROLLBACK_FIGHTER_DOBJ_ZOMBIE_MAX (GMCOMMON_PLAYERS_MAX * FTPARTS_JOINT_NUM_MAX)

typedef struct SYNetRollbackFighterDObjZombie
{
    GObj *fighter_gobj;
    DObj *dobj;
    FTParts *parts;
    s32 joint_id;
    u32 destroy_frame;
    sb32 active;
} SYNetRollbackFighterDObjZombie;

static SYNetRollbackFighterDObjZombie sSYNetRollbackFighterDObjZombies[SYNETROLLBACK_FIGHTER_DOBJ_ZOMBIE_MAX];

static SYNetRollbackZombie *syNetRollbackFindZombie(GObj *gobj)
{
    u32 i;
    for (i = 0; i < SYNETROLLBACK_ZOMBIE_MAX; i++)
    {
        if ((sSYNetRollbackZombies[i].active != FALSE) && (sSYNetRollbackZombies[i].gobj == gobj))
            return &sSYNetRollbackZombies[i];
    }
    return NULL;
}

static void syNetRollbackSetGObjProcsPaused(GObj *gobj, sb32 paused)
{
    GObjProcess *gp;
    if (gobj == NULL) return;
    for (gp = gobj->gobjproc_head; gp != NULL; gp = gp->link_next)
        gp->is_paused = paused;
}

static void syNetRollbackRealEject(GObj *gobj, void *struct_ptr, sb32 is_weapon)
{
    if (gobj == NULL) return;
    if (is_weapon != FALSE)
    {
        if (struct_ptr != NULL) wpManagerSetPrevStructAlloc((WPStruct *)struct_ptr);
    }
    else if (struct_ptr != NULL)
    {
        itManagerSetPrevStructAlloc((ITStruct *)struct_ptr);
    }
    gcEjectGObj(gobj);
}

sb32 syNetRollbackDeferObjectEject(GObj *gobj, void *struct_ptr, sb32 is_weapon)
{
    u32 i;
    SYNetRollbackZombie *z;

    if ((gobj == NULL) || (syNetInputModernNetplayActive() == FALSE)) return FALSE;
    z = syNetRollbackFindZombie(gobj);
    if (z != NULL)
    {
        z->struct_ptr = struct_ptr;
        z->destroy_frame = sSYNetRollbackForwardFrame;
        z->is_weapon = is_weapon;
        syNetRollbackSetGObjProcsPaused(gobj, TRUE);
        gobj->flags |= GOBJ_FLAG_HIDDEN;
        return TRUE;
    }
    for (i = 0; i < SYNETROLLBACK_ZOMBIE_MAX; i++)
    {
        if (sSYNetRollbackZombies[i].active != FALSE) continue;
        sSYNetRollbackZombies[i].gobj = gobj;
        sSYNetRollbackZombies[i].struct_ptr = struct_ptr;
        sSYNetRollbackZombies[i].destroy_frame = sSYNetRollbackForwardFrame;
        sSYNetRollbackZombies[i].is_weapon = is_weapon;
        sSYNetRollbackZombies[i].active = TRUE;
        syNetRollbackSetGObjProcsPaused(gobj, TRUE);
        gobj->flags |= GOBJ_FLAG_HIDDEN;
        return TRUE;
    }
    return FALSE;
}

static void syNetRollbackFlushZombies(void)
{
    memset(sSYNetRollbackZombies, 0, sizeof(sSYNetRollbackZombies));
    memset(sSYNetRollbackFighterDObjZombies, 0, sizeof(sSYNetRollbackFighterDObjZombies));
}

static SYNetRollbackFighterDObjZombie *syNetRollbackFindFighterDObjZombie(DObj *dobj)
{
    u32 i;
    if (dobj == NULL) return NULL;
    for (i = 0; i < SYNETROLLBACK_FIGHTER_DOBJ_ZOMBIE_MAX; i++)
    {
        SYNetRollbackFighterDObjZombie *z = &sSYNetRollbackFighterDObjZombies[i];
        if ((z->active != FALSE) && (z->dobj == dobj)) return z;
    }
    return NULL;
}

sb32 syNetRollbackDeferFighterDObjEject(GObj *fighter_gobj, DObj *dobj, FTParts *parts, s32 joint_id)
{
    u32 i;
    SYNetRollbackFighterDObjZombie *z;

    if ((fighter_gobj == NULL) || (dobj == NULL) || (parts == NULL) ||
        (joint_id < 0) || (joint_id >= FTPARTS_JOINT_NUM_MAX) ||
        (syNetInputModernNetplayActive() == FALSE))
    {
        return FALSE;
    }
    z = syNetRollbackFindFighterDObjZombie(dobj);
    if (z != NULL)
    {
        z->fighter_gobj = fighter_gobj;
        z->parts = parts;
        z->joint_id = joint_id;
        z->destroy_frame = sSYNetRollbackForwardFrame;
        return TRUE;
    }
    for (i = 0; i < SYNETROLLBACK_FIGHTER_DOBJ_ZOMBIE_MAX; i++)
    {
        z = &sSYNetRollbackFighterDObjZombies[i];
        if (z->active != FALSE) continue;
        z->fighter_gobj = fighter_gobj;
        z->dobj = dobj;
        z->parts = parts;
        z->joint_id = joint_id;
        z->destroy_frame = sSYNetRollbackForwardFrame;
        z->active = TRUE;
        return TRUE;
    }
#ifdef PORT
    port_log("[NETPLAY] fighter DObj zombie pool full frame=%u player_gobj=%p joint=%d\n",
             sSYNetRollbackForwardFrame, (void *)fighter_gobj, joint_id);
#endif
    return FALSE;
}

static u32 syNetRollbackDObjTreeSig(DObj *dobj, u32 sig, s32 depth)
{
    if (depth > 48) return sig;
    for (; dobj != NULL; dobj = dobj->sib_next)
    {
        sig = (sig ^ (u32)(uintptr_t)dobj) * 16777619U;
        if (dobj->child != NULL) sig = syNetRollbackDObjTreeSig(dobj->child, sig, depth + 1);
    }
    return sig;
}

static u32 syNetRollbackFighterTreeSig(GObj *gobj)
{
    if ((gobj != NULL) && (gobj->obj_kind == nGCCommonAppendDObj) && (gobj->obj != NULL))
    {
        return syNetRollbackDObjTreeSig(DObjGetStruct(gobj), SYNETROLLBACK_FNV32_OFFSET, 0);
    }
    return SYNETROLLBACK_FNV32_OFFSET;
}

static u64 syNetRollbackFighterJointPresenceMask(const FTStruct *fp)
{
    u64 mask = 0;
    s32 joint;

    if (fp == NULL) return 0;
    for (joint = 0; joint < FTPARTS_JOINT_NUM_MAX; joint++)
    {
        if (fp->joints[joint] != NULL) mask |= (1ULL << joint);
    }
    return mask;
}

static void syNetRollbackLogTopologyChange(u32 frame, u32 slot,
                                           const SYNetRollbackFighterState *prev,
                                           const SYNetRollbackFighterState *curr)
{
#ifdef PORT
    u64 prev_mask;
    u64 curr_mask;

    if ((prev == NULL) || (curr == NULL) || (sSYNetRollbackTopologyLogCount >= 64U)) return;
    prev_mask = syNetRollbackFighterJointPresenceMask(&prev->state);
    curr_mask = syNetRollbackFighterJointPresenceMask(&curr->state);
    port_log("[NETPLAY] fighter topology change frame=%u slot=%u player=%u fkind=%d "
             "status=%d->%d motion=%d->%d gobj=%p->%p tree=%08X->%08X "
             "joints=%08X%08X->%08X%08X changed=%08X%08X\n",
             frame, slot,
             (unsigned)curr->state.player, curr->state.fkind,
             prev->state.status_id, curr->state.status_id,
             prev->state.motion_id, curr->state.motion_id,
             (void *)prev->gobj, (void *)curr->gobj,
             (unsigned)prev->tree_sig, (unsigned)curr->tree_sig,
             (unsigned)(prev_mask >> 32), (unsigned)prev_mask,
             (unsigned)(curr_mask >> 32), (unsigned)curr_mask,
             (unsigned)((prev_mask ^ curr_mask) >> 32), (unsigned)(prev_mask ^ curr_mask));
    sSYNetRollbackTopologyLogCount++;
#else
    (void)frame;
    (void)slot;
    (void)prev;
    (void)curr;
#endif
}

static u32 syNetRollbackElapsedUs(u64 begin)
{
    u64 now = port_netplay_monotonic_us();
    u64 elapsed = (now >= begin) ? (now - begin) : 0;
    return (elapsed > UINT32_MAX) ? UINT32_MAX : (u32)elapsed;
}

static void syNetRollbackSaveAObjs(SYNetRollbackSnapshot *snapshot, DObj *dobj, SYNetRollbackDObjState *state)
{
    AObj *aobj;
    u32 count = 0;

    for (aobj = dobj->aobj; (aobj != NULL) && (count < SYNETROLLBACK_AOBJ_MAX); aobj = aobj->next)
    {
        SYNetRollbackAObjState *dst = &state->aobjs[count++];
        dst->ptr = aobj;
        dst->track = aobj->track;
        dst->kind = aobj->kind;
        dst->length_invert = aobj->length_invert;
        dst->length = aobj->length;
        dst->value_base = aobj->value_base;
        dst->value_target = aobj->value_target;
        dst->rate_base = aobj->rate_base;
        dst->rate_target = aobj->rate_target;
    }
    state->aobj_count = (u8)count;
    if (aobj != NULL) snapshot->restorable = FALSE;
}

static void syNetRollbackSaveDObjTree(SYNetRollbackSnapshot *snapshot, DObj *dobj)
{
    for (; dobj != NULL; dobj = dobj->sib_next)
    {
        SYNetRollbackDObjState *state;
        u32 i;

        for (i = 0; i < snapshot->dobj_count; i++)
        {
            if (snapshot->dobjs[i].ptr == dobj) break;
        }
        if (i == snapshot->dobj_count)
        {
            if (snapshot->dobj_count >= SYNETROLLBACK_DOBJ_MAX)
            {
                snapshot->restorable = FALSE;
                return;
            }
            state = &snapshot->dobjs[snapshot->dobj_count++];
            memset(state, 0, sizeof(*state));
            state->ptr = dobj;
            state->parent_gobj = dobj->parent_gobj;
            state->sib_next = dobj->sib_next;
            state->sib_prev = dobj->sib_prev;
            state->child = dobj->child;
            state->parent = dobj->parent;
            state->translate = dobj->translate;
            state->rotate = dobj->rotate;
            state->scale = dobj->scale;
            state->flags = dobj->flags;
            state->anim_wait = dobj->anim_wait;
            state->anim_speed = dobj->anim_speed;
            state->anim_frame = dobj->anim_frame;
            state->user_data = dobj->user_data;
            syNetRollbackSaveAObjs(snapshot, dobj, state);
        }
        if (dobj->child != NULL) syNetRollbackSaveDObjTree(snapshot, dobj->child);
    }
}

static void syNetRollbackSaveGObjDObjs(SYNetRollbackSnapshot *snapshot, GObj *gobj)
{
    if ((gobj != NULL) && (gobj->obj_kind == nGCCommonAppendDObj) && (gobj->obj != NULL))
    {
        syNetRollbackSaveDObjTree(snapshot, DObjGetStruct(gobj));
    }
}

static void syNetRollbackSaveItemManager(SYNetRollbackSnapshot *snapshot)
{
    SYNetRollbackItemManagerState *state = &snapshot->item_manager;
    u32 count;

    state->appear_mapobjs_num = gITManagerAppearActor.mapobjs_num;
    state->appear_spawn_wait = gITManagerAppearActor.spawn_wait;
    state->appear_valids_num = gITManagerAppearActor.weights.valids_num;
    state->appear_weights_sum = gITManagerAppearActor.weights.weights_sum;
    state->random_valids_num = gITManagerRandomWeights.valids_num;
    state->random_weights_sum = gITManagerRandomWeights.weights_sum;

    if ((state->appear_mapobjs_num > SYNETROLLBACK_ITEM_MAPOBJ_MAX) ||
        (state->appear_valids_num > SYNETROLLBACK_ITEM_WEIGHT_MAX) ||
        (state->random_valids_num > SYNETROLLBACK_ITEM_WEIGHT_MAX))
    {
        snapshot->restorable = FALSE;
        return;
    }
    count = state->appear_mapobjs_num;
    if ((count != 0) && (gITManagerAppearActor.mapobjs != NULL))
        memcpy(state->appear_mapobjs, gITManagerAppearActor.mapobjs, count);
    count = state->appear_valids_num;
    if ((count != 0) && (gITManagerAppearActor.weights.kinds != NULL) &&
        (gITManagerAppearActor.weights.blocks != NULL))
    {
        memcpy(state->appear_kinds, gITManagerAppearActor.weights.kinds, count);
        memcpy(state->appear_blocks, gITManagerAppearActor.weights.blocks, count * sizeof(u16));
    }
    count = state->random_valids_num;
    if ((count != 0) && (gITManagerRandomWeights.kinds != NULL) && (gITManagerRandomWeights.blocks != NULL))
    {
        memcpy(state->random_kinds, gITManagerRandomWeights.kinds, count);
        memcpy(state->random_blocks, gITManagerRandomWeights.blocks, count * sizeof(u16));
    }
}

static void syNetRollbackSaveObjects(SYNetRollbackSnapshot *snapshot)
{
    GObj *gobj;

    for (gobj = gGCCommonLinks[nGCCommonLinkIDFighter]; gobj != NULL; gobj = gobj->link_next)
    {
        FTStruct *fp;
        SYNetRollbackFighterState *dst;
        if (snapshot->fighter_count >= GMCOMMON_PLAYERS_MAX)
        {
            snapshot->restorable = FALSE;
            break;
        }
        fp = ftGetStruct(gobj);
        if (fp == NULL) continue;
        dst = &snapshot->fighters[snapshot->fighter_count++];
        dst->gobj = gobj;
        dst->state = *fp;
        dst->gobj_anim_frame = gobj->anim_frame;
        dst->tree_sig = syNetRollbackFighterTreeSig(gobj);
        syNetRollbackSaveGObjDObjs(snapshot, gobj);
    }
    for (gobj = gGCCommonLinks[nGCCommonLinkIDItem]; gobj != NULL; gobj = gobj->link_next)
    {
        ITStruct *ip;
        SYNetRollbackItemState *dst;
        if (snapshot->item_count >= ITEM_ALLOC_MAX)
        {
            snapshot->restorable = FALSE;
            break;
        }
        ip = itGetStruct(gobj);
        if (ip == NULL) continue;
        dst = &snapshot->items[snapshot->item_count++];
        dst->gobj = gobj;
        dst->state = *ip;
        dst->gobj_anim_frame = gobj->anim_frame;
        dst->gobj_flags = gobj->flags;
        syNetRollbackSaveGObjDObjs(snapshot, gobj);
    }
    for (gobj = gGCCommonLinks[nGCCommonLinkIDWeapon]; gobj != NULL; gobj = gobj->link_next)
    {
        WPStruct *wp;
        SYNetRollbackWeaponState *dst;
        if (snapshot->weapon_count >= WEAPON_ALLOC_MAX)
        {
            snapshot->restorable = FALSE;
            break;
        }
        wp = wpGetStruct(gobj);
        if (wp == NULL) continue;
        dst = &snapshot->weapons[snapshot->weapon_count++];
        dst->gobj = gobj;
        dst->state = *wp;
        dst->gobj_anim_frame = gobj->anim_frame;
        dst->gobj_flags = gobj->flags;
        syNetRollbackSaveGObjDObjs(snapshot, gobj);
    }
}

static void syNetRollbackSaveMap(SYNetRollbackSnapshot *snapshot)
{
    s32 i;
    snapshot->map_bounds = gMPCollisionBounds;
    snapshot->map_update_tic = gMPCollisionUpdateTic;
    if ((gMPCollisionYakumonosNum < 0) || (gMPCollisionYakumonosNum > SYNETROLLBACK_DOBJ_MAX))
    {
        snapshot->restorable = FALSE;
        return;
    }
    snapshot->yakumono_count = (u16)gMPCollisionYakumonosNum;
    for (i = 0; i < gMPCollisionYakumonosNum; i++)
    {
        if (gMPCollisionSpeeds != NULL) snapshot->yakumono_speeds[i] = gMPCollisionSpeeds[i];
        if ((gMPCollisionYakumonoDObjs != NULL) && (gMPCollisionYakumonoDObjs->dobjs[i] != NULL))
            syNetRollbackSaveDObjTree(snapshot, gMPCollisionYakumonoDObjs->dobjs[i]);
    }
}

void syNetRollbackReset(void)
{
    memset(sSYNetRollbackSnapshots, 0, sizeof(sSYNetRollbackSnapshots));
    sSYNetRollbackResimulating = FALSE;
    sSYNetRollbackCount = 0;
    sSYNetRollbackMaxFrames = 0;
    sSYNetRollbackLateInputCount = 0;
    sSYNetRollbackSnapshotBytes = sizeof(SYNetRollbackSnapshot);
    sSYNetRollbackSnapshotEncodeUs = 0;
    sSYNetRollbackSnapshotRestoreUs = 0;
    sSYNetRollbackResimUs = 0;
    sSYNetRollbackLastHashSubmitted = UINT32_MAX;
    sSYNetRollbackTopologyEpochFrame = UINT32_MAX;
    sSYNetRollbackTopologyLogCount = 0;
    sSYNetRollbackForwardFrame = 0;
    syNetRollbackFlushZombies();
}

sb32 syNetRollbackIsResimulating(void)
{
    return sSYNetRollbackResimulating;
}

sb32 syNetRollbackSpeculationSafe(u32 confirmed_frame_count)
{
    if (sSYNetRollbackTopologyEpochFrame == UINT32_MAX) return TRUE;
    return (sSYNetRollbackTopologyEpochFrame < confirmed_frame_count) ? TRUE : FALSE;
}

static void syNetRollbackTrackTopology(u32 frame)
{
    SYNetRollbackSnapshot *curr = &sSYNetRollbackSnapshots[frame % SYNETROLLBACK_RING];
    SYNetRollbackSnapshot *prev;
    u32 i;

    if ((sSYNetRollbackResimulating != FALSE) || (frame == 0)) return;
    prev = &sSYNetRollbackSnapshots[(frame - 1U) % SYNETROLLBACK_RING];
    if ((prev->valid == FALSE) || (prev->frame != (frame - 1U))) return;
    if (prev->fighter_count != curr->fighter_count)
    {
#ifdef PORT
        if (sSYNetRollbackTopologyLogCount < 64U)
        {
            port_log("[NETPLAY] fighter topology count change frame=%u fighters=%u->%u\n",
                     frame, (unsigned)prev->fighter_count, (unsigned)curr->fighter_count);
            sSYNetRollbackTopologyLogCount++;
        }
#endif
        sSYNetRollbackTopologyEpochFrame = frame;
        return;
    }
    for (i = 0; i < curr->fighter_count; i++)
    {
        if ((prev->fighters[i].gobj != curr->fighters[i].gobj) ||
            (prev->fighters[i].tree_sig != curr->fighters[i].tree_sig))
        {
            syNetRollbackLogTopologyChange(frame, i, &prev->fighters[i], &curr->fighters[i]);
            sSYNetRollbackTopologyEpochFrame = frame;
            return;
        }
    }
}

void syNetRollbackCapturePreFrame(u32 frame)
{
    SYNetRollbackSnapshot *snapshot = &sSYNetRollbackSnapshots[frame % SYNETROLLBACK_RING];
    u64 begin = port_netplay_monotonic_us();
    CObj *camera_cobj;

    sSYNetRollbackForwardFrame = frame;
    memset(snapshot, 0, sizeof(*snapshot));
    snapshot->frame = frame;
    snapshot->valid = TRUE;
    snapshot->restorable = TRUE;
    snapshot->rng_seed = syUtilsRandSeed();
    if (gSCManagerBattleState != NULL) snapshot->battle = *gSCManagerBattleState;
    snapshot->ground = gGRCommonStruct;
    snapshot->camera = gGMCameraStruct;

    camera_cobj = (gGMCameraGObj != NULL) ? CObjGetStruct(gGMCameraGObj) : NULL;
    if (camera_cobj != NULL)
    {
        snapshot->camera_cobj.valid = TRUE;
        snapshot->camera_cobj.ptr = camera_cobj;
        snapshot->camera_cobj.vec = camera_cobj->vec;
        snapshot->camera_cobj.anim_wait = camera_cobj->anim_wait;
        snapshot->camera_cobj.anim_speed = camera_cobj->anim_speed;
        snapshot->camera_cobj.anim_frame = camera_cobj->anim_frame;
    }
    syNetRollbackSaveItemManager(snapshot);
    syNetRollbackSaveMap(snapshot);
    syNetRollbackSaveObjects(snapshot);
    syNetRollbackTrackTopology(frame);
    sSYNetRollbackSnapshotEncodeUs = syNetRollbackElapsedUs(begin);
}

static sb32 syNetRollbackSnapshotHasObject(const SYNetRollbackSnapshot *snapshot, GObj *gobj, sb32 is_weapon)
{
    u32 i;
    if (is_weapon != FALSE)
    {
        for (i = 0; i < snapshot->weapon_count; i++)
            if (snapshot->weapons[i].gobj == gobj) return TRUE;
    }
    else
    {
        for (i = 0; i < snapshot->item_count; i++)
            if (snapshot->items[i].gobj == gobj) return TRUE;
    }
    return FALSE;
}

static void syNetRollbackReconcileList(const SYNetRollbackSnapshot *snapshot, s32 link_id, sb32 is_weapon)
{
    GObj *gobj = gGCCommonLinks[link_id];
    while (gobj != NULL)
    {
        GObj *next = gobj->link_next;
        if (syNetRollbackSnapshotHasObject(snapshot, gobj, is_weapon) == FALSE)
        {
            SYNetRollbackZombie *z = syNetRollbackFindZombie(gobj);
            void *sp = (z != NULL) ? z->struct_ptr
                       : (is_weapon != FALSE ? (void *)wpGetStruct(gobj) : (void *)itGetStruct(gobj));
            if (z != NULL) z->active = FALSE;
            syNetRollbackRealEject(gobj, sp, is_weapon);
        }
        gobj = next;
    }
}

static void syNetRollbackApplyZombiePause(GObj *gobj, u32 snap_frame)
{
    SYNetRollbackZombie *z = syNetRollbackFindZombie(gobj);
    sb32 zombied = ((z != NULL) && (z->destroy_frame <= snap_frame)) ? TRUE : FALSE;
    syNetRollbackSetGObjProcsPaused(gobj, zombied);
}

static void syNetRollbackReconcileObjects(const SYNetRollbackSnapshot *snapshot)
{
    GObj *gobj;
    syNetRollbackReconcileList(snapshot, nGCCommonLinkIDItem, FALSE);
    syNetRollbackReconcileList(snapshot, nGCCommonLinkIDWeapon, TRUE);
    for (gobj = gGCCommonLinks[nGCCommonLinkIDItem]; gobj != NULL; gobj = gobj->link_next)
        syNetRollbackApplyZombiePause(gobj, snapshot->frame);
    for (gobj = gGCCommonLinks[nGCCommonLinkIDWeapon]; gobj != NULL; gobj = gobj->link_next)
        syNetRollbackApplyZombiePause(gobj, snapshot->frame);
}

static sb32 syNetRollbackFightersMatch(const SYNetRollbackSnapshot *snapshot)
{
    GObj *gobj;
    u32 i = 0;
    for (gobj = gGCCommonLinks[nGCCommonLinkIDFighter]; gobj != NULL; gobj = gobj->link_next)
    {
        if ((i >= snapshot->fighter_count) || (snapshot->fighters[i].gobj != gobj) ||
            (syNetRollbackFighterTreeSig(gobj) != snapshot->fighters[i].tree_sig)) return FALSE;
        i++;
    }
    return (i == snapshot->fighter_count) ? TRUE : FALSE;
}

static void syNetRollbackLogRestoreTopologyMismatch(const SYNetRollbackSnapshot *snapshot, u32 frame)
{
#ifdef PORT
    GObj *gobj;
    u32 i = 0;

    if ((snapshot == NULL) || (sSYNetRollbackTopologyLogCount >= 64U)) return;
    for (gobj = gGCCommonLinks[nGCCommonLinkIDFighter]; gobj != NULL; gobj = gobj->link_next, i++)
    {
        FTStruct *live_fp = ftGetStruct(gobj);
        u64 saved_mask;
        u64 live_mask;
        u32 live_sig;

        if (i >= snapshot->fighter_count)
        {
            port_log("[NETPLAY] rollback topology mismatch frame=%u slot=%u extra_live_gobj=%p\n",
                     frame, i, (void *)gobj);
            sSYNetRollbackTopologyLogCount++;
            return;
        }
        live_sig = syNetRollbackFighterTreeSig(gobj);
        if ((snapshot->fighters[i].gobj == gobj) &&
            (snapshot->fighters[i].tree_sig == live_sig)) continue;

        saved_mask = syNetRollbackFighterJointPresenceMask(&snapshot->fighters[i].state);
        live_mask = syNetRollbackFighterJointPresenceMask(live_fp);
        port_log("[NETPLAY] rollback topology mismatch frame=%u slot=%u player=%d fkind=%d "
                 "saved_status=%d live_status=%d saved_motion=%d live_motion=%d "
                 "gobj=%p/%p tree=%08X/%08X joints=%08X%08X/%08X%08X changed=%08X%08X\n",
                 frame, i,
                 (live_fp != NULL) ? (int)live_fp->player : -1,
                 (live_fp != NULL) ? live_fp->fkind : -1,
                 snapshot->fighters[i].state.status_id,
                 (live_fp != NULL) ? live_fp->status_id : -1,
                 snapshot->fighters[i].state.motion_id,
                 (live_fp != NULL) ? live_fp->motion_id : -1,
                 (void *)snapshot->fighters[i].gobj, (void *)gobj,
                 (unsigned)snapshot->fighters[i].tree_sig, (unsigned)live_sig,
                 (unsigned)(saved_mask >> 32), (unsigned)saved_mask,
                 (unsigned)(live_mask >> 32), (unsigned)live_mask,
                 (unsigned)((saved_mask ^ live_mask) >> 32), (unsigned)(saved_mask ^ live_mask));
        sSYNetRollbackTopologyLogCount++;
        return;
    }
    if (i != snapshot->fighter_count)
    {
        port_log("[NETPLAY] rollback topology mismatch frame=%u live_fighters=%u saved_fighters=%u\n",
                 frame, i, (unsigned)snapshot->fighter_count);
        sSYNetRollbackTopologyLogCount++;
    }
#else
    (void)snapshot;
    (void)frame;
#endif
}

static s32 syNetRollbackFindHiddenPartForJoint(FTStruct *fp, s32 joint_id)
{
    FTHiddenPart *hiddenparts;
    s32 i;

    if ((fp == NULL) || (fp->attr == NULL) || (joint_id < 0) || (joint_id >= FTPARTS_JOINT_NUM_MAX))
        return -1;
    hiddenparts = (FTHiddenPart *)PORT_RESOLVE(fp->attr->hiddenparts);
    if (hiddenparts == NULL) return -1;
    for (i = 0; i < 32; i++)
    {
        if (hiddenparts[i].root_joint_id == joint_id) return i;
    }
    return -1;
}

static sb32 syNetRollbackDetachHiddenPart(FTStruct *fp, s32 joint_id)
{
    DObj *root;
    s32 hiddenpart_id;

    if ((fp == NULL) || (joint_id < 0) || (joint_id >= FTPARTS_JOINT_NUM_MAX)) return FALSE;
    root = fp->joints[joint_id];
    if (root == NULL) return TRUE;
    hiddenpart_id = syNetRollbackFindHiddenPartForJoint(fp, joint_id);
    if (hiddenpart_id < 0) return FALSE;

    /* ftMainEjectHiddenPartID dereferences the parent while splicing the
     * children back into the tree. Refuse an unsafe repair rather than turn a
     * controlled rollback abort into a crash. */
    if ((root->parent == NULL) || (root->parent == DOBJ_PARENT_NULL)) return FALSE;
    ftMainEjectHiddenPartID(fp, hiddenpart_id);
    return (fp->joints[joint_id] == NULL) ? TRUE : FALSE;
}

static sb32 syNetRollbackReactivateHiddenPart(GObj *fighter_gobj, FTStruct *fp,
                                               s32 joint_id, DObj *saved_dobj)
{
    SYNetRollbackFighterDObjZombie *z;

    if ((fighter_gobj == NULL) || (fp == NULL) || (saved_dobj == NULL)) return FALSE;
    z = syNetRollbackFindFighterDObjZombie(saved_dobj);
    if ((z == NULL) || (z->fighter_gobj != fighter_gobj) || (z->joint_id != joint_id)) return FALSE;
    z->active = FALSE;
    saved_dobj->parent_gobj = fighter_gobj;
    fp->joints[joint_id] = saved_dobj;
    return TRUE;
}

static void syNetRollbackRestoreFighterDObjLinks(const SYNetRollbackSnapshot *snapshot, GObj *fighter_gobj)
{
    u32 i;
    for (i = 0; i < snapshot->dobj_count; i++)
    {
        const SYNetRollbackDObjState *state = &snapshot->dobjs[i];
        DObj *dobj;
        if ((state->ptr == NULL) || (state->parent_gobj != fighter_gobj)) continue;
        dobj = state->ptr;
        dobj->parent_gobj = state->parent_gobj;
        dobj->sib_next = state->sib_next;
        dobj->sib_prev = state->sib_prev;
        dobj->child = state->child;
        dobj->parent = state->parent;
    }
}

/* Fighter GObjs live for the whole VS match, but their hidden-part DObjs do
 * not: status changes can splice a joint in/out between the pre-frame snapshot
 * and a late-input rollback. Keep ejected joints alive for the rollback window
 * and rebuild the exact capture-time pointer topology before validating the
 * snapshot. This is deliberately limited to joints represented by the fighter
 * hidden-part table; unknown topology changes still fail closed. */
static sb32 syNetRollbackReconcileFighterTopology(const SYNetRollbackSnapshot *snapshot)
{
    GObj *gobj;
    u32 i = 0;

    if (snapshot == NULL) return FALSE;
    for (gobj = gGCCommonLinks[nGCCommonLinkIDFighter]; gobj != NULL; gobj = gobj->link_next, i++)
    {
        FTStruct *fp;
        const SYNetRollbackFighterState *saved;
        s32 joint;
        u64 changed_mask = 0;

        if ((i >= snapshot->fighter_count) || (snapshot->fighters[i].gobj != gobj)) return FALSE;
        fp = ftGetStruct(gobj);
        if (fp == NULL) return FALSE;
        saved = &snapshot->fighters[i];

        for (joint = 0; joint < FTPARTS_JOINT_NUM_MAX; joint++)
        {
            DObj *saved_dobj = saved->state.joints[joint];
            DObj *live_dobj = fp->joints[joint];

            if (saved_dobj == live_dobj) continue;
            changed_mask |= (1ULL << joint);
            if (live_dobj != NULL)
            {
                if (syNetRollbackDetachHiddenPart(fp, joint) == FALSE) return FALSE;
            }
            if (saved_dobj != NULL)
            {
                if (syNetRollbackReactivateHiddenPart(gobj, fp, joint, saved_dobj) == FALSE) return FALSE;
            }
        }
        syNetRollbackRestoreFighterDObjLinks(snapshot, gobj);
        if (syNetRollbackFighterTreeSig(gobj) != saved->tree_sig) return FALSE;
#ifdef PORT
        if ((changed_mask != 0) && (sSYNetRollbackTopologyLogCount < 64U))
        {
            port_log("[NETPLAY] fighter topology restored frame=%u slot=%u player=%u fkind=%d joints=%08X%08X\n",
                     snapshot->frame, i, (unsigned)saved->state.player, saved->state.fkind,
                     (unsigned)(changed_mask >> 32), (unsigned)changed_mask);
            sSYNetRollbackTopologyLogCount++;
        }
#endif
    }
    return (i == snapshot->fighter_count) ? TRUE : FALSE;
}

static sb32 syNetRollbackTopologyMatches(const SYNetRollbackSnapshot *snapshot)
{
    GObj *gobj;
    u32 si;

    if (syNetRollbackFightersMatch(snapshot) == FALSE) return FALSE;

    si = 0;
    for (gobj = gGCCommonLinks[nGCCommonLinkIDItem]; gobj != NULL; gobj = gobj->link_next)
    {
        while ((si < snapshot->item_count) && (snapshot->items[si].gobj != gobj)) si++;
        if (si >= snapshot->item_count) return FALSE;
        si++;
    }
    si = 0;
    for (gobj = gGCCommonLinks[nGCCommonLinkIDWeapon]; gobj != NULL; gobj = gobj->link_next)
    {
        while ((si < snapshot->weapon_count) && (snapshot->weapons[si].gobj != gobj)) si++;
        if (si >= snapshot->weapon_count) return FALSE;
        si++;
    }
    return TRUE;
}

static void syNetRollbackRestoreDObjs(const SYNetRollbackSnapshot *snapshot)
{
    u32 i;
    for (i = 0; i < snapshot->dobj_count; i++)
    {
        const SYNetRollbackDObjState *state = &snapshot->dobjs[i];
        DObj *dobj = state->ptr;
        u32 a;
        if (dobj == NULL) continue;
        dobj->parent_gobj = state->parent_gobj;
        dobj->sib_next = state->sib_next;
        dobj->sib_prev = state->sib_prev;
        dobj->child = state->child;
        dobj->parent = state->parent;
        dobj->translate = state->translate;
        dobj->rotate = state->rotate;
        dobj->scale = state->scale;
        dobj->flags = state->flags;
        dobj->anim_wait = state->anim_wait;
        dobj->anim_speed = state->anim_speed;
        dobj->anim_frame = state->anim_frame;
        dobj->user_data = state->user_data;
        for (a = 0; a < state->aobj_count; a++)
        {
            const SYNetRollbackAObjState *src = &state->aobjs[a];
            AObj *dst = src->ptr;
            if (dst == NULL) continue;
            dst->track = src->track;
            dst->kind = src->kind;
            dst->length_invert = src->length_invert;
            dst->length = src->length;
            dst->value_base = src->value_base;
            dst->value_target = src->value_target;
            dst->rate_base = src->rate_base;
            dst->rate_target = src->rate_target;
        }
    }
}

static void syNetRollbackRestoreItemManager(const SYNetRollbackSnapshot *snapshot)
{
    const SYNetRollbackItemManagerState *state = &snapshot->item_manager;
    gITManagerAppearActor.mapobjs_num = state->appear_mapobjs_num;
    gITManagerAppearActor.spawn_wait = state->appear_spawn_wait;
    gITManagerAppearActor.weights.valids_num = state->appear_valids_num;
    gITManagerAppearActor.weights.weights_sum = state->appear_weights_sum;
    gITManagerRandomWeights.valids_num = state->random_valids_num;
    gITManagerRandomWeights.weights_sum = state->random_weights_sum;
    if ((state->appear_mapobjs_num != 0) && (gITManagerAppearActor.mapobjs != NULL))
        memcpy(gITManagerAppearActor.mapobjs, state->appear_mapobjs, state->appear_mapobjs_num);
    if ((state->appear_valids_num != 0) && (gITManagerAppearActor.weights.kinds != NULL) &&
        (gITManagerAppearActor.weights.blocks != NULL))
    {
        memcpy(gITManagerAppearActor.weights.kinds, state->appear_kinds, state->appear_valids_num);
        memcpy(gITManagerAppearActor.weights.blocks, state->appear_blocks,
               state->appear_valids_num * sizeof(u16));
    }
    if ((state->random_valids_num != 0) && (gITManagerRandomWeights.kinds != NULL) &&
        (gITManagerRandomWeights.blocks != NULL))
    {
        memcpy(gITManagerRandomWeights.kinds, state->random_kinds, state->random_valids_num);
        memcpy(gITManagerRandomWeights.blocks, state->random_blocks,
               state->random_valids_num * sizeof(u16));
    }
}

static sb32 syNetRollbackRestoreSnapshot(u32 frame)
{
    SYNetRollbackSnapshot *snapshot = &sSYNetRollbackSnapshots[frame % SYNETROLLBACK_RING];
    u64 begin = port_netplay_monotonic_us();
    GObj *gobj;
    u32 i;

    if ((snapshot->valid == FALSE) || (snapshot->frame != frame) || (snapshot->restorable == FALSE))
    {
        return FALSE;
    }
    if (syNetRollbackReconcileFighterTopology(snapshot) == FALSE)
    {
        syNetRollbackLogRestoreTopologyMismatch(snapshot, frame);
        return FALSE;
    }
    if (syNetRollbackFightersMatch(snapshot) == FALSE)
    {
        syNetRollbackLogRestoreTopologyMismatch(snapshot, frame);
        return FALSE;
    }
    syNetRollbackReconcileObjects(snapshot);
    if (syNetRollbackTopologyMatches(snapshot) == FALSE) return FALSE;
    syUtilsSetRandomSeed(snapshot->rng_seed);
    if (gSCManagerBattleState != NULL) *gSCManagerBattleState = snapshot->battle;
    gGRCommonStruct = snapshot->ground;
    gGMCameraStruct = snapshot->camera;
    gMPCollisionBounds = snapshot->map_bounds;
    gMPCollisionUpdateTic = snapshot->map_update_tic;
    for (i = 0; (i < snapshot->yakumono_count) && (gMPCollisionSpeeds != NULL); i++)
        gMPCollisionSpeeds[i] = snapshot->yakumono_speeds[i];
    syNetRollbackRestoreItemManager(snapshot);

    for (i = 0; i < snapshot->fighter_count; i++)
    {
        FTStruct *fp = ftGetStruct(snapshot->fighters[i].gobj);
        if (fp != NULL) *fp = snapshot->fighters[i].state;
        snapshot->fighters[i].gobj->anim_frame = snapshot->fighters[i].gobj_anim_frame;
    }
    for (gobj = gGCCommonLinks[nGCCommonLinkIDItem]; gobj != NULL; gobj = gobj->link_next)
    {
        for (i = 0; i < snapshot->item_count; i++)
        {
            ITStruct *ip;
            if (snapshot->items[i].gobj != gobj) continue;
            ip = itGetStruct(gobj);
            if (ip != NULL) *ip = snapshot->items[i].state;
            gobj->anim_frame = snapshot->items[i].gobj_anim_frame;
            gobj->flags = snapshot->items[i].gobj_flags;
            break;
        }
    }
    for (gobj = gGCCommonLinks[nGCCommonLinkIDWeapon]; gobj != NULL; gobj = gobj->link_next)
    {
        for (i = 0; i < snapshot->weapon_count; i++)
        {
            WPStruct *wp;
            if (snapshot->weapons[i].gobj != gobj) continue;
            wp = wpGetStruct(gobj);
            if (wp != NULL) *wp = snapshot->weapons[i].state;
            gobj->anim_frame = snapshot->weapons[i].gobj_anim_frame;
            gobj->flags = snapshot->weapons[i].gobj_flags;
            break;
        }
    }
    syNetRollbackRestoreDObjs(snapshot);
    if ((snapshot->camera_cobj.valid != FALSE) && (snapshot->camera_cobj.ptr != NULL))
    {
        CObj *camera = snapshot->camera_cobj.ptr;
        camera->vec = snapshot->camera_cobj.vec;
        camera->anim_wait = snapshot->camera_cobj.anim_wait;
        camera->anim_speed = snapshot->camera_cobj.anim_speed;
        camera->anim_frame = snapshot->camera_cobj.anim_frame;
    }
    sSYNetRollbackSnapshotRestoreUs = syNetRollbackElapsedUs(begin);
    return TRUE;
}

s32 syNetRollbackHandlePredictionMismatch(u32 current_frame)
{
    u32 mismatch_frame;
	u32 rollback_frames;
	u32 frame;
	u64 begin;
	sb32 terminal_state;
	s32 decision;

	if (syNetInputConsumePredictionMismatch(&mismatch_frame) == FALSE) return FALSE;
	terminal_state = ((gSCManagerBattleState != NULL) &&
	                  ((gSCManagerBattleState->game_status == nSCBattleGameStatusEnd) ||
	                   (gSCManagerBattleState->game_status == nSCBattleGameStatusBossDefeat) ||
	                   (gSCManagerBattleState->game_status == nSCBattleGameStatusSet))) ? TRUE : FALSE;
	decision = syNetRollbackClassifyMismatch(mismatch_frame, current_frame, terminal_state, TRUE);
	if ((decision == nSYNetRollbackDecisionNone) && (terminal_state == FALSE)) return FALSE;

	/* A normal VS KO can destroy the defeated fighter GObj before the
     * GAME SET sequence has finished. Once battle state is terminal there
     * is nothing useful to resimulate: trying to restore the pre-KO object
     * topology turns a legitimate match end into a rollback desync. */
	if (terminal_state != FALSE)
    {
#ifdef PORT
        port_log("[NETPLAY] rollback skipped terminal battle frame=%u current=%u status=%u\n",
                 mismatch_frame, current_frame, gSCManagerBattleState->game_status);
#endif
        return FALSE;
    }
	rollback_frames = current_frame - mismatch_frame + 1U;
	if (decision == nSYNetRollbackDecisionAbort)
    {
        sSYNetRollbackLateInputCount++;
#ifdef PORT
        port_log("[NETPLAY] late input outside rollback window frame=%u current=%u window=%u; controlled stall/desync risk\n",
                 mismatch_frame, current_frame, SYNETROLLBACK_WINDOW);
#endif
        port_netplay_gameplay_abort_desync(mismatch_frame, current_frame, 1);
        return -1;
    }
	if ((syNetRollbackRestoreSnapshot(mismatch_frame) == FALSE) &&
	    (syNetRollbackClassifyMismatch(mismatch_frame, current_frame, FALSE, FALSE) ==
	     nSYNetRollbackDecisionAbort))
    {
        sSYNetRollbackLateInputCount++;
#ifdef PORT
        port_log("[NETPLAY] rollback snapshot unavailable frame=%u current=%u topology_changed=1\n",
                 mismatch_frame, current_frame);
#endif
        port_netplay_gameplay_abort_desync(mismatch_frame, current_frame, 2);
        return -1;
    }

    begin = port_netplay_monotonic_us();
    sSYNetRollbackResimulating = TRUE;
    syNetInputPrepareResimulation(mismatch_frame);
    for (frame = mismatch_frame; frame <= current_frame; frame++)
    {
        syNetRollbackCapturePreFrame(frame);
        syNetInputPublishResimulationFrame(frame);
        ifCommonBattleUpdateInterfaceAll();
        if ((frame % SYNETROLLBACK_HASH_INTERVAL) == 0U)
        {
            SYNetRollbackSnapshot *snapshot = &sSYNetRollbackSnapshots[frame % SYNETROLLBACK_RING];
            syNetSyncComputeDeterministicDigest(frame, &snapshot->post_digest);
            snapshot->post_hash = snapshot->post_digest.total_hash;
            snapshot->hash_valid = TRUE;
        }
    }
    sSYNetRollbackResimulating = FALSE;
    sSYNetRollbackResimUs = syNetRollbackElapsedUs(begin);
    sSYNetRollbackCount++;
    if (rollback_frames > sSYNetRollbackMaxFrames) sSYNetRollbackMaxFrames = rollback_frames;
#ifdef PORT
    port_log("[NETPLAY] rollback frame=%u current=%u frames=%u restore_us=%u resim_us=%u snapshot_bytes=%u\n",
             mismatch_frame, current_frame, rollback_frames, sSYNetRollbackSnapshotRestoreUs,
             sSYNetRollbackResimUs, sSYNetRollbackSnapshotBytes);
#endif
    return TRUE;
}

void syNetRollbackPostFrame(u32 frame)
{
    SYNetRollbackSnapshot *snapshot = &sSYNetRollbackSnapshots[frame % SYNETROLLBACK_RING];
    u32 zi;

    for (zi = 0; zi < SYNETROLLBACK_ZOMBIE_MAX; zi++)
    {
        SYNetRollbackZombie *z = &sSYNetRollbackZombies[zi];
        if ((z->active != FALSE) && ((z->destroy_frame + SYNETROLLBACK_WINDOW) < frame))
        {
            syNetRollbackRealEject(z->gobj, z->struct_ptr, z->is_weapon);
            z->active = FALSE;
        }
    }
    for (zi = 0; zi < SYNETROLLBACK_FIGHTER_DOBJ_ZOMBIE_MAX; zi++)
    {
        SYNetRollbackFighterDObjZombie *z = &sSYNetRollbackFighterDObjZombies[zi];
        if ((z->active != FALSE) && ((z->destroy_frame + SYNETROLLBACK_WINDOW) < frame))
        {
            if (z->parts != NULL) ftManagerSetPrevPartsAlloc(z->parts);
            if (z->dobj != NULL) gcEjectDObj(z->dobj);
            z->active = FALSE;
        }
    }

    if ((frame % SYNETROLLBACK_HASH_INTERVAL) == 0U && snapshot->valid != FALSE && snapshot->frame == frame)
    {
        syNetSyncComputeDeterministicDigest(frame, &snapshot->post_digest);
        snapshot->post_hash = snapshot->post_digest.total_hash;
        snapshot->hash_valid = TRUE;
    }

    if (frame >= SYNETROLLBACK_WINDOW)
    {
        u32 confirmed_frame = frame - SYNETROLLBACK_WINDOW;
        SYNetRollbackSnapshot *confirmed = &sSYNetRollbackSnapshots[confirmed_frame % SYNETROLLBACK_RING];
        if ((confirmed_frame % SYNETROLLBACK_HASH_INTERVAL) == 0U &&
            confirmed->valid != FALSE && confirmed->frame == confirmed_frame && confirmed->hash_valid != FALSE &&
            sSYNetRollbackLastHashSubmitted != confirmed_frame)
        {
#ifdef PORT
            PortNetplayStateDigest wire_digest = {0};
            s32 player;
#endif
#ifdef PORT
            port_log("[NETPLAY][DET] HASH frame=%u total=%08X%08X rng=%08X%08X battle=%08X%08X "
                     "p1=%08X%08X p2=%08X%08X p3=%08X%08X p4=%08X%08X "
                     "stage=%08X%08X map=%08X%08X items=%08X%08X weapons=%08X%08X counts=%u/%u\n",
                     confirmed_frame,
                     (u32)(confirmed->post_digest.total_hash >> 32), (u32)confirmed->post_digest.total_hash,
                     (u32)(confirmed->post_digest.rng_hash >> 32), (u32)confirmed->post_digest.rng_hash,
                     (u32)(confirmed->post_digest.battle_hash >> 32), (u32)confirmed->post_digest.battle_hash,
                     (u32)(confirmed->post_digest.fighter_hash[0] >> 32), (u32)confirmed->post_digest.fighter_hash[0],
                     (u32)(confirmed->post_digest.fighter_hash[1] >> 32), (u32)confirmed->post_digest.fighter_hash[1],
                     (u32)(confirmed->post_digest.fighter_hash[2] >> 32), (u32)confirmed->post_digest.fighter_hash[2],
                     (u32)(confirmed->post_digest.fighter_hash[3] >> 32), (u32)confirmed->post_digest.fighter_hash[3],
                     (u32)(confirmed->post_digest.stage_hash >> 32), (u32)confirmed->post_digest.stage_hash,
                     (u32)(confirmed->post_digest.map_hash >> 32), (u32)confirmed->post_digest.map_hash,
                     (u32)(confirmed->post_digest.item_hash >> 32), (u32)confirmed->post_digest.item_hash,
                     (u32)(confirmed->post_digest.weapon_hash >> 32), (u32)confirmed->post_digest.weapon_hash,
                     confirmed->post_digest.item_count, confirmed->post_digest.weapon_count);

            wire_digest.frame = confirmed_frame;
#define SYNETROLLBACK_SET_WIRE_HASH(index, value) \
            do { \
                wire_digest.hash_high[(index)] = (u32)((value) >> 32); \
                wire_digest.hash_low[(index)] = (u32)(value); \
            } while (0)
            SYNETROLLBACK_SET_WIRE_HASH(PORT_NETPLAY_DIGEST_TOTAL, confirmed->post_digest.total_hash);
            SYNETROLLBACK_SET_WIRE_HASH(PORT_NETPLAY_DIGEST_RNG, confirmed->post_digest.rng_hash);
            SYNETROLLBACK_SET_WIRE_HASH(PORT_NETPLAY_DIGEST_BATTLE, confirmed->post_digest.battle_hash);
            SYNETROLLBACK_SET_WIRE_HASH(PORT_NETPLAY_DIGEST_FIGHTER0, confirmed->post_digest.fighter_hash[0]);
            SYNETROLLBACK_SET_WIRE_HASH(PORT_NETPLAY_DIGEST_FIGHTER1, confirmed->post_digest.fighter_hash[1]);
            SYNETROLLBACK_SET_WIRE_HASH(PORT_NETPLAY_DIGEST_FIGHTER2, confirmed->post_digest.fighter_hash[2]);
            SYNETROLLBACK_SET_WIRE_HASH(PORT_NETPLAY_DIGEST_FIGHTER3, confirmed->post_digest.fighter_hash[3]);
            SYNETROLLBACK_SET_WIRE_HASH(PORT_NETPLAY_DIGEST_STAGE, confirmed->post_digest.stage_hash);
            SYNETROLLBACK_SET_WIRE_HASH(PORT_NETPLAY_DIGEST_MAP, confirmed->post_digest.map_hash);
            SYNETROLLBACK_SET_WIRE_HASH(PORT_NETPLAY_DIGEST_ITEMS, confirmed->post_digest.item_hash);
            SYNETROLLBACK_SET_WIRE_HASH(PORT_NETPLAY_DIGEST_WEAPONS, confirmed->post_digest.weapon_hash);
#undef SYNETROLLBACK_SET_WIRE_HASH
            wire_digest.rng_seed = confirmed->post_digest.rng_seed;
            wire_digest.item_count = confirmed->post_digest.item_count;
            wire_digest.weapon_count = confirmed->post_digest.weapon_count;
            for (player = 0; player < GMCOMMON_PLAYERS_MAX; player++)
            {
                wire_digest.fighter_status[player] = confirmed->post_digest.fighter_status[player];
                wire_digest.fighter_motion[player] = confirmed->post_digest.fighter_motion[player];
                wire_digest.fighter_damage[player] = confirmed->post_digest.fighter_damage[player];
                wire_digest.fighter_stock[player] = confirmed->post_digest.fighter_stock[player];
                wire_digest.fighter_pos_x_bits[player] = confirmed->post_digest.fighter_pos_x_bits[player];
                wire_digest.fighter_pos_y_bits[player] = confirmed->post_digest.fighter_pos_y_bits[player];
                wire_digest.fighter_vel_x_bits[player] = confirmed->post_digest.fighter_vel_x_bits[player];
                wire_digest.fighter_vel_y_bits[player] = confirmed->post_digest.fighter_vel_y_bits[player];
            }
            port_netplay_submit_state_digest(&wire_digest);
#endif
            sSYNetRollbackLastHashSubmitted = confirmed_frame;
        }
    }
}

u32 syNetRollbackGetCount(void) { return sSYNetRollbackCount; }
u32 syNetRollbackGetMaxFrames(void) { return sSYNetRollbackMaxFrames; }
u32 syNetRollbackGetLateInputCount(void) { return sSYNetRollbackLateInputCount; }
u32 syNetRollbackGetSnapshotBytes(void) { return sSYNetRollbackSnapshotBytes; }
u32 syNetRollbackGetSnapshotEncodeUs(void) { return sSYNetRollbackSnapshotEncodeUs; }
u32 syNetRollbackGetSnapshotRestoreUs(void) { return sSYNetRollbackSnapshotRestoreUs; }
u32 syNetRollbackGetResimUs(void) { return sSYNetRollbackResimUs; }
