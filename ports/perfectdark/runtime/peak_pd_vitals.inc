/* Scalar health/HUD correction inside the existing atomic pose transaction.
 * Living players only. This does not reconstruct death, body, or hit effects. */
#define PEAK_VITALS_FIELDS(X) \
    X(0, p->bondhealth, 0, 0.0, 1.0) \
    X(1, p->oldhealth, 0, 0.0, 1.0) \
    X(2, p->oldarmour, 0, 0.0, 1.0) \
    X(3, p->apparenthealth, 0, 0.0, 1.0) \
    X(4, p->apparentarmour, 0, 0.0, 1.0) \
    X(5, p->damageshowtime, 0, -1.0, 2147483647.0) \
    X(6, p->healthshowtime, 0, -1.0, 2147483647.0) \
    X(7, p->healthshowmode, 1, 0.0, 5.0) \
    X(8, p->healthdamagetype, 1, 0.0, 7.0) \
    X(9, p->damagetype, 1, 0.0, 7.0) \
    X(10, p->shieldshowrot, 0, -1000000.0, 1000000.0) \
    X(11, p->shieldshowrnd, 1, 0.0, 4294967295.0) \
    X(12, p->shieldshowtime, 0, -1.0, 2147483647.0) \
    X(13, p->healthdisplaytime60, 1, 0.0, 4294967295.0) \
    X(14, p->prop->chr->cshield, 0, 0.0, 8.0)
enum { PEAK_VITALS_COUNT = 15 };
static int vitalsRequired, vitalsNext[4];
static double stagedVitals[4][PEAK_VITALS_COUNT];
static int rejectPose(void);
int peakPdPoseBegin(unsigned int epoch, int stage, int count);
static int vitalsSupported(int slot)
{
    struct player *p = slot >= 0 && slot < 4 ? g_Vars.players[slot] : NULL;
    return p && p->prop && p->prop->chr && !p->isdead && p->bondhealth > 0;
}
EMSCRIPTEN_KEEPALIVE int peakPdVitalsVersion(void) { return 1; }
EMSCRIPTEN_KEEPALIVE double peakPdVitalsField(int slot, int field)
{
    if (!g_PeakPdControlled || !g_PeakPdReady || busy || poseCount || !vitalsSupported(slot)) return NAN;
    struct player *p = g_Vars.players[slot];
    switch (field) {
#define VITALS_READ(i, member, integer, low, high) case i: return member;
        PEAK_VITALS_FIELDS(VITALS_READ)
#undef VITALS_READ
    default: return NAN;
    }
}
EMSCRIPTEN_KEEPALIVE int peakPdVitalsBegin(unsigned int epoch, int stage, int count, double tick)
{
    if (tick != (double)g_PeakPdTick || !peakPdPoseBegin(epoch, stage, count)) return 0;
    vitalsRequired = 1;
    return 1;
}
EMSCRIPTEN_KEEPALIVE int peakPdVitalsRequire(double tick)
{
    if (!poseCount || poseFailed || busy || tick != (double)g_PeakPdTick) return rejectPose();
    vitalsRequired = 1;
    return 1;
}
EMSCRIPTEN_KEEPALIVE int peakPdVitalsStage(int slot, int field, double value)
{
    if (!poseCount || poseFailed || busy || !vitalsRequired || slot < 0 || slot > 3
            || !(poseMask & (1U << slot)) || !vitalsSupported(slot) || field != vitalsNext[slot]
            || !isfinite(value)) return rejectPose();
    switch (field) {
#define VITALS_VALIDATE(i, member, integer, low, high) case i: \
        if (value < low || value > high || ((integer) && value != trunc(value))) return rejectPose(); break;
        PEAK_VITALS_FIELDS(VITALS_VALIDATE)
#undef VITALS_VALIDATE
    default: return rejectPose();
    }
    if (field == 0 && (f32)value <= 0) return rejectPose();
    stagedVitals[slot][field] = value;
    ++vitalsNext[slot];
    return 1;
}
static int vitalsValid(void)
{
    if (!vitalsRequired) return 1;
    for (int slot = 0; slot < 4; ++slot) if (poseMask & (1U << slot))
        if (!vitalsSupported(slot) || vitalsNext[slot] != PEAK_VITALS_COUNT) return 0;
    return 1;
}
static void applyVitals(struct player *p, int slot)
{
    if (!vitalsRequired) return;
#define VITALS_WRITE(i, member, integer, low, high) member = stagedVitals[slot][i];
    PEAK_VITALS_FIELDS(VITALS_WRITE)
#undef VITALS_WRITE
}
