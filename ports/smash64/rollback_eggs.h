/* Included by prepare_rollback.py in the private native snapshot translation unit. */
#include <ef/effect.h>
#include <ef/efmanager.h>

typedef struct PeakEggState {
    GObj *gobj;
    EFStruct effect;
    f32 anim_frame;
    u32 flags;
    void (*func_run)(GObj*);
    sb32 has_process, process_paused;
} PeakEggState;

struct SYNetRollbackSnapshot;
static void peak_rb_save_eggs(struct SYNetRollbackSnapshot *snapshot);
static sb32 peak_rb_restore_eggs(const struct SYNetRollbackSnapshot *snapshot);
static void peak_rb_collect_eggs(u32 frame);
static void peak_rb_reset_eggs(void);
