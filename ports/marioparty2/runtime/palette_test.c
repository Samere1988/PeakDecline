/* Real display-list regression: RGBA-tagged indexed textures must produce the
 * same pixels as CI-tagged textures, and reflect a replacement palette. */
#include <stdint.h>
#include <string.h>
#include <PR/mbi.h>
#include <emscripten/emscripten.h>
void mp_render(uint8_t *,uint32_t);
static uint8_t ram[8*1024*1024];
EMSCRIPTEN_KEEPALIVE void mp_test_palette(int rgba,int fourbit,int swapped) {
    memset(ram,0,sizeof(ram));
    for(int i=0;i<256;i++) {
        uint16_t color=(i&1)^swapped ? 0xf801 : 0x07c1;
        ram[(0x3000+i*2)^3]=color>>8;ram[(0x3001+i*2)^3]=color;
    }
    for(int i=0;i<(fourbit?32:64);i++)ram[(0x4000+i)^3]=fourbit?0x12:1+(i&1);
    Gfx *p=(Gfx *)(ram+0x1000);
    gDPSetScissor(p++,G_SC_NON_INTERLACE,0,0,320,240);
    gDPSetColorImage(p++,G_IM_FMT_RGBA,G_IM_SIZ_16b,320,0x100000);
    gDPSetCycleType(p++,G_CYC_FILL);gDPSetFillColor(p++,0x00010001);gDPFillRectangle(p++,0,0,319,239);
    gDPPipeSync(p++);gDPSetCycleType(p++,G_CYC_COPY);
    gDPSetTextureLUT(p++,G_TT_RGBA16);gDPSetTextureFilter(p++,G_TF_POINT);
    gDPSetTexturePersp(p++,G_TP_NONE);gDPSetAlphaCompare(p++,G_AC_NONE);
    gDPSetRenderMode(p++,G_RM_NOOP,G_RM_NOOP2);
    gDPSetCombineMode(p++,G_CC_DECALRGBA,G_CC_DECALRGBA);
    gDPLoadTLUT_pal256(p++,(void *)0x3000);
    if(fourbit){gDPLoadTextureBlock_4b(p++,(void *)0x4000,rgba?G_IM_FMT_RGBA:G_IM_FMT_CI,8,8,0,G_TX_CLAMP,G_TX_CLAMP,3,3,G_TX_NOLOD,G_TX_NOLOD);}
    else {gDPLoadTextureBlock(p++,(void *)0x4000,rgba?G_IM_FMT_RGBA:G_IM_FMT_CI,G_IM_SIZ_8b,8,8,0,G_TX_CLAMP,G_TX_CLAMP,3,3,G_TX_NOLOD,G_TX_NOLOD);}
    gSPTextureRectangle(p++,32<<2,32<<2,39<<2,39<<2,G_TX_RENDERTILE,0,0,4<<10,1<<10);
    gSPEndDisplayList(p++);mp_render(ram,0x1000);
}
