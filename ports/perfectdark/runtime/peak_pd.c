/* Controlled real-engine execution. Components and typed pose restoration are
 * not yet a complete world snapshot or prediction/reconcile contract. */
#include <string.h>
#include <stdlib.h>
#include <math.h>
#include <SDL.h>
#include "data.h"
#include "bss.h"
#include "types.h"
#include "constants.h"
#include "video.h"
#include "input.h"
#include "system.h"
#include "lib/main.h"
#include "lib/joy.h"
#include "game/mplayer/mplayer.h"
#include "game/playermgr.h"
#include "game/prop.h"
#include "game/bondmove.h"
#include "game/player.h"
#include "game/inv.h"
#include "game/lang.h"
#include "game/bondhead.h"
#include "lib/model.h"
#include "lib/anim.h"
#include "peak_pd.h"
#include <emscripten.h>
extern s32 g_StageNum;
extern s32 g_MpWeaponSetNum;
s32 g_PeakPdControlled = 0;
s32 g_PeakPdReady = 0;
s32 g_PeakPdPresentation = 1;
s32 g_PeakPdStepBudget = 0;
u32 g_PeakPdTick = 0;
u32 g_PeakPdSeed = 1;
static s32 busy = 0;
static s32 controllerMask = 1;
static s32 commands[4][5];
static u32 submittedMask = 0;
static s32 poseCount = 0, poseFailed = 0;
static u32 poseMask = 0, poseEpoch = 0;
extern u64 g_RngSeed, g_Rng2Seed;
static int randomStaged;
static u64 stagedRandom[2];
#include "peak_pd_sway.inc"
static double stagedSway[4][PEAK_SWAY_COUNT];
static int swayNext[4];
static s32 poseStage = 0;
struct peakPose { u32 entity; struct coord pos; f32 yaw, pitch; RoomNum rooms[8]; };
static struct peakPose poses[4];
// IDs describe allocation lifetimes, never addresses or reusable pool indexes.
// The stage epoch also changes when the same arena is restarted.
static u32 *entityIds = NULL;
static u32 entityEpoch = 0, nextEntityId = 0;
static s32 entityCapacity = 0;
static u32 eventSerial = 0;
static s32 eventCount = 0;
struct peakEvent { u32 id, tick, entity; s32 type, slot, detail, hand, count; struct coord pos; };
static struct peakEvent events[256];

void peakPdEvent(s32 type, s32 slot, struct prop *subject, s32 detail, s32 hand, s32 count)
{
    if (!g_PeakPdControlled || !busy || !subject) return;
    if (eventCount == 256 || eventSerial == 0xffffffffU) sysFatalError("Perfect Dark event outbox exhausted");
    s32 index = subject - g_Vars.props;
    if (index < 0 || index >= entityCapacity || !entityIds[index])
        sysFatalError("Perfect Dark event has no entity identity");
    struct peakEvent *event = &events[eventCount++];
    event->id = ++eventSerial; event->tick = g_PeakPdTick; event->entity = entityIds[index];
    event->type = type; event->slot = slot; event->detail = detail; event->hand = hand; event->count = count;
    event->pos = subject->pos;
}

EMSCRIPTEN_KEEPALIVE int peakPdEventCount(void) { return busy ? -1 : eventCount; }
EMSCRIPTEN_KEEPALIVE double peakPdEventField(int index, int field)
{
    if (busy || index < 0 || index >= eventCount) return 0;
    const struct peakEvent *e = &events[index];
    const double values[] = {e->id, e->tick, e->type, e->slot, e->entity, e->detail,
        e->hand, e->count, e->pos.x, e->pos.y, e->pos.z};
    return field >= 0 && field < 11 ? values[field] : 0;
}
EMSCRIPTEN_KEEPALIVE int peakPdEventAck(unsigned int epoch, unsigned int id)
{
    if (busy || epoch != entityEpoch || !eventCount || id != events[eventCount - 1].id) return 0;
    eventCount = 0;
    return 1;
}

void peakPdResetEntities(void)
{
    if (!g_PeakPdControlled) return;
    free(entityIds);
    entityCapacity = g_Vars.maxprops;
    if (entityCapacity < 0 || entityCapacity > 65536 || entityEpoch == 0xffffffffU)
        sysFatalError("Perfect Dark entity registry capacity exhausted");
    entityIds = calloc(entityCapacity ? entityCapacity : 1, sizeof(u32));
    if (!entityIds) sysFatalError("Perfect Dark entity registry allocation failed");
    ++entityEpoch;
    nextEntityId = 0;
    eventSerial = 0; eventCount = 0;
}

void peakPdAllocateEntity(struct prop *prop)
{
    if (!g_PeakPdControlled) return;
    s32 index = prop - g_Vars.props;
    if (!entityIds || index < 0 || index >= entityCapacity || entityIds[index] || nextEntityId == 0xffffffffU)
        sysFatalError("Perfect Dark invalid entity allocation");
    entityIds[index] = ++nextEntityId;
}

void peakPdFreeEntity(struct prop *prop)
{
    if (!g_PeakPdControlled) return;
    s32 index = prop - g_Vars.props;
    if (!entityIds || index < 0 || index >= entityCapacity || !entityIds[index])
        sysFatalError("Perfect Dark invalid entity release");
    entityIds[index] = 0;
}

EMSCRIPTEN_KEEPALIVE unsigned int peakPdEntityEpoch(void) { return entityEpoch; }
EMSCRIPTEN_KEEPALIVE int peakPdEntityCapacity(void) { return entityCapacity; }
EMSCRIPTEN_KEEPALIVE unsigned int peakPdEntityId(int index)
{
    return !busy && entityIds && index >= 0 && index < entityCapacity ? entityIds[index] : 0;
}
EMSCRIPTEN_KEEPALIVE unsigned int peakPdPlayerEntity(int slot)
{
    if (busy || slot < 0 || slot > 3 || !g_Vars.players[slot] || !g_Vars.players[slot]->prop) return 0;
    return peakPdEntityId(g_Vars.players[slot]->prop - g_Vars.props);
}

// Versioned scalar layout: never add native pointers or model cache slots.
#define PEAK_WALK_FIELDS(X) \
    X(0, p->speedsideways, 0, -10000000.0, 10000000.0) \
    X(1, p->speedstrafe, 0, -10000000.0, 10000000.0) \
    X(2, p->speedforwards, 0, -10000000.0, 10000000.0) \
    X(3, p->speedboost, 0, -10000000.0, 10000000.0) \
    X(4, p->speedtheta, 0, -10000000.0, 10000000.0) \
    X(5, p->speedverta, 0, -10000000.0, 10000000.0) \
    X(6, p->speedthetacontrol, 0, -10000000.0, 10000000.0) \
    X(7, p->speedgo, 0, -10000000.0, 10000000.0) \
    X(8, p->gunspeed, 0, -10000000.0, 10000000.0) \
    X(9, p->sumground, 0, -10000000.0, 10000000.0) \
    X(10, p->vv_manground, 0, -10000000.0, 10000000.0) \
    X(11, p->vv_ground, 0, -10000000.0, 10000000.0) \
    X(12, p->sumcrouch, 0, -10000000.0, 10000000.0) \
    X(13, p->crouchheight, 0, -10000000.0, 10000000.0) \
    X(14, p->crouchfall, 0, -10000000.0, 10000000.0) \
    X(15, p->swayoffset, 0, -10000000.0, 10000000.0) \
    X(16, p->swaytarget, 0, -10000000.0, 10000000.0) \
    X(17, p->swayoffset0, 0, -10000000.0, 10000000.0) \
    X(18, p->swayoffset2, 0, -10000000.0, 10000000.0) \
    X(19, p->crouchoffset, 0, -10000000.0, 10000000.0) \
    X(20, p->crouchspeed, 0, -10000000.0, 10000000.0) \
    X(21, p->bondbreathing, 0, -10000000.0, 10000000.0) \
    X(22, p->gunextraaimx, 0, -10000000.0, 10000000.0) \
    X(23, p->gunextraaimy, 0, -10000000.0, 10000000.0) \
    X(24, p->guncloseroffset, 0, -10000000.0, 10000000.0) \
    X(25, p->bondonground, 0, -10000000.0, 10000000.0) \
    X(26, p->vv_height, 0, -10000000.0, 10000000.0) \
    X(27, p->vv_eyeheight, 0, -10000000.0, 10000000.0) \
    X(28, p->vv_headheight, 0, -10000000.0, 10000000.0) \
    X(29, p->standheight, 0, -10000000.0, 10000000.0) \
    X(30, p->ladderupdown, 0, -10000000.0, 10000000.0) \
    X(31, p->speedmaxtime60, 1, -2147483648, 2147483647) \
    X(32, p->fallstart, 1, -2147483648, 2147483647) \
    X(33, p->crouchtime240, 1, -2147483648, 2147483647) \
    X(34, p->swaypos, 1, -2147483648, 2147483647) \
    X(35, p->crouchoffsetreal, 1, -2147483648, 2147483647) \
    X(36, p->crouchoffsetrealsmall, 1, -2147483648, 2147483647) \
    X(37, p->crouchoffsetsmall, 0, -10000000.0, 10000000.0) \
    X(38, p->crouchpos, 1, 0, 2) \
    X(39, p->autocrouchpos, 1, 0, 2) \
    X(40, p->isfalling, 1, 0, 1) \
    X(41, p->onladder, 1, 0, 1) \
    X(42, p->floorcol, 1, 0, 65535) \
    X(43, p->floorflags, 1, 0, 65535) \
    X(44, p->floortype, 1, 0, 255) \
    X(45, p->floorroom, 1, -1, 32767) \
    X(46, p->bdeltapos.x, 0, -10000000.0, 10000000.0) \
    X(47, p->bdeltapos.y, 0, -10000000.0, 10000000.0) \
    X(48, p->bdeltapos.z, 0, -10000000.0, 10000000.0) \
    X(49, p->bondshotspeed.x, 0, -10000000.0, 10000000.0) \
    X(50, p->bondshotspeed.y, 0, -10000000.0, 10000000.0) \
    X(51, p->bondshotspeed.z, 0, -10000000.0, 10000000.0) \
    X(52, p->bondforcespeed.x, 0, -10000000.0, 10000000.0) \
    X(53, p->bondforcespeed.y, 0, -10000000.0, 10000000.0) \
    X(54, p->bondforcespeed.z, 0, -10000000.0, 10000000.0) \
    X(55, p->moveinitspeed.x, 0, -10000000.0, 10000000.0) \
    X(56, p->moveinitspeed.y, 0, -10000000.0, 10000000.0) \
    X(57, p->moveinitspeed.z, 0, -10000000.0, 10000000.0) \
    X(58, p->laddernormal.x, 0, -10000000.0, 10000000.0) \
    X(59, p->laddernormal.y, 0, -10000000.0, 10000000.0) \
    X(60, p->laddernormal.z, 0, -10000000.0, 10000000.0) \
    X(61, p->bondprevpos.x, 0, -10000000.0, 10000000.0) \
    X(62, p->bondprevpos.y, 0, -10000000.0, 10000000.0) \
    X(63, p->bondprevpos.z, 0, -10000000.0, 10000000.0) \
    X(64, p->bondprevrooms[0], 1, -1, 32767) \
    X(65, p->bondprevrooms[1], 1, -1, 32767) \
    X(66, p->bondprevrooms[2], 1, -1, 32767) \
    X(67, p->bondprevrooms[3], 1, -1, 32767) \
    X(68, p->bondprevrooms[4], 1, -1, 32767) \
    X(69, p->bondprevrooms[5], 1, -1, 32767) \
    X(70, p->bondprevrooms[6], 1, -1, 32767) \
    X(71, p->bondprevrooms[7], 1, -1, 32767) \
    X(72, p->resetheadpos, 1, 0, 1) \
    X(73, p->resetheadrot, 1, 0, 1) \
    X(74, p->resetheadtick, 1, 0, 1) \
    X(75, p->standcnt, 1, 0, 1) \
    X(76, p->headanim, 1, 0, 1) \
    X(77, p->headwalkingtime60, 1, 0, 2147483647) \
    X(78, p->headdamp, 0, 0, 0.999999) \
    X(79, p->headamplitude, 0, -10000000.0, 10000000.0) \
    X(80, p->sideamplitude, 0, -10000000.0, 10000000.0) \
    X(81, p->standfrac, 0, -10000000.0, 10000000.0) \
    X(82, p->headpos.x, 0, -10000000.0, 10000000.0) \
    X(83, p->headpos.y, 0, -10000000.0, 10000000.0) \
    X(84, p->headpos.z, 0, -10000000.0, 10000000.0) \
    X(85, p->headlook.x, 0, -10000000.0, 10000000.0) \
    X(86, p->headlook.y, 0, -10000000.0, 10000000.0) \
    X(87, p->headlook.z, 0, -10000000.0, 10000000.0) \
    X(88, p->headup.x, 0, -10000000.0, 10000000.0) \
    X(89, p->headup.y, 0, -10000000.0, 10000000.0) \
    X(90, p->headup.z, 0, -10000000.0, 10000000.0) \
    X(91, p->headpossum.x, 0, -10000000.0, 10000000.0) \
    X(92, p->headpossum.y, 0, -10000000.0, 10000000.0) \
    X(93, p->headpossum.z, 0, -10000000.0, 10000000.0) \
    X(94, p->headlooksum.x, 0, -10000000.0, 10000000.0) \
    X(95, p->headlooksum.y, 0, -10000000.0, 10000000.0) \
    X(96, p->headlooksum.z, 0, -10000000.0, 10000000.0) \
    X(97, p->headupsum.x, 0, -10000000.0, 10000000.0) \
    X(98, p->headupsum.y, 0, -10000000.0, 10000000.0) \
    X(99, p->headupsum.z, 0, -10000000.0, 10000000.0) \
    X(100, p->headbodyoffset.x, 0, -10000000.0, 10000000.0) \
    X(101, p->headbodyoffset.y, 0, -10000000.0, 10000000.0) \
    X(102, p->headbodyoffset.z, 0, -10000000.0, 10000000.0) \
    X(103, p->standbodyoffset.x, 0, -10000000.0, 10000000.0) \
    X(104, p->standbodyoffset.y, 0, -10000000.0, 10000000.0) \
    X(105, p->standbodyoffset.z, 0, -10000000.0, 10000000.0) \
    X(106, p->standlook[0].x, 0, -10000000.0, 10000000.0) \
    X(107, p->standlook[0].y, 0, -10000000.0, 10000000.0) \
    X(108, p->standlook[0].z, 0, -10000000.0, 10000000.0) \
    X(109, p->standlook[1].x, 0, -10000000.0, 10000000.0) \
    X(110, p->standlook[1].y, 0, -10000000.0, 10000000.0) \
    X(111, p->standlook[1].z, 0, -10000000.0, 10000000.0) \
    X(112, p->standup[0].x, 0, -10000000.0, 10000000.0) \
    X(113, p->standup[0].y, 0, -10000000.0, 10000000.0) \
    X(114, p->standup[0].z, 0, -10000000.0, 10000000.0) \
    X(115, p->standup[1].x, 0, -10000000.0, 10000000.0) \
    X(116, p->standup[1].y, 0, -10000000.0, 10000000.0) \
    X(117, p->standup[1].z, 0, -10000000.0, 10000000.0) \
    X(118, p->model.anim->animnum, 1, 0, 32767) \
    X(119, p->model.anim->animnum2, 1, 0, 32767) \
    X(120, p->model.anim->flip, 1, 0, 1) \
    X(121, p->model.anim->flip2, 1, 0, 1) \
    X(122, p->model.anim->looping, 1, 0, 1) \
    X(123, p->model.anim->average, 1, 0, 1) \
    X(124, p->model.anim->framea, 1, 0, 32767) \
    X(125, p->model.anim->frameb, 1, 0, 32767) \
    X(126, p->model.anim->frame2a, 1, 0, 32767) \
    X(127, p->model.anim->frame2b, 1, 0, 32767) \
    X(128, p->model.anim->frame, 0, -10000000.0, 10000000.0) \
    X(129, p->model.anim->frac, 0, 0, 1) \
    X(130, p->model.anim->endframe, 0, -10000000.0, 10000000.0) \
    X(131, p->model.anim->speed, 0, -100, 100) \
    X(132, p->model.anim->newspeed, 0, -100, 100) \
    X(133, p->model.anim->oldspeed, 0, -100, 100) \
    X(134, p->model.anim->timespeed, 0, 0, 10000000) \
    X(135, p->model.anim->elapsespeed, 0, 0, 10000000) \
    X(136, p->model.anim->frame2, 0, -10000000.0, 10000000.0) \
    X(137, p->model.anim->frac2, 0, 0, 1) \
    X(138, p->model.anim->endframe2, 0, -10000000.0, 10000000.0) \
    X(139, p->model.anim->speed2, 0, -100, 100) \
    X(140, p->model.anim->newspeed2, 0, -100, 100) \
    X(141, p->model.anim->oldspeed2, 0, -100, 100) \
    X(142, p->model.anim->timespeed2, 0, 0, 10000000) \
    X(143, p->model.anim->elapsespeed2, 0, 0, 10000000) \
    X(144, p->model.anim->fracmerge, 0, 0, 1) \
    X(145, p->model.anim->timemerge, 0, 0, 10000000) \
    X(146, p->model.anim->elapsemerge, 0, 0, 10000000) \
    X(147, p->model.anim->loopframe, 0, -10000000.0, 10000000.0) \
    X(148, p->model.anim->loopmerge, 0, 0, 10000000) \
    X(149, p->model.anim->playspeed, 0, -100, 100) \
    X(150, p->model.anim->newplay, 0, -100, 100) \
    X(151, p->model.anim->oldplay, 0, -100, 100) \
    X(152, p->model.anim->timeplay, 0, 0, 10000000) \
    X(153, p->model.anim->elapseplay, 0, 0, 10000000) \
    X(154, p->model.anim->animscale, 0, 0, 10000000) \
    X(155, headRw(p)->unk00, 1, 0, 1) \
    X(156, headRw(p)->unk01, 1, 0, 1) \
    X(157, headRw(p)->unk02, 1, 0, 1) \
    X(158, headRw(p)->ground, 0, -10000000.0, 10000000.0) \
    X(159, headRw(p)->yrot, 0, -10000000.0, 10000000.0) \
    X(160, headRw(p)->unk18, 0, -10000000.0, 10000000.0) \
    X(161, headRw(p)->unk1c, 0, -10000000.0, 10000000.0) \
    X(162, headRw(p)->unk20, 0, -10000000.0, 10000000.0) \
    X(163, headRw(p)->unk30, 0, -10000000.0, 10000000.0) \
    X(164, headRw(p)->unk58, 0, -10000000.0, 10000000.0) \
    X(165, headRw(p)->unk5c, 0, -10000000.0, 10000000.0) \
    X(166, headRw(p)->pos.x, 0, -10000000.0, 10000000.0) \
    X(167, headRw(p)->pos.y, 0, -10000000.0, 10000000.0) \
    X(168, headRw(p)->pos.z, 0, -10000000.0, 10000000.0) \
    X(169, headRw(p)->unk24.x, 0, -10000000.0, 10000000.0) \
    X(170, headRw(p)->unk24.y, 0, -10000000.0, 10000000.0) \
    X(171, headRw(p)->unk24.z, 0, -10000000.0, 10000000.0) \
    X(172, headRw(p)->unk34.x, 0, -10000000.0, 10000000.0) \
    X(173, headRw(p)->unk34.y, 0, -10000000.0, 10000000.0) \
    X(174, headRw(p)->unk34.z, 0, -10000000.0, 10000000.0) \
    X(175, headRw(p)->unk40.x, 0, -10000000.0, 10000000.0) \
    X(176, headRw(p)->unk40.y, 0, -10000000.0, 10000000.0) \
    X(177, headRw(p)->unk40.z, 0, -10000000.0, 10000000.0) \
    X(178, headRw(p)->unk4c.x, 0, -10000000.0, 10000000.0) \
    X(179, headRw(p)->unk4c.y, 0, -10000000.0, 10000000.0) \
    X(180, headRw(p)->unk4c.z, 0, -10000000.0, 10000000.0)

enum { PEAK_WALK_COUNT = 181 };
static double walkValues[4][PEAK_WALK_COUNT];
static int walkNext[4], walkRequired;
static struct modelrwdata_chrinfo *headRw(const struct player *p)
{
    return modelGetNodeRwData((struct model *)&p->model, p->model.definition->rootnode);
}
static int walkSupported(int slot)
{
    const struct player *p = slot >= 0 && slot < 4 ? g_Vars.players[slot] : NULL;
    return p && p->prop && !p->isdead && p->bondmovemode == MOVEMODE_WALK
        && !p->inlift && !p->walkinitmove && !p->bondonturret && p->headanim >= 0
        && p->model.definition == &g_PlayerModeldef && p->model.rwdatas && p->model.anim
        && p->model.anim->flipfunc == bheadFlipAnimation && !p->model.anim->unk70;
}
EMSCRIPTEN_KEEPALIVE int peakPdWalkVersion(void) { return 2; }
EMSCRIPTEN_KEEPALIVE int peakPdWalkCount(void) { return PEAK_WALK_COUNT; }
EMSCRIPTEN_KEEPALIVE double peakPdWalkField(int slot, int field)
{
    if (busy || !walkSupported(slot)) return NAN;
    const struct player *p = g_Vars.players[slot];
    // Ladder normals are not initialized until a ladder is encountered.
    if (field >= 58 && field <= 60 && !p->onladder) return 0;
    if (field >= 64 && field < 72) {
        int index = field - 64;
        for (int i = 0; i <= index; ++i) if (p->bondprevrooms[i] == -1) return -1;
    }
    if (field == 121 && (!p->model.anim->animnum2)) return 0;
    if (field == 126 && (!p->model.anim->animnum2)) return 0;
    if (field == 127 && (!p->model.anim->animnum2)) return 0;
    if (field == 132 && (!p->model.anim->timespeed)) return 0;
    if (field == 133 && (!p->model.anim->timespeed)) return 0;
    if (field == 135 && (!p->model.anim->timespeed)) return 0;
    if (field == 136 && (!p->model.anim->animnum2)) return 0;
    if (field == 137 && (!p->model.anim->animnum2)) return 0;
    if (field == 138 && (!p->model.anim->animnum2)) return 0;
    if (field == 139 && (!p->model.anim->animnum2)) return 0;
    if (field == 140 && (!p->model.anim->timespeed2 || !p->model.anim->animnum2)) return 0;
    if (field == 141 && (!p->model.anim->timespeed2 || !p->model.anim->animnum2)) return 0;
    if (field == 142 && (!p->model.anim->animnum2)) return 0;
    if (field == 143 && (!p->model.anim->timespeed2 || !p->model.anim->animnum2)) return 0;
    if (field == 146 && (!p->model.anim->timemerge)) return 0;
    if (field == 150 && (!p->model.anim->timeplay)) return 0;
    if (field == 151 && (!p->model.anim->timeplay)) return 0;
    if (field == 153 && (!p->model.anim->timeplay)) return 0;
    if (field == 164 && (headRw(p)->unk5c == 0)) return 0;
    switch (field) {
#define WALK_READ(i, member, integer, low, high) case i: return member;
    PEAK_WALK_FIELDS(WALK_READ)
#undef WALK_READ
    default: return NAN;
    }
}
static void applyWalk(struct player *p, int slot)
{
#define WALK_WRITE(i, member, integer, low, high) member = walkValues[slot][i];
    PEAK_WALK_FIELDS(WALK_WRITE)
#undef WALK_WRITE
}

#include "peak_pd_vitals.inc"
#include "peak_pd_inventory.inc"
#include "peak_pd_weapons.inc"
static int grenadeWillRemove(struct prop *p);
static struct prop *grenadePending(u32 id);
static int grenadeCreationCapacity(int freeCount, int smokeAdded, int smokeRemoved);
#include "peak_pd_smoke.inc"
#include "peak_pd_grenade.inc"

// Typed pose/room restore only, not a complete world or prediction checkpoint.
// No model, allocator, graphics, inventory or physics pointers are imported.
EMSCRIPTEN_KEEPALIVE void peakPdPoseCancel(void) { cancelGrenades(); cancelSmoke(); vitalsRequired = 0; memset(vitalsNext, 0, sizeof(vitalsNext)); poseCount = 0; poseMask = 0; poseFailed = 0; walkRequired = 0; inventoryRequired = 0; weaponRequired = 0; randomStaged = 0; memset(swayNext, 0, sizeof(swayNext)); memset(walkNext, 0, sizeof(walkNext)); }
static int rejectPose(void) { if (poseCount) poseFailed = 1; return 0; }
// Split 64-bit streams into exact JSON-safe words. No RNG call is made here.
EMSCRIPTEN_KEEPALIVE double peakPdRandomWord(int field)
{
    if (!g_PeakPdControlled || !g_PeakPdReady || busy || poseCount || field < 0 || field > 3) return -1;
    u64 seed = field < 2 ? g_RngSeed : g_Rng2Seed;
    return field & 1 ? (u32)(seed >> 32) : (u32)seed;
}
EMSCRIPTEN_KEEPALIVE int peakPdRandomStage(double tick, double a, double b, double c, double d)
{
    if (!poseCount || poseFailed || busy || !walkRequired || !weaponRequired || randomStaged
            || tick != (double)g_PeakPdTick) return rejectPose();
    const double words[] = {a, b, c, d};
    for (int i = 0; i < 4; ++i)
        if (!isfinite(words[i]) || words[i] < 0 || words[i] > 4294967295.0 || words[i] != trunc(words[i])) return rejectPose();
    if ((!a && !b) || (!c && !d)) return rejectPose();
    stagedRandom[0] = (u64)(u32)a | ((u64)(u32)b << 32);
    stagedRandom[1] = (u64)(u32)c | ((u64)(u32)d << 32);
    randomStaged = 1;
    return 1;
}
EMSCRIPTEN_KEEPALIVE double peakPdSwayField(int slot, int field)
{
    if (!g_PeakPdControlled || !g_PeakPdReady || busy || poseCount || slot < 0 || slot > 3 || !walkSupported(slot)) return NAN;
    struct player *p = g_Vars.players[slot];
    switch (field) {
#define SWAY_READ(i, member, integer, low, high) case i: return member;
        PEAK_SWAY_FIELDS(SWAY_READ)
#undef SWAY_READ
    default: return NAN;
    }
}
EMSCRIPTEN_KEEPALIVE int peakPdSwayStage(int slot, int field, double value)
{
    if (!poseCount || poseFailed || !randomStaged || busy || slot < 0 || slot > 3
            || !(poseMask & (1U << slot)) || field != swayNext[slot] || !isfinite(value)) return rejectPose();
    switch (field) {
#define SWAY_VALIDATE(i, member, integer, low, high) case i: \
        if (value < (double)(low) || value > (double)(high) || ((integer) && value != trunc(value))) return rejectPose(); break;
        PEAK_SWAY_FIELDS(SWAY_VALIDATE)
#undef SWAY_VALIDATE
    default: return rejectPose();
    }
    stagedSway[slot][field] = value; ++swayNext[slot];
    return 1;
}
EMSCRIPTEN_KEEPALIVE int peakPdPoseBegin(unsigned int epoch, int stage, int count)
{
    if (!g_PeakPdControlled || !g_PeakPdReady || busy || submittedMask || poseCount
            || epoch != entityEpoch || stage != g_StageNum || count < 1 || count > 4) return 0;
    poseCount = count; poseMask = 0; poseFailed = 0; poseEpoch = epoch; poseStage = stage;
    return 1;
}
// Walking state is a separate, explicitly complete extension of a pose batch.
// Absolute simulation timers may only be restored at the same level frame.
EMSCRIPTEN_KEEPALIVE int peakPdWalkBegin(unsigned int epoch, int stage, int count, int levelFrame)
{
    if (levelFrame != g_Vars.lvframenum || !peakPdPoseBegin(epoch, stage, count)) return 0;
    walkRequired = 1; memset(walkNext, 0, sizeof(walkNext));
    return 1;
}
EMSCRIPTEN_KEEPALIVE int peakPdWalkStage(int slot, int field, double value)
{
    if (!poseCount || poseFailed || !walkRequired || busy || slot < 0 || slot > 3
            || !(poseMask & (1U << slot)) || !walkSupported(slot)
            || field != walkNext[slot] || !isfinite(value)) return rejectPose();
    switch (field) {
#define WALK_VALIDATE(i, member, integer, low, high) case i: \
        if (value < (double)(low) || value > (double)(high) || ((integer) && value != trunc(value))) return rejectPose(); break;
    PEAK_WALK_FIELDS(WALK_VALIDATE)
#undef WALK_VALIDATE
    default: return rejectPose();
    }
    walkValues[slot][field] = value; ++walkNext[slot];
    return 1;
}
EMSCRIPTEN_KEEPALIVE int peakPdInventoryBegin(unsigned int epoch, int stage, int count, int levelFrame)
{
    if (levelFrame != g_Vars.lvframenum || !peakPdPoseBegin(epoch, stage, count)) return 0;
    inventoryRequired = 1;
    memset(inventories, 0, sizeof(inventories));
    for (int i = 0; i < 4; ++i) inventories[i].count = -1;
    return 1;
}
EMSCRIPTEN_KEEPALIVE int peakPdInventoryHeader(int slot, int count, int allguns,
    int weapon, int previous, int switching, int dual)
{
    if (!poseCount || poseFailed || !inventoryRequired || busy || slot < 0 || slot > 3
            || !(poseMask & (1U << slot)) || inventories[slot].count != -1
            || count < 0 || count > PEAK_INVENTORY_MAX || allguns < 0 || allguns > 1
            || dual < 0 || dual > 1) return rejectPose();
    struct peakInventory *s = &inventories[slot];
    s->count = count; s->allguns = allguns; s->weapon = weapon; s->previous = previous;
    s->switching = switching; s->dual = dual;
    return inventoryCompatible(slot) ? 1 : rejectPose();
}
EMSCRIPTEN_KEEPALIVE int peakPdInventoryItem(int slot, int index, int type, unsigned int a, int b)
{
    if (!poseCount || poseFailed || !inventoryRequired || busy || slot < 0 || slot > 3
            || inventories[slot].count < 0 || index != inventories[slot].next
            || index >= inventories[slot].count) return rejectPose();
    if (type == INVITEMTYPE_WEAP) {
        if (a > WEAPON_SUICIDEPILL || !g_Weapons[a] || b < -32768 || b > 32767) return rejectPose();
    } else if (type == INVITEMTYPE_DUAL) {
        if (a > WEAPON_SUICIDEPILL || b < 0 || b > WEAPON_SUICIDEPILL || !g_Weapons[a] || !g_Weapons[b]) return rejectPose();
    } else if (type == INVITEMTYPE_PROP) {
        if (!inventoryProp(a) || b) return rejectPose();
    } else return rejectPose();
    struct peakInventory *s = &inventories[slot];
    for (int i = 0; i < index; ++i) if (s->items[i][0] == type && (unsigned int)s->items[i][1] == a
            && (type != INVITEMTYPE_DUAL || s->items[i][2] == b)) return rejectPose();
    s->items[index][0] = type; s->items[index][1] = a; s->items[index][2] = b; ++s->next;
    return 1;
}
EMSCRIPTEN_KEEPALIVE int peakPdInventoryAmmo(int slot, int index, int count)
{
    if (!poseCount || poseFailed || !inventoryRequired || busy || slot < 0 || slot > 3
            || inventories[slot].count < 0 || index != inventories[slot].ammoNext
            || index >= PEAK_INVENTORY_AMMO || count < 0 || count > 1000000) return rejectPose();
    inventories[slot].ammo[index] = count; ++inventories[slot].ammoNext;
    return 1;
}
EMSCRIPTEN_KEEPALIVE int peakPdPosePlayer(int slot, unsigned int entity,
    double x, double y, double z, double yaw, double pitch,
    int r0, int r1, int r2, int r3, int r4, int r5, int r6, int r7)
{
    if (!poseCount || poseFailed || busy || slot < 0 || slot > 3 || !(controllerMask & (1U << slot))
            || (poseMask & (1U << slot)) || !entity || peakPdPlayerEntity(slot) != entity
            || !isfinite(x) || !isfinite(y) || !isfinite(z) || fabs(x) > 1e7 || fabs(y) > 1e7 || fabs(z) > 1e7
            || !isfinite(yaw) || yaw < 0 || (f32)yaw >= 360 || !isfinite(pitch) || pitch < -90 || pitch > 90) return rejectPose();
    const int rooms[8] = {r0, r1, r2, r3, r4, r5, r6, r7};
    int ended = 0;
    for (int i = 0; i < 8; ++i) {
        if (rooms[i] == -1) ended = 1;
        else {
            if (ended || rooms[i] < 0 || rooms[i] >= g_Vars.roomcount) return rejectPose();
            for (int j = 0; j < i; ++j) if (rooms[j] == rooms[i]) return rejectPose();
        }
    }
    if (!ended || rooms[0] == -1) return rejectPose();
    struct peakPose *p = &poses[slot];
    p->entity = entity; p->pos.x = x; p->pos.y = y; p->pos.z = z; p->yaw = yaw; p->pitch = pitch;
    for (int i = 0; i < 8; ++i) p->rooms[i] = rooms[i];
    poseMask |= 1U << slot;
    return 1;
}
EMSCRIPTEN_KEEPALIVE int peakPdPoseCommit(void)
{
    if (!poseCount || poseFailed || busy || submittedMask || poseEpoch != entityEpoch || poseStage != g_StageNum) return 0;
    int count = 0;
    for (int slot = 0; slot < 4; ++slot) if (poseMask & (1U << slot)) {
        if (peakPdPlayerEntity(slot) != poses[slot].entity) return 0;
        ++count;
    }
    if (count != poseCount || !grenadesValid() || !smokeValid() || !vitalsValid()) return 0;
    // A shared RNG correction cannot accompany only a subset of the players.
    if (randomStaged && poseMask != (u32)controllerMask) return 0;
    if (randomStaged) for (int slot = 0; slot < 4; ++slot)
        if ((poseMask & (1U << slot)) && swayNext[slot] != PEAK_SWAY_COUNT) return 0;
    if (weaponRequired) for (int slot = 0; slot < 4; ++slot)
        if ((poseMask & (1U << slot)) && !weaponValid(slot)) return 0;
    if (inventoryRequired) for (int slot = 0; slot < 4; ++slot)
        if ((poseMask & (1U << slot)) && !inventoryValid(slot)) return 0;
    if (walkRequired) for (int slot = 0; slot < 4; ++slot) if (poseMask & (1U << slot)) {
        if (!walkSupported(slot) || walkNext[slot] != PEAK_WALK_COUNT) return 0;
        if (walkValues[slot][45] >= g_Vars.roomcount) return 0;
        // Frame indices address animation ROM data, so validate them against
        // the selected local animation before any player is changed.
        int anim1 = walkValues[slot][118];
        if (anim1 != g_HeadAnims[(int)walkValues[slot][76]].animnum) return 0;
        if (anim1 >= g_NumAnimations || (anim1 && (walkValues[slot][124] >= animGetNumFrames(anim1) || walkValues[slot][125] >= animGetNumFrames(anim1)))) return 0;
        int anim2 = walkValues[slot][119];
        if (anim2 && anim2 != g_HeadAnims[0].animnum && anim2 != g_HeadAnims[1].animnum) return 0;
        if (anim2 >= g_NumAnimations || (anim2 && (walkValues[slot][126] >= animGetNumFrames(anim2) || walkValues[slot][127] >= animGetNumFrames(anim2)))) return 0;
        const int frameFields[2][3] = {{128, 130, 147}, {136, 138, 136}};
        for (int layer = 0; layer < 2; ++layer) {
            int anim = layer ? anim2 : anim1;
            if (!anim) continue;
            int frames = animGetNumFrames(anim);
            for (int i = 0; i < 3; ++i) {
                double frame = walkValues[slot][frameFields[layer][i]];
                if (frame < (i == 1 ? -1 : 0) || frame >= frames) return 0;
            }
        }
        // Validate spatial history as a whole before mutating any player.
        int ended = 0;
        for (int i = 64; i < 72; ++i) {
            int room = walkValues[slot][i];
            if (room == -1) ended = 1;
            else if (ended || room >= g_Vars.roomcount) return 0;
        }
        if (!ended) return 0;
    }
    const int previousPlayer = g_Vars.currentplayernum;
    busy = 1;
    for (int slot = 0; slot < 4; ++slot) if (poseMask & (1U << slot)) {
        struct player *player = g_Vars.players[slot];
        struct prop *prop = player->prop;
        const struct peakPose *p = &poses[slot];
        if (prop->active) propDeregisterRooms(prop);
        prop->pos = p->pos;
        memcpy(prop->rooms, p->rooms, sizeof(prop->rooms));
        if (prop->active) propRegisterRooms(prop);
        setCurrentPlayerNum(slot);
        player->vv_theta = p->yaw; player->vv_verta = p->pitch;
        bmoveUpdateVerta();
        if (walkRequired) { applyWalk(player, slot); playerUpdatePerimInfo(); }
        applyVitals(player, slot);
        if (inventoryRequired) applyInventory(player, slot);
        if (weaponRequired) applyWeapons(player, slot);
        if (randomStaged) {
            struct player *p = player;
#define SWAY_WRITE(i, member, integer, low, high) member = stagedSway[slot][i];
            PEAK_SWAY_FIELDS(SWAY_WRITE)
#undef SWAY_WRITE
        }
    }
    applyGrenades();
    applySmoke();
    applyGrenadeAllocation();
    setCurrentPlayerNum(smokeRequired ? smokePlayer : previousPlayer);
    if (randomStaged) { g_RngSeed = stagedRandom[0]; g_Rng2Seed = stagedRandom[1]; }
    busy = 0;
    peakPdPoseCancel();
    // Do not silently show a cached command list for the previous pose.
    videoDiscardReplayFrame();
    return 1;
}

// Base prop component only. Type-specific physics, weapons and AI are separate
// components still to be implemented; these values cannot restore a world.
EMSCRIPTEN_KEEPALIVE double peakPdEntityField(int index, int field)
{
    if (!peakPdEntityId(index)) return 0;
    const struct prop *p = &g_Vars.props[index];
    switch (field) {
    case 0: return p->type;
    case 1: return !!(p->flags & PROPFLAG_ENABLED);
    case 2: return p->pos.x;
    case 3: return p->pos.y;
    case 4: return p->pos.z;
    case 5: return p->timetoregen;
    case 6: return p->active;
    default:
        if (field >= 7 && field < 15) {
            for (int i = 0; i <= field - 7; ++i) if (p->rooms[i] == -1) return -1;
            return p->rooms[field - 7];
        }
        return 0;
    }
}

u64 peakPdClock(void) { return (u64)g_PeakPdTick * CYCLES_PER_FRAME; }
s32 peakPdControllerMask(void) { return controllerMask; }
EMSCRIPTEN_KEEPALIVE int peakPdStage(void) { return g_StageNum; }
EMSCRIPTEN_KEEPALIVE int peakPdLevelFrame(void) { return g_Vars.lvframenum; }
EMSCRIPTEN_KEEPALIVE int peakPdInterpolation(void) { return videoGetDecoupledRendering(); }
EMSCRIPTEN_KEEPALIVE int peakPdReady(void) { return g_PeakPdReady; }
EMSCRIPTEN_KEEPALIVE int peakPdTick(void) { return g_PeakPdTick; }
EMSCRIPTEN_KEEPALIVE int peakPdDelta240(void) { return g_Vars.diffframe240; }
// Only GPU submission is optional. Native rendering still builds display lists:
// it also advances gameplay visibility, animation and random state.
EMSCRIPTEN_KEEPALIVE int peakPdSetPresentation(int enabled)
{
    if (!g_PeakPdControlled || !g_PeakPdReady || busy || submittedMask || poseCount
            || (enabled != 0 && enabled != 1)) return 0;
    videoDiscardReplayFrame();
    g_PeakPdPresentation = enabled;
    return 1;
}
EMSCRIPTEN_KEEPALIVE int peakPdPresent(void)
{
    if (!g_PeakPdControlled || !g_PeakPdReady || busy || submittedMask || poseCount) return 0;
    busy = 1;
    int result = g_PeakPdPresentation ? videoReplayLastFrame(1.f) : 0;
    busy = 0;
    return result;
}

// Configure before main starts. There is no supported mid-session mode switch.
EMSCRIPTEN_KEEPALIVE int peakPdConfigure(int players, unsigned int seed)
{
    if (g_PeakPdReady || busy || players < 1 || players > 4) return 0;
    controllerMask = (1 << players) - 1;
    g_PeakPdSeed = seed ? seed : 1;
    return 1;
}

// All connected seats must submit exactly once before a step. No stale buttons
// or aim deltas can silently repeat when the caller omits a command.
EMSCRIPTEN_KEEPALIVE int peakPdCommand(int slot, int buttons, int mx, int my, int lx, int ly)
{
    if (!g_PeakPdControlled || !g_PeakPdReady || busy || poseCount || slot < 0 || slot > 3
            || !(controllerMask & (1 << slot)) || (submittedMask & (1 << slot))
            || buttons < 0 || buttons > 65535 || mx < -127 || mx > 127 || my < -127 || my > 127
            || lx < -32767 || lx > 32767 || ly < -32767 || ly > 32767) return 0;
    s32 *cmd = commands[slot];
    cmd[0] = buttons; cmd[1] = mx; cmd[2] = my; cmd[3] = lx; cmd[4] = ly;
    submittedMask |= 1 << slot;
    return 1;
}

s32 peakPdReadPad(s32 slot, OSContPad *pad)
{
    if (slot < 0 || slot > 3 || !(controllerMask & (1 << slot))) return -1;
    const s32 *cmd = commands[slot];
    memset(pad, 0, sizeof(*pad));
    const u32 mappings[] = {1U << CK_ZTRIG, 1U << CK_RTRIG, 1U << CK_X,
        1U << CK_B, 1U << CK_2000, 1U << CK_Y, 1U << CK_DPAD_L,
        1U << CK_START, 1U << CK_ACCEPT, 1U << CK_CANCEL, 1U << CK_LTRIG};
    for (u32 i = 0; i < sizeof(mappings) / sizeof(mappings[0]); ++i)
        if (cmd[0] & (1 << i)) pad->button |= mappings[i];
    // The PC control scheme consumes the secondary stick for analog movement.
    pad->rstick_x = cmd[1]; pad->rstick_y = cmd[2];
    // Menus consume primary stick navigation; gameplay look comes from angles.
    if (g_StageNum >= STAGE_TITLE || !g_Vars.players[slot] || g_Vars.players[slot]->pausemode != PAUSEMODE_UNPAUSED) {
        pad->stick_x = cmd[1]; pad->stick_y = cmd[2];
    }
    return 0;
}

void peakPdLook(f32 *dx, f32 *dy)
{
    s32 slot = g_Vars.currentplayernum;
    const f32 scale = 180.f / (32767.f * 3.5f);
    if (dx) *dx = slot >= 0 && slot < 4 ? commands[slot][3] * scale : 0.f;
    if (dy) *dy = slot >= 0 && slot < 4 ? commands[slot][4] * scale : 0.f;
}

void peakPdBeginTick(void)
{
    SDL_SetHint(SDL_HINT_EMSCRIPTEN_ASYNCIFY, "0");
    ++g_PeakPdTick;
    // Normalise external action semantics, independent of saved N64 layouts.
    for (s32 i = 0; i < 4; ++i) g_PlayerConfigsArray[i].controlmode = CONTROLMODE_PC;
    inputUpdate();
    joyStartReadData(&g_PiMesgQueue);
    joyReadData();
    joy00014238();
}

EMSCRIPTEN_KEEPALIVE int peakPdStep(void)
{
    if (!g_PeakPdControlled || !g_PeakPdReady || busy || poseCount || submittedMask != (u32)controllerMask) return 0;
    busy = 1;
    const u32 previous = g_PeakPdTick;
    g_PeakPdStepBudget = 1;
    mainLoop();
    memset(commands, 0, sizeof(commands)); submittedMask = 0;
    busy = 0;
    return g_PeakPdTick == previous + 1 && g_PeakPdStepBudget == 0;
}

// Pointer-free read-only observations for real-engine integration tests.
// Menu handlers are deliberately not called: some dynamic labels mutate state.
EMSCRIPTEN_KEEPALIVE int peakPdFlow(int slot, int field)
{
    if (!g_PeakPdReady || busy || slot < 0 || slot > 3) return -1;
    const struct menudialog *dialog = g_Menus[slot].curdialog;
    switch (field) {
    case 0: return g_MenuData.root;
    case 1: return g_Menus[slot].depth;
    case 2: return dialog && dialog->focuseditem ? dialog->focuseditem - dialog->definition->items : -1;
    case 3: return dialog ? dialog->dimmed : 0;
    case 4: return g_MpSetup.stagenum;
    case 5: return g_MpSetup.timelimit;
    case 6: return g_MpSetup.scorelimit;
    case 7: return g_MpSetup.chrslots;
    case 8: return g_Vars.normmplayerisrunning;
    case 9: return g_Vars.players[slot] ? g_Vars.players[slot]->pausemode : -1;
    case 10: return g_Paks[SAVEDEVICE_GAMEPAK].state;
    case 11: return g_Paks[SAVEDEVICE_GAMEPAK].type;
    case 12: return g_FileLists[0] ? g_FileLists[0]->spacesfree[SAVEDEVICE_GAMEPAK] : -1;
    default: return -1;
    }
}

EMSCRIPTEN_KEEPALIVE const char *peakPdMenuText(int slot, int title)
{
    if (!g_PeakPdReady || busy || slot < 0 || slot > 3) return "";
    const struct menudialog *dialog = g_Menus[slot].curdialog;
    if (!dialog) return "";
    uintptr_t id = title ? dialog->definition->title : dialog->focuseditem ? dialog->focuseditem->param2 : 0;
    return id && id < 0x5a00 ? langGet(id) : "";
}

EMSCRIPTEN_KEEPALIVE double peakPdObserve(int slot, int field)
{
    if (!g_PeakPdReady || busy || slot < 0 || slot > 3 || !g_Vars.players[slot]) return 0;
    const struct player *p = g_Vars.players[slot];
    switch (field) {
    case 0: return p->prop ? p->prop->pos.x : 0;
    case 1: return p->prop ? p->prop->pos.y : 0;
    case 2: return p->prop ? p->prop->pos.z : 0;
    case 3: return p->vv_theta;
    case 4: return p->vv_verta;
    case 5: return p->bondhealth;
    case 6: return p->isdead;
    default: return 0;
    }
}

// Explicit scalar components, not a memcpy of player/hand structs. Model,
// audio, animation and inventory pointers must never cross this boundary.
EMSCRIPTEN_KEEPALIVE int peakPdComponentVersion(void) { return 2; }

static const struct defaultobj *componentObject(int index)
{
    if (!peakPdEntityId(index)) return NULL;
    const struct prop *p = &g_Vars.props[index];
    return p->type == PROPTYPE_OBJ || p->type == PROPTYPE_WEAPON || p->type == PROPTYPE_DOOR ? p->obj : NULL;
}

static const struct projectile *componentProjectile(const struct defaultobj *obj)
{
    if (!obj) return NULL;
    if (obj->hidden & OBJHFLAG_EMBEDDED) return obj->embedment ? obj->embedment->projectile : NULL;
    return obj->hidden & OBJHFLAG_PROJECTILE ? obj->projectile : NULL;
}

static u32 componentReference(const struct prop *prop)
{
    return prop ? peakPdEntityId(prop - g_Vars.props) : 0;
}

EMSCRIPTEN_KEEPALIVE int peakPdObjectKind(int index)
{
    const struct defaultobj *obj = componentObject(index);
    return obj ? 1 | (obj->type == OBJTYPE_WEAPON ? 2 : 0) |
        (componentProjectile(obj) ? 4 : 0) : 0;
}

EMSCRIPTEN_KEEPALIVE double peakPdObjectField(int index, int field)
{
    const struct defaultobj *o = componentObject(index);
    if (!o) return 0;
    const double values[] = {o->type, o->modelnum, o->extrascale, o->flags, o->flags2, o->flags3,
        o->hidden, o->hidden2, o->damage, o->maxdamage};
    if (field >= 10 && field < 19) return o->realrot[(field - 10) / 3][(field - 10) % 3];
    return field >= 0 && field < 10 ? values[field] : 0;
}

EMSCRIPTEN_KEEPALIVE double peakPdWeaponField(int index, int field)
{
    const struct defaultobj *obj = componentObject(index);
    if (!obj || obj->type != OBJTYPE_WEAPON) return 0;
    const struct weaponobj *w = (const struct weaponobj *)obj;
    const double values[] = {w->weaponnum, w->gunfunc, w->timer240, w->fadeouttimer60,
        w->dualweaponnum, w->dualweapon ? componentReference(w->dualweapon->base.prop) : 0};
    return field >= 0 && field < 6 ? values[field] : 0;
}

// Replicated projectile observations use entity references, never C addresses.
// This is not a complete physics checkpoint: opaque movement/animation state
// still needs a restore contract before these components can drive replicas.
EMSCRIPTEN_KEEPALIVE double peakPdProjectileField(int index, int field)
{
    const struct projectile *p = componentProjectile(componentObject(index));
    if (!p) return 0;
    // The engine leaves nextsteppos uninitialized outside the launch phase.
    // Never serialize inactive union/pool data from a previous allocation.
    if (field >= 14 && field <= 16 && !(p->flags & PROJECTILEFLAG_LAUNCHING)) return 0;
    const double values[] = {p->flags, p->speed.x, p->speed.y, p->speed.z,
        componentReference(p->ownerprop), componentReference(p->targetprop), componentReference(p->pickupby),
        p->bouncecount, p->bounceframe, p->flighttime240, p->pickuptimer240, p->losttimer240,
        p->droptype, p->powerlimit240, p->nextsteppos.x, p->nextsteppos.y, p->nextsteppos.z,
        p->smoketimer240};
    return field >= 0 && field < 18 ? values[field] : 0;
}
EMSCRIPTEN_KEEPALIVE double peakPdPlayerField(int slot, int field)
{
    if (!g_PeakPdControlled || !g_PeakPdReady || busy || slot < 0 || slot > 3
            || !g_Vars.players[slot] || !g_Vars.players[slot]->prop) return 0;
    const struct player *p = g_Vars.players[slot];
    if (field >= 100 && field < 133) return p->ammoheldarr[field - 100];
    const double values[] = {
        p->vv_theta, p->vv_verta, p->bondhealth, p->isdead,
        p->prop->chr ? p->prop->chr->cshield : 0,
        p->speedsideways, p->speedstrafe, p->speedforwards, p->speedboost,
        p->speedtheta, p->speedverta, p->speedmaxtime60,
        p->vv_ground, p->vv_manground, p->sumground, p->bdeltapos.y,
        p->crouchpos, p->autocrouchpos, p->crouchoffset, p->crouchspeed,
        p->isfalling, p->fallstart, p->onladder, p->inlift, p->inlift ? p->liftground : 0,
        p->bondmovemode, p->insightaimmode,
        p->gunctrl.weaponnum, p->gunctrl.prevweaponnum, p->gunctrl.switchtoweaponnum,
        p->gunctrl.dualwielding, p->gunctrl.ammotypes[0], p->gunctrl.ammotypes[1]
    };
    return field >= 0 && field < (int)(sizeof(values) / sizeof(values[0])) ? values[field] : 0;
}

EMSCRIPTEN_KEEPALIVE double peakPdHandField(int slot, int handnum, int field)
{
    if (!g_PeakPdControlled || !g_PeakPdReady || busy || slot < 0 || slot > 3
            || handnum < 0 || handnum > 1 || !g_Vars.players[slot] || !g_Vars.players[slot]->prop) return 0;
    const struct hand *h = &g_Vars.players[slot]->hands[handnum];
    const double values[] = {
        h->gset.weaponnum, h->gset.weaponfunc, h->inuse, h->firing,
        h->triggeron, h->triggerprev, h->triggerreleased,
        h->state, h->stateminor, h->stateframes, h->statecycles,
        h->loadedammo[0], h->loadedammo[1], h->clipsizes[0], h->clipsizes[1],
        h->mode, h->modenext, h->count, h->count60, h->refiretime,
        h->allowshootframe, h->lastshootframe60, h->burstbullets
    };
    return field >= 0 && field < (int)(sizeof(values) / sizeof(values[0])) ? values[field] : 0;
}

// Stage transition entry point for an eventual replicated match setup. Uses
// the original Combat Simulator start path; it never changes normal boot.
static int startCombat(int stage, const int *weapons)
{
    if (!g_PeakPdControlled || !g_PeakPdReady || busy || submittedMask || poseCount) return 0;
    switch (stage) {
    case STAGE_MP_RAVINE: case STAGE_MP_COMPLEX: case STAGE_MP_G5BUILDING:
    case STAGE_MP_TEMPLE: case STAGE_MP_PIPES: case STAGE_MP_SKEDAR:
    case STAGE_MP_BASE: case STAGE_MP_AREA52: case STAGE_MP_WAREHOUSE:
    case STAGE_MP_CARPARK: case STAGE_MP_RUINS: case STAGE_MP_SEWERS:
    case STAGE_MP_FELICITY: case STAGE_MP_FORTRESS: case STAGE_MP_VILLA:
    case STAGE_MP_GRID:
        break;
    default: return 0;
    }
    if (weapons) {
        for (int i = 0; i < NUM_MPWEAPONSLOTS; ++i)
            if (weapons[i] < 0 || weapons[i] >= NUM_MPWEAPONS) return 0;
        for (int i = 0; i < NUM_MPWEAPONSLOTS; ++i) g_MpSetup.weapons[i] = weapons[i];
        g_MpWeaponSetNum = WEAPONSET_CUSTOM;
    }
    g_MpSetup.chrslots = controllerMask;
    g_MpSetup.stagenum = stage;
    mpStartMatch();
    return 1;
}

EMSCRIPTEN_KEEPALIVE int peakPdStartCombat(int stage) { return startCombat(stage, NULL); }
EMSCRIPTEN_KEEPALIVE int peakPdStartCombatWeapons(int stage, int a, int b, int c, int d, int e, int f)
{
    const int weapons[NUM_MPWEAPONSLOTS] = {a, b, c, d, e, f};
    return startCombat(stage, weapons);
}
