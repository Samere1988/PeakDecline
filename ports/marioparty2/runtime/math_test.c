/* Exercise the translated cartridge entry points, including the leading-NOP
 * squared-length entry used by the train, instead of a host math substitute. */
#include "recomp.h"
#include <emscripten/emscripten.h>
#include <string.h>
void func_800B1840_B2440(uint8_t *, recomp_context *);
void func_800B1870_B2470(uint8_t *, recomp_context *);
static uint8_t ram[8*1024*1024];
EMSCRIPTEN_KEEPALIVE int mp_test_math(void) {
    const float vectors[][4]={{3,4,0,5},{0,0,-2,2},{115.625f,0,0,115.625f},{0,0,0,0}};
    for(unsigned i=0;i<sizeof(vectors)/sizeof(vectors[0]);i++) {
        recomp_context ctx={0};ctx.r29=(int32_t)0x807ff000;
        for(int length=0;length<2;length++) {
            ctx.f0.fl=-123;ctx.f12.fl=vectors[i][0];ctx.f14.fl=vectors[i][1];
            uint32_t z;memcpy(&z,&vectors[i][2],sizeof(z));ctx.r6=(int32_t)z;
            if(length)func_800B1870_B2470(ram,&ctx);
            else func_800B1840_B2440(ram,&ctx);
            float expected=length?vectors[i][3]:vectors[i][3]*vectors[i][3];
            if(ctx.f0.fl!=expected||ctx.r29!=(int32_t)0x807ff000)return 1+i*2+length;
        }
    }
    return 0;
}
