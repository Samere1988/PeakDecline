/* Smoke with independent or stable-ID prop sources. No source pointers or foreign entity
 * IDs are imported. All staging and capacity checks precede any mutation. */
#include "peak_pd_smoke_fields.inc"
#define PEAK_SMOKE_MAX 32
#define PEAK_SMOKE_ORDER_MAX 4096
static int smokeRequired, smokeOrderCount, smokeOrderNext, smokePlayer;
static int smokeNext[PEAK_SMOKE_MAX];
static int smokeSourceRequired, smokeSourceSet[PEAK_SMOKE_MAX];
static u32 smokeSources[PEAK_SMOKE_MAX];
static struct prop *smokeSourceProps[PEAK_SMOKE_MAX];
static double smokeFields[PEAK_SMOKE_MAX][PEAK_SMOKE_FIELDS_COUNT];
static double smokeOrder[PEAK_SMOKE_ORDER_MAX];
static struct prop *smokeResolved[PEAK_SMOKE_ORDER_MAX];
static void cancelSmoke(void) { smokeRequired = 0; smokeSourceRequired = 0; memset(smokeSourceSet, 0, sizeof(smokeSourceSet)); smokeOrderNext = 0; memset(smokeNext, 0, sizeof(smokeNext)); }
static int smokeSlot(struct prop *p)
{
    for (int i = 0; i < g_MaxSmokes; ++i) if (g_Smokes[i].prop == p) return i;
    return -1;
}
static u32 smokeSourceId(const struct smoke *s)
{
    if (!s->source) return 0;
    if (s->option) return 0xffffffffU; // Pad effects require their own typed references.
    for (int i = 0; i < entityCapacity; ++i)
        if (&g_Vars.props[i] == s->sourceprop && entityIds[i] && g_Vars.props[i].type != PROPTYPE_SMOKE)
            return entityIds[i];
    return 0xffffffffU;
}
static int smokeSupported(void)
{
    if (!g_PeakPdControlled || !g_PeakPdReady || busy || g_MaxSmokes < 0 || g_MaxSmokes > PEAK_SMOKE_MAX) return 0;
    for (int i = 0; i < g_MaxSmokes; ++i) {
        struct smoke *s = &g_Smokes[i]; struct prop *p = s->prop;
        if (p && (smokeSourceId(s) == 0xffffffffU || s->type > 22 || !p->active || !(p->flags & PROPFLAG_ENABLED)
                || p->type != PROPTYPE_SMOKE || p->smoke != s || p->parent || p->child
                || p->opawallhits || p->xluwallhits)) return 0;
    }
    return 1;
}
EMSCRIPTEN_KEEPALIVE int peakPdSmokePlayer(void) { return !poseCount && smokeSupported() ? g_Vars.currentplayernum : -1; }
EMSCRIPTEN_KEEPALIVE int peakPdSmokeCapacity(void) { return !poseCount && smokeSupported() ? g_MaxSmokes : -1; }
EMSCRIPTEN_KEEPALIVE double peakPdSmokeSource(int slot)
{
    if (poseCount || !smokeSupported() || slot < 0 || slot >= g_MaxSmokes) return -1;
    return g_Smokes[slot].prop ? smokeSourceId(&g_Smokes[slot]) : 0;
}
EMSCRIPTEN_KEEPALIVE int peakPdSmokePresent(int slot)
{
    return !poseCount && smokeSupported() && slot >= 0 && slot < g_MaxSmokes ? !!g_Smokes[slot].prop : -1;
}
EMSCRIPTEN_KEEPALIVE double peakPdSmokeField(int slot, int field)
{
    if (peakPdSmokePresent(slot) != 1) return NAN;
    struct smoke *s = &g_Smokes[slot]; struct prop *p = s->prop;
    // Native room lists stop at the first -1; unused trailing entries may still
    // contain data from an earlier allocation. Serialize a canonical terminator.
    if (field >= 10 && field < 18)
        for (int i = 0; i <= field - 10; ++i) if (p->rooms[i] == -1) return -1;
    // Unused particle slots have only size initialized by the original pool.
    // Their remaining bytes are not state until a particle is emitted.
    if (field >= 26 && field < PEAK_SMOKE_FIELDS_COUNT && s->parts[(field - 26) / 10].size == 0) return 0;
    switch (field) {
#define SMOKE_READ(i, member, integer, low, high) case i: return member;
        PEAK_SMOKE_FIELDS(SMOKE_READ)
#undef SMOKE_READ
    default: return NAN;
    }
}
EMSCRIPTEN_KEEPALIVE double peakPdSmokeOrder(int index)
{
    if (poseCount || !smokeSupported() || index < 0 || index >= PEAK_SMOKE_ORDER_MAX) return NAN;
    struct prop *p = g_Vars.activeprops;
    while (p && p != g_Vars.pausedprops && index--) p = p->next;
    if (!p || p == g_Vars.pausedprops) return 0;
    if (p->type == PROPTYPE_SMOKE) { int slot = smokeSlot(p); return slot < 0 ? NAN : -slot - 1; }
    return entityIds[p - g_Vars.props];
}
EMSCRIPTEN_KEEPALIVE int peakPdSmokeBegin(int capacity, int orderCount, int player)
{
    if (!poseCount || poseFailed || !randomStaged || smokeRequired || !smokeSupported()
            || player < 0 || player > 3 || !(controllerMask & (1U << player))
            || capacity != g_MaxSmokes || orderCount < 1 || orderCount >= PEAK_SMOKE_ORDER_MAX) return rejectPose();
    for (int i = 0; i < g_MaxSmokes; ++i) if (g_Smokes[i].prop && g_Smokes[i].source) return rejectPose();
    cancelSmoke(); smokeRequired = 1; smokeOrderCount = orderCount; smokePlayer = player; return 1;
}
EMSCRIPTEN_KEEPALIVE int peakPdSmokeBeginV2(int capacity, int orderCount, int player)
{
    if (!poseCount || poseFailed || !randomStaged || smokeRequired || !smokeSupported()
            || player < 0 || player > 3 || !(controllerMask & (1U << player))
            || capacity != g_MaxSmokes || orderCount < 1 || orderCount >= PEAK_SMOKE_ORDER_MAX) return rejectPose();
    cancelSmoke(); smokeRequired = 1; smokeSourceRequired = 1;
    smokeOrderCount = orderCount; smokePlayer = player; return 1;
}
EMSCRIPTEN_KEEPALIVE int peakPdSmokeSourceStage(int slot, double id)
{
    if (!poseCount || poseFailed || !smokeSourceRequired || busy || slot < 0 || slot >= g_MaxSmokes
            || smokeSourceSet[slot] || !isfinite(id) || id < 0 || id >= 4294967295.0 || id != trunc(id)) return rejectPose();
    smokeSources[slot] = (u32)id; smokeSourceSet[slot] = 1; return 1;
}
EMSCRIPTEN_KEEPALIVE int peakPdSmokeStage(int slot, int field, double value)
{
    if (!poseCount || poseFailed || !smokeRequired || busy || slot < 0 || slot >= g_MaxSmokes
            || field != smokeNext[slot] || !isfinite(value)) return rejectPose();
    switch (field) {
#define SMOKE_VALIDATE(i, member, integer, low, high) case i: \
        if (value < (low) || value > (high) || ((integer) && value != trunc(value))) return rejectPose(); break;
        PEAK_SMOKE_FIELDS(SMOKE_VALIDATE)
#undef SMOKE_VALIDATE
    default: return rejectPose();
    }
    smokeFields[slot][field] = value; ++smokeNext[slot]; return 1;
}
EMSCRIPTEN_KEEPALIVE int peakPdSmokeOrderStage(int index, double value)
{
    if (!poseCount || poseFailed || !smokeRequired || busy || index != smokeOrderNext || index >= smokeOrderCount
            || !isfinite(value) || value != trunc(value) || value == 0 || value < -g_MaxSmokes || value > 4294967295.0) return rejectPose();
    smokeOrder[index] = value; ++smokeOrderNext; return 1;
}
static int smokeValid(void)
{
    if (!smokeRequired) return 1;
    if (!smokeSupported() || smokeOrderNext != smokeOrderCount) return 0;
    int added = 0, removed = 0, freeCount = 0, seen[PEAK_SMOKE_MAX] = {0};
    struct prop *cursor = g_Vars.activeprops;
    for (int i = 0; i < smokeOrderCount; ++i) {
        double key = smokeOrder[i];
        if (key < 0) {
            int slot = -(int)key - 1;
            if (seen[slot]++ || smokeNext[slot] != PEAK_SMOKE_FIELDS_COUNT) return 0;
            smokeResolved[i] = NULL;
        } else {
            struct prop *pending = grenadePending((u32)key);
            if (pending) {
                for (int j = 0; j < i; ++j) if (smokeOrder[j] == key) return 0;
                smokeResolved[i] = pending; continue;
            }
            while (cursor && cursor != g_Vars.pausedprops && (cursor->type == PROPTYPE_SMOKE || grenadeWillRemove(cursor))) cursor = cursor->next;
            if (!cursor || cursor == g_Vars.pausedprops || entityIds[cursor - g_Vars.props] != (u32)key) return 0;
            smokeResolved[i] = cursor; cursor = cursor->next;
        }
    }
    while (cursor && cursor != g_Vars.pausedprops && (cursor->type == PROPTYPE_SMOKE || grenadeWillRemove(cursor))) cursor = cursor->next;
    if (cursor && cursor != g_Vars.pausedprops) return 0;
    for (int slot = 0; slot < g_MaxSmokes; ++slot) {
        if (!!smokeNext[slot] != !!seen[slot]) return 0;
        if (smokeSourceRequired && smokeSourceSet[slot] != !!seen[slot]) return 0;
        smokeSourceProps[slot] = NULL;
        if (seen[slot] && smokeSourceRequired && smokeSources[slot]) {
            if (smokeFields[slot][2] != 0) return 0;
            for (int i = 0; i < entityCapacity; ++i)
                if (entityIds[i] == smokeSources[slot] && g_Vars.props[i].type != PROPTYPE_SMOKE && !grenadeWillRemove(&g_Vars.props[i])) {
                    smokeSourceProps[slot] = &g_Vars.props[i]; break;
                }
            if (!smokeSourceProps[slot]) smokeSourceProps[slot] = grenadePending(smokeSources[slot]);
            if (!smokeSourceProps[slot]) return 0;
        }
        if (!seen[slot]) { removed += !!g_Smokes[slot].prop; continue; }
        double *f = smokeFields[slot];
        if (!( (int)f[8] & PROPFLAG_ENABLED) || f[21] >= g_Vars.numpropstates) return 0;
        int ended = 0;
        for (int i = 10; i < 18; ++i) {
            if (f[i] == -1) ended = 1;
            else if (ended || f[i] >= g_Vars.roomcount) return 0;
        }
        if (!ended) return 0;
        added += !g_Smokes[slot].prop;
    }
    for (struct prop *p = g_Vars.freeprops; p; p = p->next) {
        if (++freeCount > entityCapacity) return 0;
    }
    return grenadeCreationCapacity(freeCount, added, removed) && added <= freeCount + removed && (u64)nextEntityId + added <= 0xffffffffU;
}
static void applySmoke(void)
{
    if (!smokeRequired) return;
    for (int slot = 0; slot < g_MaxSmokes; ++slot) {
        struct smoke *s = &g_Smokes[slot];
        if (!smokeNext[slot] && s->prop) {
            propExecuteTickOperation(s->prop, TICKOP_FREE);
            memset(s, 0, sizeof(*s));
        }
    }
    for (int slot = 0; slot < g_MaxSmokes; ++slot) if (smokeNext[slot]) {
        struct smoke *s = &g_Smokes[slot]; struct prop *p = s->prop;
        if (!p) {
            p = propAllocate(); // Capacity and identity headroom were checked before commit.
            p->type = PROPTYPE_SMOKE; p->smoke = s; s->prop = p;
        } else propDeregisterRooms(p);
        g_Vars.propstates[p->propstateindex].propcount--;
#define SMOKE_WRITE(i, member, integer, low, high) member = smokeFields[slot][i];
        PEAK_SMOKE_FIELDS(SMOKE_WRITE)
#undef SMOKE_WRITE
        g_Vars.propstates[p->propstateindex].propcount++;
        s->sourceprop = smokeSourceProps[slot]; p->active = true;
    }
    // Preserve the complete relative tick order, resolving smoke slots to local
    // props. Other active entities must have matched during preflight.
    for (int i = 0; i < smokeOrderCount; ++i) {
        if (smokeOrder[i] < 0) smokeResolved[i] = g_Smokes[-(int)smokeOrder[i] - 1].prop;
    }
    for (int i = 0; i < smokeOrderCount; ++i) {
        struct prop *p = smokeResolved[i];
        p->prev = i ? smokeResolved[i - 1] : NULL;
        p->next = i + 1 < smokeOrderCount ? smokeResolved[i + 1] : g_Vars.pausedprops;
    }
    g_Vars.activeprops = smokeResolved[0];
    g_Vars.activepropstail = smokeResolved[smokeOrderCount - 1];
    if (g_Vars.pausedprops) g_Vars.pausedprops->prev = g_Vars.activepropstail;
}
