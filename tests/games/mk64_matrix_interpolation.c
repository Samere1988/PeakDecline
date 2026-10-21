/* Run with a native C compiler, without the game, ROM or browser:
 * cc -std=c11 -Wall -Wextra -Werror tests/games/mk64_matrix_interpolation.c \
 *    -lm -o /tmp/mk64-matrix-test && /tmp/mk64-matrix-test
 */
#include <assert.h>
#include <stdio.h>
#include "../../ports/mk64/include/web_matrix_interpolation.h"

static void yaw_matrix(float matrix[4][4], float degrees, float scale) {
    float angle = degrees * 0.017453292519943295f;
    memset(matrix, 0, 16 * sizeof(float));
    matrix[0][0] = matrix[2][2] = cosf(angle) * scale;
    matrix[0][2] = -sinf(angle) * scale;
    matrix[2][0] = sinf(angle) * scale;
    matrix[1][1] = scale;
    matrix[3][3] = 1.0f;
}

static void unchanged_when_rejected(const float previous[4][4],
                                     float current[4][4], int affine) {
    float original[4][4];
    memcpy(original, current, sizeof(original));
    assert(!web_matrix_midpoint(previous, current, affine));
    assert(memcmp(original, current, sizeof(original)) == 0);
}

int main(void) {
    float previous[4][4], current[4][4], original[4][4];
    /* Smooth driving still produces a distinct camera/kart midpoint. */
    yaw_matrix(previous, 20.0f, 0.75f);
    yaw_matrix(current, 24.0f, 0.75f);
    previous[3][0] = 100.0f;
    current[3][0] = 110.0f;
    memcpy(original, current, sizeof(original));
    assert(web_matrix_midpoint(previous, current, 1));
    for (int row = 0; row < 4; ++row) for (int column = 0; column < 4; ++column)
        assert(current[row][column] == previous[row][column] * 0.5f + original[row][column] * 0.5f);
    assert(current[3][0] == 105.0f);

    /* Actual lightning kart scale: character .75 * player size .7. A half-turn
     * passes the old .75 component guard but collapses both horizontal axes. */
    yaw_matrix(previous, 45.0f, 0.75f * 0.7f);
    yaw_matrix(current, 225.0f, 0.75f * 0.7f);
    for (int row = 0; row < 4; ++row) for (int column = 0; column < 4; ++column)
        assert(fabsf(previous[row][column] - current[row][column]) <= 0.75f);
    float collapsed_x = (previous[0][0] + current[0][0]) * 0.5f;
    float collapsed_z = (previous[0][2] + current[0][2]) * 0.5f;
    assert(collapsed_x * collapsed_x + collapsed_z * collapsed_z < 0.000001f);
    unchanged_when_rejected(previous, current, 1);

    /* Rotation rejection must not depend on the absolute scale of the kart. */
    yaw_matrix(previous, 0.0f, 0.05f);
    yaw_matrix(current, 120.0f, 0.05f);
    unchanged_when_rejected(previous, current, 1);

    /* Ordinary shrinking can still be interpolated. Abrupt scale changes, a
     * zero-length axis, singular/sheared bases and handedness flips cannot. */
    yaw_matrix(previous, 0.0f, 0.75f);
    yaw_matrix(current, 0.0f, 0.525f);
    assert(web_matrix_midpoint(previous, current, 1));
    assert(fabsf(current[0][0] - 0.6375f) < 0.000001f);
    yaw_matrix(current, 0.0f, 0.1f);
    unchanged_when_rejected(previous, current, 1);
    yaw_matrix(previous, 0.0f, 0.5f);
    yaw_matrix(current, 0.0f, 0.5f);
    current[0][0] = 0.000001f;
    unchanged_when_rejected(previous, current, 1);
    yaw_matrix(current, 0.0f, 0.5f);
    memcpy(current[2], current[0], sizeof(current[2]));
    unchanged_when_rejected(previous, current, 1);
    yaw_matrix(previous, 0.0f, 0.1f);
    yaw_matrix(current, 0.0f, 0.1f);
    current[0][0] = -current[0][0];
    unchanged_when_rejected(previous, current, 1);

    /* Consistently reflected affine transforms retain their handedness. */
    yaw_matrix(previous, 0.0f, 0.5f);
    yaw_matrix(current, 2.0f, 0.5f);
    for (int column = 0; column < 3; ++column) {
        previous[0][column] = -previous[0][column];
        current[0][column] = -current[0][column];
    }
    assert(web_matrix_midpoint(previous, current, 1));

    /* Projection matrices are non-affine by design: preserve perspective and
     * never normalize their basis or overwrite the homogeneous coordinates. */
    memset(previous, 0, sizeof(previous));
    previous[0][0] = 1.2f;
    previous[1][1] = 1.5f;
    previous[2][2] = -1.01f;
    previous[2][3] = -1.0f;
    previous[3][2] = -2.01f;
    memcpy(current, previous, sizeof(current));
    current[0][0] = 1.3f;
    assert(web_matrix_midpoint(previous, current, 0));
    assert(current[0][0] == 1.25f);
    assert(current[2][3] == -1.0f && current[3][3] == 0.0f);
    unchanged_when_rejected(previous, current, 1);

    current[0][0] = NAN;
    unchanged_when_rejected(previous, current, 0);
    yaw_matrix(previous, 0.0f, 1.0f);
    yaw_matrix(current, 0.0f, 1.0f);
    current[3][0] = 501.0f;
    unchanged_when_rejected(previous, current, 1);
    puts("MK64 matrix interpolation: motion, small-kart half-turn, basis validity and projection checks passed.");
    return 0;
}
