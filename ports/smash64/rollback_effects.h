#define PEAK_EFFECT_MAX 96
/* Included by prepare_rollback.py in the private native snapshot translation unit. */
#include <ef/effect.h>
#include <ef/efmanager.h>

typedef struct PeakEffectState {
    GObj *gobj;
    EFStruct effect;
    f32 anim_frame;
    u32 flags;
    void (*func_run)(GObj*);
    sb32 has_process, process_paused;
    void (*process_func)(GObj*);
    u32 process_priority;
} PeakEffectState;

struct SYNetRollbackSnapshot;
static void peak_rb_save_effects(struct SYNetRollbackSnapshot *snapshot);
static sb32 peak_rb_restore_effects(const struct SYNetRollbackSnapshot *snapshot);
static void peak_rb_collect_effects(u32 frame);
static void peak_rb_reset_effects(void);
