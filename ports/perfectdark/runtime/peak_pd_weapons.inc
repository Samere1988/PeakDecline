/* Weapon correction reuses the pose/inventory transaction. No foreign pointers
 * or model allocations are copied. Asset transitions remain a separate task. */
#include "peak_pd_weapon_fields.inc"
static int rejectPose(void);
int peakPdInventoryBegin(unsigned int epoch, int stage, int count, int levelFrame);
extern struct guncmd var80070200[];
enum { PEAK_SCRIPT_MAX = 2048 };
static struct guncmd *weaponScripts[PEAK_SCRIPT_MAX];
static u8 weaponScriptOwners[PEAK_SCRIPT_MAX][WEAPON_SUICIDEPILL + 1];
static int weaponScriptCount, weaponScriptsReady;
static int registerWeaponScript(struct guncmd *script, int depth, int weapon)
{
    if (!script) return 1;
    int index = 0;
    while (index < weaponScriptCount && weaponScripts[index] != script) ++index;
    if (index < weaponScriptCount && weaponScriptOwners[index][weapon]) return 1;
    if (depth > 32 || index == PEAK_SCRIPT_MAX) return 0;
    if (index == weaponScriptCount) weaponScripts[weaponScriptCount++] = script;
    weaponScriptOwners[index][weapon] = 1;
    for (int i = 0; i < 256; ++i) {
        if (script[i].type == GUNCMD_END) return 1;
        if (script[0].type != GUNCMD_PLAYANIMATION &&
                (script[i].type == GUNCMD_INCLUDE || script[i].type == GUNCMD_RANDOM) &&
                !registerWeaponScript((struct guncmd *)script[i].unk04, depth + 1, weapon)) return 0;
    }
    return 0;
}
static int prepareWeaponScripts(void)
{
    if (weaponScriptsReady) return weaponScriptsReady > 0;
    weaponScriptsReady = -1;
    for (int n = 0; n <= WEAPON_SUICIDEPILL; ++n) {
        struct weapon *w = g_Weapons[n];
        if (!w) continue;
        if (!registerWeaponScript(w->equip_animation, 0, n) || !registerWeaponScript(w->unequip_animation, 0, n)
                || !registerWeaponScript(w->pritosec_animation, 0, n) || !registerWeaponScript(w->sectopri_animation, 0, n)) return 0;
        for (int f = 0; f < 2; ++f) {
            struct weaponfunc *func = w->functions[f];
            if (func && !registerWeaponScript(func->fire_animation, 0, n)) return 0;
            if (w->ammos[f] && !registerWeaponScript(w->ammos[f]->reload_animation, 0, n)) return 0;
        }
    }
    if (!registerWeaponScript(var80070200, 0, WEAPON_REMOTEMINE)) return 0;
    weaponScriptsReady = 1;
    return 1;
}
static int weaponScriptId(struct guncmd *script)
{
    if (!script) return 0;
    if (prepareWeaponScripts()) for (int i = 0; i < weaponScriptCount; ++i)
        if (weaponScripts[i] == script) return i + 1;
    return -1;
}
static struct guncmd *weaponScript(int id) { return id ? weaponScripts[id - 1] : NULL; }
static int weaponAnimationOwned(int weapon, int anim)
{
    if (!anim) return 1;
    for (int i = 0; i < weaponScriptCount; ++i) if (weaponScriptOwners[i][weapon]
            && weaponScripts[i]->type == GUNCMD_PLAYANIMATION && weaponScripts[i]->unk02 == anim) return 1;
    return 0;
}
struct peakWeaponHand { int begun, next, header[6]; double fields[PEAK_WEAPON_COUNT]; };
static struct peakWeaponHand weaponHands[4][2];
static int weaponRequired;
static int weaponSupported(int slot)
{
    struct player *p = slot >= 0 && slot < 4 ? g_Vars.players[slot] : NULL;
    if (!p || !p->prop || p->isdead || p->gunctrl.masterloadstate != 4 || p->gunctrl.gunmemnew != -1
            || p->gunctrl.switchtoweaponnum != -1 || !prepareWeaponScripts()) return 0;
    for (int hand = 0; hand < 2; ++hand) {
        struct hand *h = &p->hands[hand];
        if (h->inuse && (h->rocket || h->gset.weaponnum != p->gunctrl.weaponnum
                || h->gunmodel.definition != p->gunctrl.gunmodeldef || !h->gunmodel.definition
                || h->gunmodel.anim != &h->anim || h->anim.flipfunc || h->anim.unk70)) return 0;
    }
    return 1;
}
EMSCRIPTEN_KEEPALIVE int peakPdWeaponVersion(void) { return 1; }
EMSCRIPTEN_KEEPALIVE int peakPdWeaponCount(void) { return PEAK_WEAPON_COUNT; }
EMSCRIPTEN_KEEPALIVE double peakPdHandStateField(int slot, int hand, int field)
{
    if (busy || hand < 0 || hand > 1 || !weaponSupported(slot)) return NAN;
    const struct hand *h = &g_Vars.players[slot]->hands[hand];
    if (field < 0) {
        const int header[6] = {h->gset.weaponnum, !!h->inuse, h->clipsizes[0], h->clipsizes[1],
            weaponScriptId(h->unk0ce8), weaponScriptId(h->unk0d80)};
        return field >= -6 ? (h->inuse ? header[-field - 1] : 0) : NAN;
    }
    return h->inuse ? weaponRead(h, field) : NAN;
}
EMSCRIPTEN_KEEPALIVE int peakPdWeaponBegin(unsigned int epoch, int stage, int count, int levelFrame)
{
    if (!peakPdInventoryBegin(epoch, stage, count, levelFrame)) return 0;
    weaponRequired = 1;
    memset(weaponHands, 0, sizeof(weaponHands));
    return 1;
}
EMSCRIPTEN_KEEPALIVE int peakPdPlayerBegin(unsigned int epoch, int stage, int count, int levelFrame)
{
    if (!peakPdWeaponBegin(epoch, stage, count, levelFrame)) return 0;
    walkRequired = 1; memset(walkNext, 0, sizeof(walkNext));
    return 1;
}
EMSCRIPTEN_KEEPALIVE int peakPdWeaponHeader(int slot, int hand, int weapon, int inuse,
    int clip0, int clip1, int script, int previousScript)
{
    if (!poseCount || poseFailed || !weaponRequired || busy || slot < 0 || slot > 3 || hand < 0 || hand > 1
            || !(poseMask & (1U << slot)) || !weaponSupported(slot) || weaponHands[slot][hand].begun
            || script < 0 || previousScript < 0 || script > weaponScriptCount || previousScript > weaponScriptCount) return rejectPose();
    struct hand *h = &g_Vars.players[slot]->hands[hand];
    if (inuse != !!h->inuse || (inuse && (weapon != h->gset.weaponnum || clip0 != h->clipsizes[0] || clip1 != h->clipsizes[1]))
            || (!inuse && (weapon || clip0 || clip1 || script || previousScript))) return rejectPose();
    const int header[6] = {weapon, inuse, clip0, clip1, script, previousScript};
    memcpy(weaponHands[slot][hand].header, header, sizeof(header));
    weaponHands[slot][hand].begun = 1;
    return 1;
}
EMSCRIPTEN_KEEPALIVE int peakPdWeaponStage(int slot, int hand, int field, double value)
{
    if (!poseCount || poseFailed || !weaponRequired || busy || slot < 0 || slot > 3 || hand < 0 || hand > 1
            || !weaponHands[slot][hand].begun || !weaponHands[slot][hand].header[1]
            || field != weaponHands[slot][hand].next || !isfinite(value)) return rejectPose();
    switch (field) {
#define WEAPON_VALIDATE(i, member, integer, low, high) case i: \
        if (value < (double)(low) || value > (double)(high) || ((integer) && value != trunc(value))) return rejectPose(); break;
    PEAK_WEAPON_FIELDS(WEAPON_VALIDATE)
#undef WEAPON_VALIDATE
    default: return rejectPose();
    }
    weaponHands[slot][hand].fields[field] = value; ++weaponHands[slot][hand].next;
    return 1;
}
static int weaponValid(int slot)
{
    if (!weaponSupported(slot)) return 0;
    for (int hand = 0; hand < 2; ++hand) {
        const struct peakWeaponHand *s = &weaponHands[slot][hand];
        if (!s->begun || s->next != (s->header[1] ? PEAK_WEAPON_COUNT : 0)) return 0;
        if (!s->header[1]) continue;
        const double *f = s->fields;
        if (f[WF_STATE] == HANDSTATE_CHANGEGUN || f[WF_STATE] == HANDSTATE_AUTOSWITCH) return 0;
        struct weapon *w = g_Weapons[s->header[0]];
        if (!w || !w->functions[(int)f[WF_GSET_WEAPONFUNC]] || f[WF_LOADEDAMMO_0] > s->header[2]
                || f[WF_LOADEDAMMO_1] > s->header[3] || f[WF_ANIMMODE] == 1) return 0;
        // A running script must start with PLAYANIMATION; selector lists are
        // resolved by the engine before being stored on the hand.
        struct guncmd *script = weaponScript(s->header[4]);
        if ((script && (script->type != GUNCMD_PLAYANIMATION || !weaponScriptOwners[s->header[4] - 1][s->header[0]]))
                || ((f[WF_ANIMMODE] == HANDANIMMODE_BUSY || f[WF_ANIMLOAD] >= 0) && !script)
                || (f[WF_ANIMLOAD] >= 0 && f[WF_ANIMLOAD] != script->unk02)) return 0;
        const int indices[2][4] = {
            {WF_ANIM_ANIMNUM, WF_ANIM_FRAMEA, WF_ANIM_FRAMEB, WF_ANIM_FRAME},
            {WF_ANIM_ANIMNUM2, WF_ANIM_FRAME2A, WF_ANIM_FRAME2B, WF_ANIM_FRAME2}};
        for (int layer = 0; layer < 2; ++layer) {
            int anim = f[indices[layer][0]];
            if (anim >= g_NumAnimations || !weaponAnimationOwned(s->header[0], anim)) return 0;
            if (!anim) continue;
            int frames = animGetNumFrames(anim);
            if (f[indices[layer][1]] >= frames || f[indices[layer][2]] >= frames
                    || f[indices[layer][3]] < 0 || f[indices[layer][3]] > frames) return 0;
            double end = f[layer ? WF_ANIM_ENDFRAME2 : WF_ANIM_ENDFRAME];
            if (end < -1 || end >= frames) return 0;
        }
        if (f[WF_ANIM_LOOPING] && (f[WF_ANIM_ANIMNUM] == 0 || f[WF_ANIM_LOOPFRAME] < 0
                || f[WF_ANIM_LOOPFRAME] >= animGetNumFrames(f[WF_ANIM_ANIMNUM]))) return 0;
    }
    return 1;
}
static void applyWeapons(struct player *p, int slot)
{
    for (int hand = 0; hand < 2; ++hand) {
        const struct peakWeaponHand *s = &weaponHands[slot][hand];
        if (!s->header[1]) continue;
        struct hand *h = &p->hands[hand];
#define WEAPON_WRITE(i, member, integer, low, high) h->member = s->fields[i];
        PEAK_WEAPON_FIELDS(WEAPON_WRITE)
#undef WEAPON_WRITE
        h->unk0ce8 = weaponScript(s->header[4]); h->unk0d80 = weaponScript(s->header[5]);
    }
}
