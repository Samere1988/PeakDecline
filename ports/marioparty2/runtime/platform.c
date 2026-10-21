#include "platform.h"
#include <emscripten/emscripten.h>
void LeoBootGame(uint8_t *rdram, recomp_context *ctx) {
    (void)rdram; (void)ctx;
    EM_ASM({ throw new Error('Mario Party native port: N64 disk boot is unsupported.'); });
}
