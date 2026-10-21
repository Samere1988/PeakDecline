#include "platform.h"
#include <emscripten/emscripten.h>
void LeoBootGame(uint8_t *rdram, recomp_context *ctx) {
    (void)rdram; (void)ctx;
    EM_ASM({ throw new Error('Mario Party native port: N64 disk boot is unsupported.'); });
}
/* Cartridge hardware profile: no 64DD is attached. This function probes the
 * 64DD boot-ROM signature at physical 0x06001010 (expected 0x2129fff8).
 * Returning zero selects the original cartridge path in LeoDriveExist. */
void func_800827C0(uint8_t *rdram,recomp_context *ctx){(void)rdram;ctx->r2=0;}
