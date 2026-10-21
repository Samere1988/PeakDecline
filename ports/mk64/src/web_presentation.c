/* Presentation-only interpolation. The simulation and input stream remain at
 * their original 30 Hz, including two 60 Hz physics steps per race frame. */
#include <math.h>
#include <string.h>
#include <stddef.h>
#include <emscripten.h>
#include <ultra64.h>
#include "defines.h"
#include "main.h"
#include "course.h"
#include "actor_types.h"
#include "web_matrix_history.h"

/* These matrices have stable camera/player identities. Sequential object,
 * particle and HUD allocations never enter this table without an explicit
 * stable identity registered by their renderer. */
enum { WEB_LAKITU_BASE = 8 + MTX_KART_POOL_SIZE + MTX_SHADOW_POOL_SIZE };
enum { WEB_ITEM_BASE = WEB_LAKITU_BASE + 4, WEB_HISTORY_SIZE = WEB_ITEM_BASE + 4*ACTOR_LIST_SIZE*2 };
static struct WebMatrixHistory history[WEB_HISTORY_SIZE];
static struct { unsigned frame; int slot, identity; } items[MTX_OBJECT_POOL_SIZE];
static int item_identity[4*ACTOR_LIST_SIZE*2];
void web_register_item_matrices(int camera, int actor, int kind, int first, int end) {
    if ((unsigned)camera>=4 || (unsigned)actor>=ACTOR_LIST_SIZE) return;
    /* Last matrix is the body; the preceding matrix, if present, is its shadow. */
    for (int part=0;part<2 && end-1-part>=first;part++) {
        int index=end-1-part, key=(camera*ACTOR_LIST_SIZE+actor)*2+part;
        if ((unsigned)index>=MTX_OBJECT_POOL_SIZE) continue;
        items[index].frame=gGlobalTimer;items[index].slot=WEB_ITEM_BASE+key;
        items[index].identity=kind;item_identity[key]=kind;
    }
}
static struct {
    const void *address;
    unsigned frame;
    int kind;
} lakitu[4];

/* HUD pool indices belong to allocation order, not to stable objects. Record
 * the actual Lakitu matrix while building this frame's display list and key
 * its history by player and role (countdown, lap sign, rescue, finish, etc.). */
void web_register_lakitu_matrix(int player, int kind, const void *address) {
    if ((unsigned)player >= 4) return;
    lakitu[player].address = address;
    lakitu[player].frame = gGlobalTimer;
    lakitu[player].kind = kind;
}
#ifdef WEB_AUTHORITY_CANDIDATE
static unsigned correction_generation;
static struct {
    unsigned generation;
    int valid;
    float displayed[3], offset[3];
    double began;
} correction[WEB_HISTORY_SIZE];
EMSCRIPTEN_KEEPALIVE void web_mark_correction(void) { ++correction_generation; }
/* Presentation-only translation error, bounded to avoid dragging teleports or
 * respawns through geometry. Native positions and collision state stay exact. */
static void smooth_correction(int slot, float matrix[4][4]) {
    if (slot < 4) return; /* Never change perspective projection. */
    double now = emscripten_get_now();
    if (correction[slot].generation != correction_generation) {
        float length2 = 0;
        for (int i=0;i<3;i++) {
            float d = correction[slot].displayed[i] - matrix[3][i];
            correction[slot].offset[i] = d; length2 += d*d;
        }
        if (!correction[slot].valid || length2 > 6400)
            memset(correction[slot].offset, 0, sizeof(correction[slot].offset));
        correction[slot].generation = correction_generation;
        correction[slot].began = now;
    }
    float weight = 1.0f - (float)((now-correction[slot].began)/120.0);
    if (weight < 0) weight = 0;
    for (int i=0;i<3;i++) {
        matrix[3][i] += correction[slot].offset[i]*weight;
        correction[slot].displayed[i] = matrix[3][i];
    }
    correction[slot].valid = 1;
}
#endif
static int passes = 1, midpoint, can_interpolate, scene_initialized;
static int last_game, last_course, last_screen, last_race;
static unsigned last_frame, render_frames, interpolated_matrices;

EMSCRIPTEN_KEEPALIVE unsigned web_render_frames(void) { return render_frames; }
EMSCRIPTEN_KEEPALIVE unsigned web_interpolated_matrices(void) { return interpolated_matrices; }
int web_presentation_midpoint(void) { return midpoint; }
double web_presentation_interval(void) { return 1000.0 / (passes == 2 ? 60.0 : 30.0); }
int web_catching_up(void) {
    return EM_ASM_INT({ return Module.mk64Network?.catchingUp?.() ? 1 : 0; });
}
void web_presented(void) { ++render_frames; }

int web_begin_presentation(void) {
#ifdef WEB_AUTHORITY_CANDIDATE
    /* External display pacing may present a simulation frame more than once. */
    if (scene_initialized && last_frame == (unsigned)gGlobalTimer &&
        last_game == gGamestate && last_course == gCurrentCourseId &&
        last_screen == gActiveScreenMode && last_race == gRaceState) return passes;
#endif
    int target = EM_ASM_INT({ return Module.mk64RenderFps === 30 ? 30 : 60; });
    passes = target == 60 && !web_catching_up() ? 2 : 1;
    can_interpolate = scene_initialized && last_frame + 1 == (unsigned)gGlobalTimer &&
        last_game == gGamestate && last_course == gCurrentCourseId &&
        last_screen == gActiveScreenMode && last_race == gRaceState;
    if (!can_interpolate) memset(history, 0, sizeof(history));
#ifdef WEB_AUTHORITY_CANDIDATE
    if (scene_initialized && (last_game != gGamestate || last_course != gCurrentCourseId || last_screen != gActiveScreenMode))
        memset(correction, 0, sizeof(correction));
#endif
    scene_initialized = 1;
    last_frame = gGlobalTimer;
    last_game = gGamestate;
    last_course = gCurrentCourseId;
    last_screen = gActiveScreenMode;
    last_race = gRaceState;
    return passes;
}
void web_begin_presentation_pass(int pass) { midpoint = passes == 2 && pass == 0; }

static int matrix_slot(const void *address) {
    for (int player = 0; player < 4; ++player)
        if (lakitu[player].address == address && lakitu[player].frame == (unsigned)gGlobalTimer)
            return WEB_LAKITU_BASE + player;
    uintptr_t offset = (uintptr_t)address - (uintptr_t)gGfxPool;
    size_t object_offset=offset - offsetof(struct GfxPool, mtxObject);
    if (object_offset < sizeof(gGfxPool->mtxObject) && object_offset % sizeof(Mtx)==0) {
        int index=object_offset/sizeof(Mtx);
        if(items[index].frame==(unsigned)gGlobalTimer) return items[index].slot;
    }
    const size_t starts[] = {offsetof(struct GfxPool, mtxPersp), offsetof(struct GfxPool, mtxLookAt),
        offsetof(struct GfxPool, mtxKart), offsetof(struct GfxPool, mtxShadow)};
    const int counts[] = {4, 4, MTX_KART_POOL_SIZE, MTX_SHADOW_POOL_SIZE};
    int base = 0;
    for (int group = 0; group < 4; ++group) {
        size_t relative = offset - starts[group];
        if (relative < counts[group] * sizeof(Mtx) && relative % sizeof(Mtx) == 0)
            return base + relative / sizeof(Mtx);
        base += counts[group];
    }
    return -1;
}

void web_interpolate_matrix(const void *address, float matrix[4][4]) {
    /* Menus and scene transitions often reuse matrix storage for unrelated
     * objects. Only interpolate stable race slots and explicitly registered actors. */
    if (gGamestate != RACING) return;
    int slot = matrix_slot(address);
    if (slot < 0) return;
    struct WebMatrixHistory *previous = &history[slot];
    int identity = slot >= WEB_ITEM_BASE ? item_identity[slot-WEB_ITEM_BASE] :
        slot >= WEB_LAKITU_BASE ? lakitu[slot-WEB_LAKITU_BASE].kind : 0;
    /* Camera cuts, respawns and abrupt rotations snap instead of smearing.
     * Perspective matrices use a different guard from affine transforms. */
    if (web_matrix_history_apply(previous, matrix, gGlobalTimer, identity,
            midpoint, can_interpolate, slot >= 4)) ++interpolated_matrices;
#ifdef WEB_AUTHORITY_CANDIDATE
    smooth_correction(slot, matrix);
#endif
}
