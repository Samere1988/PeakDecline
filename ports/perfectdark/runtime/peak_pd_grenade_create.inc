/* v3 reserves only unused native slots and existing model RW cache storage.
 * Preflight never allocates, evicts, initializes a model or changes a counter. */
#include "game/modelmgr.h"
extern struct modelrwdatabinding *g_ModelRwdataBindings[3];
static int grenadeCreation, grenadeCreateCount, grenadeBirthSet[PEAK_GRENADE_MAX];
static u32 grenadeAllocationNext, grenadeProjectedNext;
static int grenadeAllocationState, grenadeAllocationWeapon;
static double grenadeBirth[PEAK_GRENADE_MAX][6];
static struct weaponobj *grenadeNewWeapons[PEAK_GRENADE_MAX];
static struct projectile *grenadeNewProjectiles[PEAK_GRENADE_MAX];
static struct model *grenadeNewModels[PEAK_GRENADE_MAX];
static struct modelrwdatabinding *grenadeNewBindings[PEAK_GRENADE_MAX];
static void cancelGrenadeCreation(void)
{
    grenadeCreation = 0; grenadeCreateCount = 0;
    memset(grenadeBirthSet, 0, sizeof(grenadeBirthSet));
    memset(grenadeNewWeapons, 0, sizeof(grenadeNewWeapons));
}
EMSCRIPTEN_KEEPALIVE double peakPdAllocationField(int field)
{
    if (!g_PeakPdReady || busy || poseCount) return -1;
    return field == 0 ? nextEntityId : field == 1 ? g_Vars.allocstateindex : field == 2 ? g_NextWeaponSlot : -1;
}
EMSCRIPTEN_KEEPALIVE double peakPdGrenadeBirth(u32 id, int field)
{
    struct prop *p = grenadeAt(id);
    if (busy || poseCount || !p || !grenadeSupported(p)) return NAN;
    struct weaponobj *w = p->weapon;
    const double values[] = {w->unk5d, w->unk5e, w->dualweaponnum, w->base.model->scale,
        w->base.projectile->obj == &w->base, w->base.pad};
    return field >= 0 && field < 6 ? values[field] : NAN;
}
EMSCRIPTEN_KEEPALIVE int peakPdGrenadeBeginV3(int count, u32 next, int state, int weapon)
{
    if (!poseCount || poseFailed || !randomStaged || !smokeRequired || grenadeRequired
            || count < 0 || count > PEAK_GRENADE_MAX || peakPdGrenadeCount() < 0
            || next < nextEntityId || next == 0xffffffffU || state < 0 || state >= g_Vars.numpropstates
            || weapon < 0 || weapon >= g_MaxWeaponSlots) return rejectPose();
    grenadeRequired = 1; grenadeRemovals = 1; grenadeCreation = 1; grenadeCount = count;
    grenadeAllocationNext = next; grenadeAllocationState = state; grenadeAllocationWeapon = weapon;
    return 1;
}
EMSCRIPTEN_KEEPALIVE int peakPdGrenadeBirthStage(int index, double a, double b, double dual, double scale, double self, double pad)
{
    if (!grenadeCreation || poseFailed || index < 0 || index >= grenadeCount || grenadeBirthSet[index]
            || !isfinite(a) || a != trunc(a) || a < 0 || a > 255 || !isfinite(b) || b != trunc(b) || b < 0 || b > 255
            || dual != -1 || !isfinite(scale) || scale <= 0 || scale > 1000 || (self != 0 && self != 1) || pad != -1) return rejectPose();
    double values[] = {a,b,dual,scale,self,pad};
    memcpy(grenadeBirth[index], values, sizeof(values)); grenadeBirthSet[index] = 1; return 1;
}
static struct prop *grenadePending(u32 id)
{
    if (grenadeCreation) for (int i = 0; i < grenadeCount; ++i)
        if (grenadeNewWeapons[i] && grenadeIds[i] == id) return grenadeProps[i];
    return NULL;
}
static int reserveGrenadeCreates(void)
{
    grenadeProjectedNext = nextEntityId; grenadeCreateCount = 0;
    if (!grenadeCreation) return 1;
    if (IS4MB() || !g_ModelRwdataBindings[1]) return 0;
    // Rebuild reservations on every validation attempt; never treat an earlier
    // uncommitted free-prop reservation as an already-existing weapon.
    memset(grenadeNewWeapons, 0, sizeof(grenadeNewWeapons));
    for (int i = 0; i < grenadeCount; ++i) grenadeProps[i] = grenadeAt(grenadeIds[i]);
    struct prop *freeprop = g_Vars.freeprops;
    struct modeldef *def = g_ModelStates[MODEL_CHRGRENADE].modeldef;
    int weaponIndex = 0, projectileIndex = 0, modelIndex = 0, bindingIndex = 0;
    for (int i = 0; i < grenadeCount; ++i) {
        if (!grenadeBirthSet[i] || grenadeNext[i] != PEAK_GRENADE_FIELD_COUNT) return 0;
        if (grenadeProps[i]) {
            struct weaponobj *w = grenadeProps[i]->weapon;
            double expected[] = {w->unk5d,w->unk5e,w->dualweaponnum,w->base.model->scale,w->base.projectile->obj == &w->base,w->base.pad};
            if (memcmp(expected,grenadeBirth[i],sizeof(expected))) return 0;
            continue;
        }
        double *f = grenadeFields[i];
        // Only an ordinary thrown grenade with already loaded, geometry-free
        // assets. Armed proximity registration and custom object flags need a
        // broader codec; they must not be inferred from arbitrary input bits.
        if (!def || def->rwdatalen < 0 || def->rwdatalen > 52
                || modelGetPartRodata(def, MODELPART_BASIC_0065) || modelGetPartRodata(def, MODELPART_BASIC_0066)
                || f[0] != MODEL_CHRGRENADE || f[1] != 256 || f[2] != OBJFLAG_FALL || f[3] || f[4] || f[6]
                || ((u32)f[5] & 0x0fffffffU) != OBJHFLAG_PROJECTILE || f[9] != WEAPON_GRENADE
                || f[10] > 1 || f[12] || f[13] || f[34] || f[44] || f[45] != 1000 || f[55] < 2
                || f[8] >= g_Vars.numpropstates || !((u32)f[33] & PROPFLAG_ENABLED)
                || !((u32)f[7] & PROJECTILEFLAG_AIRBORNE)
                || ((u32)f[7] & ~(PROJECTILEFLAG_AIRBORNE | PROJECTILEFLAG_00000002 | PROJECTILEFLAG_STICKY | PROJECTILEFLAG_INROOM))
                || grenadeIds[i] <= grenadeProjectedNext || grenadeIds[i] > grenadeAllocationNext) return 0;
        struct prop *owner = grenadeAt((u32)f[11]);
        if (!owner || owner->type != PROPTYPE_PLAYER) return 0;
        int ownerSlot = -1;
        for (int slot = 0; slot < 4; ++slot) if (g_Vars.players[slot] && g_Vars.players[slot]->prop == owner) ownerSlot = slot;
        if (ownerSlot < 0 || ((u32)f[5] >> 28) != (u32)ownerSlot) return 0;
        while (weaponIndex < g_MaxWeaponSlots && g_WeaponSlots[weaponIndex].base.prop) ++weaponIndex;
        while (projectileIndex < g_MaxProjectiles && !(g_Projectiles[projectileIndex].flags & PROJECTILEFLAG_FREE)) ++projectileIndex;
        while (modelIndex < g_MaxModels && g_ModelSlots[modelIndex].definition) ++modelIndex;
        // Type-2 cache contains 25 slots on this 8MB controlled web build.
        while (bindingIndex < 25 && (g_ModelRwdataBindings[1][bindingIndex].model || !g_ModelRwdataBindings[1][bindingIndex].rwdata)) ++bindingIndex;
        if (!freeprop || weaponIndex == g_MaxWeaponSlots || projectileIndex == g_MaxProjectiles
                || modelIndex == g_MaxModels || bindingIndex == 25) return 0;
        grenadeProps[i] = freeprop; freeprop = freeprop->next;
        grenadeNewWeapons[i] = &g_WeaponSlots[weaponIndex++];
        grenadeNewProjectiles[i] = &g_Projectiles[projectileIndex++];
        grenadeNewModels[i] = &g_ModelSlots[modelIndex++];
        grenadeNewBindings[i] = &g_ModelRwdataBindings[1][bindingIndex++];
        grenadeProjectedNext = grenadeIds[i]; ++grenadeCreateCount;
    }
    return 1;
}
static int grenadeCreationCapacity(int freeCount, int smokeAdded, int smokeRemoved)
{
    if (!grenadeCreation) return 1;
    for (int i = 0; i < grenadeCount; ++i) if (grenadeNewWeapons[i]) {
        int found = 0;
        for (int j = 0; j < smokeOrderCount; ++j) if (smokeOrder[j] == grenadeIds[i]) ++found;
        if (found != 1) return 0;
    }
    return grenadeCreateCount + smokeAdded <= freeCount + smokeRemoved
        && (u64)grenadeProjectedNext + smokeAdded <= grenadeAllocationNext;
}
static void createGrenades(void)
{
    if (!grenadeCreation) return;
    for (int i = 0; i < grenadeCount; ++i) if (grenadeNewWeapons[i]) {
        double *f = grenadeFields[i], *birth = grenadeBirth[i];
        nextEntityId = grenadeIds[i] - 1;
        struct prop *p = propAllocate(); // Reserved head of the untouched free list.
        struct weaponobj *w = grenadeNewWeapons[i]; struct defaultobj *o = &w->base;
        struct projectile *q = grenadeNewProjectiles[i]; struct model *model = grenadeNewModels[i];
        memset(w, 0, sizeof(*w)); memset(q, 0, sizeof(*q));
        grenadeNewBindings[i]->model = model; model->anim = NULL;
        modelInit(model,g_ModelStates[MODEL_CHRGRENADE].modeldef,grenadeNewBindings[i]->rwdata,false);
        model->rwdatalen = 52; model->scale = birth[3]; model->obj = o; model->unk01 = 0;
        o->model = model; o->prop = p; o->type = OBJTYPE_WEAPON; o->pad = -1;
        o->modelnum = f[0]; o->extrascale = f[1]; o->flags = f[2]; o->hidden = f[5];
        o->projectile = q; o->maxdamage = 1000;
        w->weaponnum = WEAPON_GRENADE; w->gunfunc = f[10]; w->unk5d = birth[0]; w->unk5e = birth[1]; w->dualweaponnum = -1;
        q->flags = f[7]; q->ownerprop = grenadeAt((u32)f[11]); q->obj = birth[4] ? o : NULL; q->unk060 = 1;
        p->type = PROPTYPE_WEAPON; p->weapon = w; p->flags = f[33];
        g_Vars.propstates[p->propstateindex].propcount--; p->propstateindex = f[8];
        g_Vars.propstates[p->propstateindex].propcount++;
        objInitToggleNodes(o); weaponSetGunfireVisible(p,false,-1);
        propActivate(p);
    }
}
static void applyGrenadeAllocation(void)
{
    if (!grenadeCreation) return;
    nextEntityId = grenadeAllocationNext;
    g_Vars.allocstateindex = grenadeAllocationState; g_NextWeaponSlot = grenadeAllocationWeapon;
}
