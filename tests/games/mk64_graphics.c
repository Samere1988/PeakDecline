#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <string.h>
#include "../../ports/mk64/include/web_display.h"
#include "../../ports/mk64/include/web_texture_hash.h"

int main(void) {
    float projection[4][4]={{1,0,0,0},{0,1,0,0},{0,0,1,0},{0,0,0,1}};
    assert(web_projection_is_ortho(projection));
    projection[2][3]=-1;projection[3][3]=800;
    assert(!web_projection_is_ortho(projection)); // perspective with camera translation
    uint32_t crc, adler;
    const uint8_t *known=(const uint8_t*)"123456789";
    web_texture_hash(known,9,&crc,&adler);
    assert(crc==0xcbf43926U && adler==0x091e01deU);
    web_texture_hash(known,0,&crc,&adler);
    assert(crc==0 && adler==1);
    uint8_t pixels[8192];memset(pixels,255,sizeof(pixels));
    web_texture_hash(pixels,sizeof(pixels),&crc,&adler);
    assert(crc==0xb4293435U && adler==0xf4a3e1d2U);

    /* Actual top-row layout: a LAP label/digits and TIME label/digits must
     * share their cluster's shift despite straddling the old .35 threshold. */
    float lap=web_ui_offset(-.60f,-.40f,.90f,.75f,1,0);
    float lap_digits=web_ui_offset(-.30f,-.15f,.90f,.75f,1,0);
    float time=web_ui_offset(.20f,.40f,.90f,.75f,1,0);
    float time_digits=web_ui_offset(.55f,.90f,.90f,.75f,1,0);
    assert(lap==-.25f && lap_digits==lap);
    assert(time==.25f && time_digits==time);
    assert(web_ui_offset(-.10f,.10f,.90f,.65f,1,0)==0);
    assert(web_ui_offset(-.30f,.30f,.20f,-.10f,1,0)==0);
    assert(web_ui_offset(-.90f,-.70f,.30f,.10f,0,0)==0);

    /* Results glyphs cross HUD thresholds. With menu layout selected, both
     * ends of the same name/score row retain exactly the same transform. */
    assert(web_ui_offset(-.60f,-.55f,.90f,.75f,0,1)==0);
    assert(web_ui_offset(-.10f,-.05f,.90f,.75f,0,1)==0);
    assert(web_ui_offset(.30f,.35f,-.20f,-.30f,0,3)==0);
    assert(web_ui_offset(.70f,.75f,-.20f,-.30f,0,3)==0);

    /* A moving map marker can cross the per-primitive anchor boundary.
     * The map's tag keeps outline, dots and kart icons in one coordinate space. */
    unsigned map=WEB_MAP_TAG(270,180);
    assert(web_map_anchor(map,0)==.25f);
    assert(web_ui_offset(.40f,.44f,-.2f,-.3f,1,0)==0);
    assert(web_ui_offset(.70f,.74f,-.2f,-.3f,1,0)==.25f);
    for(int mode=0;mode<4;mode++) {
        float offset=web_map_anchor(map,mode);
        float outline=.7f*WEB_WIDE_SCALE+offset;
        float dot=.42f*WEB_WIDE_SCALE+offset;
        assert(fabsf((outline-dot)-(.7f-.42f)*WEB_WIDE_SCALE)<.000001f);
    }

    /* Left/right widgets reach their respective edges in 4P split-screen,
     * with their sprite dimensions scaled uniformly rather than stretched. */
    float left=web_ui_offset(-1,-.9f,.9f,.8f,1,3);
    float right=web_ui_offset(.9f,1,.9f,.8f,1,3);
    assert(fabsf(-1*WEB_WIDE_SCALE+left+1)<.000001f);
    assert(fabsf(1*WEB_WIDE_SCALE+right-1)<.000001f);
    puts("MK64 graphics: decoded texture hashes, grouped HUD anchors and split-screen edges passed.");
}
