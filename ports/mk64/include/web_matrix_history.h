#ifndef WEB_MATRIX_HISTORY_H
#define WEB_MATRIX_HISTORY_H
#include "web_matrix_interpolation.h"

struct WebMatrixHistory {
    float values[4][4];
    unsigned frame;
    int valid;
    int identity;
};

/* Only the completed simulation frame writes history. A role change or a gap
 * in visibility must not borrow a previous object's/animation's transform. */
static inline int web_matrix_history_apply(struct WebMatrixHistory *previous,
        float matrix[4][4], unsigned frame, int identity, int midpoint,
        int can_interpolate, int affine) {
    if (!midpoint) {
        memcpy(previous->values, matrix, sizeof(previous->values));
        previous->frame = frame;
        previous->valid = 1;
        previous->identity = identity;
        return 0;
    }
    if (!can_interpolate || !previous->valid || previous->identity != identity ||
        previous->frame + 1 != frame) return 0;
    return web_matrix_midpoint(previous->values, matrix, affine);
}
#endif
