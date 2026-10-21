#ifndef PEAK_PD_H
#define PEAK_PD_H
#include <ultra64.h>
extern s32 g_PeakPdControlled;
extern s32 g_PeakPdReady;
extern s32 g_PeakPdPresentation;
extern s32 g_PeakPdStepBudget;
extern u32 g_PeakPdTick;
extern u32 g_PeakPdSeed;
void peakPdBeginTick(void);
s32 peakPdReadPad(s32 slot, OSContPad *pad);
s32 peakPdControllerMask(void);
void peakPdLook(f32 *dx, f32 *dy);
u64 peakPdClock(void);
struct prop;
void peakPdResetEntities(void);
void peakPdAllocateEntity(struct prop *prop);
void peakPdFreeEntity(struct prop *prop);
void peakPdEvent(s32 type, s32 slot, struct prop *subject, s32 detail, s32 hand, s32 count);
#endif
