#ifndef PEAK_MP_PLATFORM_H
#define PEAK_MP_PLATFORM_H
#include "recomp.h"
/* N64Recomp ignores this self-modifying disk boot path; do not silently stub it. */
void LeoBootGame(uint8_t *rdram, recomp_context *ctx);
void osPfsIsPlug_recomp(uint8_t *rdram, recomp_context *ctx);
void setjmp_recomp(uint8_t *rdram, recomp_context *ctx);
#endif
