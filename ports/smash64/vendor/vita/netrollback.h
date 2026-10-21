#ifndef _SYNETROLLBACK_H_
#define _SYNETROLLBACK_H_

#include <PR/ultratypes.h>
#include <ssb_types.h>

struct GObj;
struct DObj;
struct FTParts;

#define SYNETROLLBACK_WINDOW 6

enum
{
	nSYNetRollbackDecisionAbort = -1,
	nSYNetRollbackDecisionNone = 0,
	nSYNetRollbackDecisionPerform = 1
};

/* Pure rollback policy shared with the desktop regression test. The caller
 * performs the actual restore/resimulation only for Perform. */
static inline s32 syNetRollbackClassifyMismatch(u32 mismatch_frame, u32 current_frame,
	                                            sb32 terminal_state, sb32 snapshot_available)
{
	u32 rollback_frames;

	if ((mismatch_frame > current_frame) || (terminal_state != FALSE))
	{
		return nSYNetRollbackDecisionNone;
	}
	rollback_frames = current_frame - mismatch_frame + 1U;
	if ((rollback_frames > SYNETROLLBACK_WINDOW) || (snapshot_available == FALSE))
	{
		return nSYNetRollbackDecisionAbort;
	}
	return nSYNetRollbackDecisionPerform;
}

extern void syNetRollbackReset(void);
extern sb32 syNetRollbackIsResimulating(void);
extern sb32 syNetRollbackSpeculationSafe(u32 confirmed_frame_count);
extern sb32 syNetRollbackDeferObjectEject(struct GObj *gobj, void *struct_ptr, sb32 is_weapon);
extern sb32 syNetRollbackDeferFighterDObjEject(struct GObj *fighter_gobj, struct DObj *dobj,
                                                struct FTParts *parts, s32 joint_id);
extern void syNetRollbackCapturePreFrame(u32 frame);
/* 1=rollback performed, 0=no mismatch, -1=controlled abort required. */
extern s32 syNetRollbackHandlePredictionMismatch(u32 current_frame);
extern void syNetRollbackPostFrame(u32 frame);
extern u32 syNetRollbackGetCount(void);
extern u32 syNetRollbackGetMaxFrames(void);
extern u32 syNetRollbackGetLateInputCount(void);
extern u32 syNetRollbackGetSnapshotBytes(void);
extern u32 syNetRollbackGetSnapshotEncodeUs(void);
extern u32 syNetRollbackGetSnapshotRestoreUs(void);
extern u32 syNetRollbackGetResimUs(void);

#endif /* _SYNETROLLBACK_H_ */
