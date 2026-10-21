#include <cstdio>
#include <cstdlib>
#include <emscripten.h>
#include <emscripten/html5.h>
#include "xbox360/gfx_pc.h"
#include "xbox360/gfx_rendering_api.h"
#include "xbox360/gfx_window_manager_api.h"
#include "web_display.h"

extern "C" int web_graphics_baseline(void);
extern "C" unsigned web_render_width(void) { return web_graphics_baseline() ? 640 : WEB_RENDER_WIDTH; }
extern "C" unsigned web_render_height(void) { return web_graphics_baseline() ? 480 : WEB_RENDER_HEIGHT; }

extern GfxRenderingAPI gfx_opengl_api;
static void init(const char *, bool) {
    EmscriptenWebGLContextAttributes attrs;
    emscripten_webgl_init_context_attributes(&attrs);
    attrs.alpha = false;
    attrs.depth = true;
    // The native renderer applies a consistent post-process AA pass. Disable
    // implicit MSAA to avoid resolving a second full-size browser framebuffer.
    attrs.antialias = false;
    attrs.majorVersion = 1;
    emscripten_set_canvas_element_size("#mk64-canvas", web_render_width(), web_render_height());
    auto context = emscripten_webgl_create_context("#mk64-canvas", &attrs);
    if (context <= 0) { std::fputs("WebGL initialization failed\n", stderr); std::abort(); }
    emscripten_webgl_make_context_current(context);
}
static void keys(bool (*)(int), bool (*)(int), void (*)(void)) {}
static void fullscreen_callback(void (*)(bool)) {}
static void fullscreen(bool) {}
static void loop(void (*callback)(void)) {
    emscripten_set_main_loop(callback, 0, true);
    // requestAnimationFrame stops in background tabs and stalls every player
    // waiting on that browser's next lockstep input.
    // swap_buffers_end already paces at 30 Hz. A second 33 ms timer here
    // makes each frame wait twice, before any multiplayer network delay.
    emscripten_set_main_loop_timing(EM_TIMING_SETTIMEOUT, 0);
}
static void dimensions(uint32_t *w, uint32_t *h) { *w = web_render_width(); *h = web_render_height(); }
static void noop() {}
static bool start() { return true; }
static double now() { return emscripten_get_now() / 1000.0; }
extern "C" int web_should_stop(void);
extern "C" int web_catching_up(void);
extern "C" double web_presentation_interval(void);
extern "C" void web_presented(void);
static void pace() {
    static double next = 0;
    web_presented();
    if (web_should_stop()) return;
#ifdef WEB_AUTHORITY_CANDIDATE
    return; /* External scheduler owns candidate frame pacing. */
#endif
    double current = emscripten_get_now();
    if (web_catching_up()) { next = current; emscripten_sleep(0); return; }
    const double interval = web_presentation_interval();
    next = next > current - 100 ? next + interval : current + interval;
    emscripten_sleep(next > current ? unsigned(next - current) : 0);
}
static GfxWindowManagerAPI window_api = {
    init, keys, fullscreen_callback, fullscreen, loop, dimensions,
    noop, start, noop, pace, now, noop
};
extern "C" void web_graphics_init() {
    gfx_init(&window_api, &gfx_opengl_api, "Mario Kart 64", false);
}
extern "C" void web_graphics_shutdown() { gfx_shutdown(); }
