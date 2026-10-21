#ifndef WEB_DISPLAY_H
#define WEB_DISPLAY_H
#include <math.h>

#define WEB_RENDER_WIDTH 1920
#define WEB_RENDER_HEIGHT 1080
#define WEB_WIDE_SCALE 0.75f

/* Private no-op display-list tags: layout policy travels with draw commands. */
#define WEB_MENU_BEGIN 0x574d0001U
#define WEB_MENU_END   0x574d0000U
#define WEB_MAP_BEGIN 0x57500000U
#define WEB_MAP_END 0x57600000U
#define WEB_MAP_TAG(x,y) (WEB_MAP_BEGIN | (((unsigned)(x)&1023U)<<10) | ((unsigned)(y)&1023U))

static inline int web_projection_is_ortho(const float projection[4][4]) {
    /* MK64 multiplies the camera into its projection stack. A perspective
     * view then has a nonzero[3][3] too: only the W column distinguishes it
     * from an affine/orthographic view used by the HUD and sky gradient. */
    return fabsf(projection[0][3])+fabsf(projection[1][3])+fabsf(projection[2][3]) < 0.0001f &&
           fabsf(projection[3][3]) > 0.5f;
}

/* Preserve the native 4:3 UI's proportions while anchoring race widgets to
 * their own widescreen view. World geometry uses a wider projection instead.
 * Full-screen clears/sky gradients must cover the complete drawing surface. */
static inline float web_ui_offset(float left, float right, float top, float bottom, int racing, int screen_mode) {
    float midpoint = (left + right) * 0.5f;
    float half = racing && screen_mode >= 2 ? 0.5f : 1.0f;
    float center = half == 0.5f ? (midpoint < 0 ? -0.5f : 0.5f) : 0.0f;
    float local = (midpoint - center) / half;
    float vertical_mid = (top + bottom) * 0.5f;
    float vertical_half = racing && (screen_mode == 1 || screen_mode == 3) ? 0.5f : 1.0f;
    float vertical_center = vertical_half == 0.5f ? (vertical_mid > 0 ? 0.5f : -0.5f) : 0.0f;
    float local_y = (vertical_mid - vertical_center) / vertical_half;
    // Keep LAP/TIME labels and their digits in one anchored top-row cluster.
    // Central item windows and pause/results text retain a centered layout.
    float threshold = local_y > 0.55f ? 0.12f : 0.50f;
    float anchor = racing ? (local < -threshold ? -0.25f : local > threshold ? 0.25f : 0.0f) : 0.0f;
    return center * (1.0f - WEB_WIDE_SCALE) + anchor * half;
}

/* The complete map is one widget, even when a marker crosses a HUD threshold. */
static inline float web_map_anchor(unsigned tag, int screen_mode) {
    float x = (float)((tag >> 10) & 1023U) / 160.0f - 1.0f;
    float y = 1.0f - (float)(tag & 1023U) / 120.0f;
    return web_ui_offset(x,x,y,y,1,screen_mode);
}
#endif
