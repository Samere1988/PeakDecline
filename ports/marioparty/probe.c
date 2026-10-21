/* Execute translated retail code. This is a translation probe, not a game runtime. */
#include "recomp.h"
#include <emscripten/emscripten.h>
static uint8_t memory[4 * 1024 * 1024];
static recomp_context context;
extern void rand8(uint8_t *, recomp_context *);
EMSCRIPTEN_KEEPALIVE void seed(uint32_t value) {
    uint8_t *rdram = memory;
    MEM_W(0xC2FF4, (gpr)0xFFFFFFFF80000000ULL) = value;
}
EMSCRIPTEN_KEEPALIVE uint32_t next_random(void) {
    rand8(memory, &context);
    return (uint32_t)context.r2;
}
