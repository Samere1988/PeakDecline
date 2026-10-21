#ifndef WEB_MATRIX_INTERPOLATION_H
#define WEB_MATRIX_INTERPOLATION_H

#include <math.h>
#include <string.h>

/* Matrices use the game's row-vector convention: basis in rows 0..2 and
 * translation in row 3. Keep this helper independent of game/renderer state
 * so the same interpolation path can be exercised by the native regression. */
static inline int web_affine_basis(const float matrix[4][4], float unit[3][3],
                                   float length[3], float *handedness) {
    for (int row = 0; row < 3; ++row) {
        if (fabsf(matrix[row][3]) > 0.0001f) return 0;
        length[row] = sqrtf(matrix[row][0] * matrix[row][0] +
                            matrix[row][1] * matrix[row][1] +
                            matrix[row][2] * matrix[row][2]);
        if (!isfinite(length[row]) || length[row] < 0.0001f) return 0;
        for (int column = 0; column < 3; ++column)
            unit[row][column] = matrix[row][column] / length[row];
    }
    if (fabsf(matrix[3][3] - 1.0f) > 0.0001f) return 0;
    *handedness =
        unit[0][0] * (unit[1][1] * unit[2][2] - unit[1][2] * unit[2][1]) -
        unit[0][1] * (unit[1][0] * unit[2][2] - unit[1][2] * unit[2][0]) +
        unit[0][2] * (unit[1][0] * unit[2][1] - unit[1][1] * unit[2][0]);
    /* A normalized determinant near zero means the basis has collapsed or
     * acquired substantial shear, even when its individual axes have length. */
    return fabsf(*handedness) >= 0.5f;
}

/* Return whether interpolation changed the matrix. Rejection leaves the
 * current transform untouched, including when the midpoint itself is invalid.
 * Perspective matrices intentionally do not use affine basis tests. */
static inline int web_matrix_midpoint(const float previous[4][4],
                                      float current[4][4], int affine) {
    float candidate[4][4];
    int changed = 0;
    for (int row = 0; row < 4; ++row) for (int column = 0; column < 4; ++column) {
        float a = previous[row][column], b = current[row][column];
        if (!isfinite(a) || !isfinite(b) ||
            fabsf(a - b) > (row == 3 ? 500.0f : 0.75f)) return 0;
        candidate[row][column] = a * 0.5f + b * 0.5f;
        changed |= candidate[row][column] != b;
    }
    if (affine) {
        float old_unit[3][3], new_unit[3][3], mid_unit[3][3];
        float old_length[3], new_length[3], mid_length[3];
        float old_hand, new_hand, mid_hand;
        if (!web_affine_basis(previous, old_unit, old_length, &old_hand) ||
            !web_affine_basis(current, new_unit, new_length, &new_hand) ||
            !web_affine_basis(candidate, mid_unit, mid_length, &mid_hand)) return 0;
        if (old_hand * new_hand <= 0.0f || old_hand * mid_hand <= 0.0f) return 0;
        for (int row = 0; row < 3; ++row) {
            float dot = 0.0f;
            for (int column = 0; column < 3; ++column)
                dot += old_unit[row][column] * new_unit[row][column];
            /* Reject rotations above 60 degrees per simulation frame regardless
             * of kart size. Absolute element deltas alone miss small billboards
             * rotating 180 degrees, whose arithmetic midpoint has zero width. */
            if (dot < 0.5f || old_length[row] > new_length[row] * 2.0f ||
                new_length[row] > old_length[row] * 2.0f ||
                mid_length[row] < fminf(old_length[row], new_length[row]) * 0.5f) return 0;
        }
    }
    memcpy(current, candidate, sizeof(candidate));
    return changed;
}

#endif
