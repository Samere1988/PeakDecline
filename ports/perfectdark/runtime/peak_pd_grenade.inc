/* Typed airborne grenade correction. Versioned extensions add removal and
 * reserved-slot creation; assets and pointers always remain local. */
static const struct projectile *componentProjectile(const struct defaultobj *obj);
#include "game/propobj.h"
#include "peak_pd_grenade_fields.inc"
#define PEAK_GRENADE_MAX 32
static int grenadeRemovals, grenadeRemoveCount;
static struct prop *grenadeRemoveProps[PEAK_GRENADE_MAX];
static int grenadeRequired, grenadeCount, grenadeNext[PEAK_GRENADE_MAX];
static u32 grenadeIds[PEAK_GRENADE_MAX];
static double grenadeFields[PEAK_GRENADE_MAX][PEAK_GRENADE_FIELD_COUNT];
static struct prop *grenadeProps[PEAK_GRENADE_MAX];
static void cancelGrenadeCreation(void);
static void cancelGrenades(void) { cancelGrenadeCreation(); grenadeRemovals = 0; grenadeRemoveCount = 0; grenadeRequired = 0; grenadeCount = 0; memset(grenadeNext, 0, sizeof(grenadeNext)); }
static u32 grenadeReference(struct prop *p)
{
    if (!p) return 0;
    for (int i = 0; i < entityCapacity; ++i) if (&g_Vars.props[i] == p) return entityIds[i] ? entityIds[i] : 0xffffffffU;
    return 0xffffffffU;
}
static int isGrenade(struct prop *p)
{
    return p->type == PROPTYPE_WEAPON && p->weapon && p->weapon->base.type == OBJTYPE_WEAPON
        && p->weapon->weaponnum == WEAPON_GRENADE && (p->obj->hidden & (OBJHFLAG_PROJECTILE | OBJHFLAG_EMBEDDED));
}
static int grenadeSupported(struct prop *p)
{
    if (!isGrenade(p) || !p->active || !(p->flags & PROPFLAG_ENABLED) || p->parent || p->child
            || p->opawallhits || p->xluwallhits || (p->obj->hidden & OBJHFLAG_EMBEDDED)
            || !p->obj->model || !p->obj->projectile || p->weapon->dualweapon || p->weapon->timer240 < 1) return 0;
    struct projectile *q = p->obj->projectile;
    return (q->flags & PROJECTILEFLAG_AIRBORNE) && !(q->flags & (PROJECTILEFLAG_FREE | PROJECTILEFLAG_LAUNCHING
        | PROJECTILEFLAG_POWERED | PROJECTILEFLAG_00000020 | PROJECTILEFLAG_FALLING | PROJECTILEFLAG_SLIDING))
        && q->unk060 == 1 && (!q->obj || q->obj == p->obj)
        && grenadeReference(q->ownerprop) != 0xffffffffU && !q->targetprop && !q->pickupby;
}
static struct prop *grenadeAt(u32 id)
{
    for (int i = 0; i < entityCapacity; ++i) if (entityIds[i] == id && id) return &g_Vars.props[i];
    return NULL;
}
EMSCRIPTEN_KEEPALIVE int peakPdGrenadeCount(void);
#include "peak_pd_grenade_create.inc"
EMSCRIPTEN_KEEPALIVE int peakPdGrenadeCount(void)
{
    if (!g_PeakPdControlled || !g_PeakPdReady || busy) return -1;
    int count = 0;
    for (int i = 0; i < entityCapacity; ++i) if (entityIds[i] && isGrenade(&g_Vars.props[i])) {
        if (!grenadeSupported(&g_Vars.props[i]) || ++count > PEAK_GRENADE_MAX) return -1;
    }
    return count;
}
EMSCRIPTEN_KEEPALIVE double peakPdGrenadeId(int index)
{
    if (poseCount || index < 0 || peakPdGrenadeCount() < 0) return 0;
    for (int i = 0; i < entityCapacity; ++i) if (entityIds[i] && isGrenade(&g_Vars.props[i]) && index-- == 0) return entityIds[i];
    return 0;
}
static double grenadeRead(struct prop *p, int field)
{
    struct defaultobj *o = p->obj; struct weaponobj *w = p->weapon; struct projectile *q = o->projectile;
    if (field >= PEAK_GRENADE_ROOM_START && field < PEAK_GRENADE_ROOM_START + 8)
        for (int i = 0; i <= field - PEAK_GRENADE_ROOM_START; ++i) if (p->rooms[i] == -1) return -1;
    switch (field) {
#define GRENADE_READ(i, member, integer, low, high, write) case i: return member;
        PEAK_GRENADE_FIELDS(GRENADE_READ)
#undef GRENADE_READ
    default: return NAN;
    }
}
EMSCRIPTEN_KEEPALIVE double peakPdGrenadeField(u32 id, int field)
{
    struct prop *p = grenadeAt(id);
    return !poseCount && !busy && p && grenadeSupported(p) ? grenadeRead(p, field) : NAN;
}
EMSCRIPTEN_KEEPALIVE int peakPdGrenadeBegin(int count)
{
    if (!poseCount || poseFailed || !randomStaged || !smokeRequired || grenadeRequired
            || count < 0 || count > PEAK_GRENADE_MAX || count != peakPdGrenadeCount()) return rejectPose();
    grenadeRequired = 1; grenadeCount = count; return 1;
}
// v2 permits removing extra supported grenades. Missing authoritative entities
// still reject; no creation or identity remapping is implied.
EMSCRIPTEN_KEEPALIVE int peakPdGrenadeBeginV2(int count)
{
    int local = peakPdGrenadeCount();
    if (!poseCount || poseFailed || !randomStaged || !smokeRequired || grenadeRequired
            || count < 0 || count > PEAK_GRENADE_MAX || local < count) return rejectPose();
    grenadeRequired = 1; grenadeRemovals = 1; grenadeCount = count; return 1;
}
static int grenadeWillRemove(struct prop *p)
{
    for (int i = 0; i < grenadeRemoveCount; ++i) if (grenadeRemoveProps[i] == p) return 1;
    return 0;
}
EMSCRIPTEN_KEEPALIVE int peakPdGrenadeStage(int index, u32 id, int field, double value)
{
    if (!grenadeRequired || poseFailed || busy || index < 0 || index >= grenadeCount
            || field != grenadeNext[index] || !isfinite(value)) return rejectPose();
    struct prop *p = grenadeAt(id);
    if ((p && !grenadeSupported(p)) || (!p && !grenadeCreation)) return rejectPose();
    if (!field) {
        for (int i = 0; i < grenadeCount; ++i) if (grenadeNext[i] && grenadeIds[i] == id) return rejectPose();
        grenadeIds[index] = id; grenadeProps[index] = p;
    } else if (grenadeIds[index] != id) return rejectPose();
    switch (field) {
#define GRENADE_VALIDATE(i, member, integer, low, high, write) case i: \
        if (value < (double)(low) || value > (double)(high) || ((integer) && value != trunc(value)) \
            || (!(write) && p && value != grenadeRead(p, field))) return rejectPose(); break;
        PEAK_GRENADE_FIELDS(GRENADE_VALIDATE)
#undef GRENADE_VALIDATE
    default: return rejectPose();
    }
    grenadeFields[index][field] = value; ++grenadeNext[index]; return 1;
}
static int grenadesValid(void)
{
    if (!grenadeRequired) return 1;
    int local = peakPdGrenadeCount();
    if (local < 0 || (!grenadeCreation && local < grenadeCount) || (!grenadeRemovals && local != grenadeCount)) return 0;
    grenadeRemoveCount = 0;
    for (int index = 0; index < grenadeCount; ++index) {
        if (grenadeNext[index] != PEAK_GRENADE_FIELD_COUNT) return 0;
        int ended = 0;
        for (int j = 0; j < 8; ++j) {
            double room = grenadeFields[index][PEAK_GRENADE_ROOM_START + j];
            if (room == -1) ended = 1;
            else {
                if (ended || room >= g_Vars.roomcount) return 0;
                for (int k = 0; k < j; ++k) if (grenadeFields[index][PEAK_GRENADE_ROOM_START + k] == room) return 0;
            }
        }
        if (!ended || grenadeFields[index][PEAK_GRENADE_ROOM_START] < 0) return 0;
    }
    if (!reserveGrenadeCreates()) return 0;
    if (grenadeRemovals) for (int i = 0; i < entityCapacity; ++i) {
        struct prop *p = &g_Vars.props[i];
        if (!entityIds[i] || !isGrenade(p)) continue;
        int keep = 0;
        for (int j = 0; j < grenadeCount; ++j) if (grenadeProps[j] == p) keep = 1;
        if (!keep) {
            if (!grenadeSupported(p) || grenadeRemoveCount == PEAK_GRENADE_MAX) return 0;
            grenadeRemoveProps[grenadeRemoveCount++] = p;
        }
    }
    // A surviving projectile may not retain a reference to a removed prop.
    // These dependencies need their own typed correction before deletion.
    if (grenadeRemoveCount) for (int i = 0; i < entityCapacity; ++i) {
        struct prop *p = &g_Vars.props[i];
        if (!entityIds[i] || grenadeWillRemove(p) || (p->type != PROPTYPE_OBJ
                && p->type != PROPTYPE_WEAPON && p->type != PROPTYPE_DOOR)) continue;
        const struct projectile *q = componentProjectile(p->obj);
        if (q && (grenadeWillRemove(q->ownerprop) || grenadeWillRemove(q->targetprop)
                || grenadeWillRemove(q->pickupby))) return 0;
    }
    return 1;
}
static void applyGrenades(void)
{
    if (!grenadeRequired) return;
    createGrenades();
    for (int i = 0; i < grenadeRemoveCount; ++i) objFreePermanently(grenadeRemoveProps[i]->obj, true);
    for (int index = 0; index < grenadeCount; ++index) {
        struct prop *p = grenadeProps[index]; struct defaultobj *o = p->obj;
        struct weaponobj *w = p->weapon; struct projectile *q = o->projectile;
        propDeregisterRooms(p);
#define GRENADE_WRITE_0(member, value)
#define GRENADE_WRITE_1(member, value) member = value;
#define GRENADE_WRITE(i, member, integer, low, high, write) GRENADE_WRITE_##write(member, grenadeFields[index][i])
        PEAK_GRENADE_FIELDS(GRENADE_WRITE)
#undef GRENADE_WRITE
#undef GRENADE_WRITE_0
#undef GRENADE_WRITE_1
        // Rebuild only derived local collision geometry. The ordinary movement
        // helper also triggers proximity mines and must not run during restore.
        func0f069c1c(o);
        propRegisterRooms(p);
    }
}
