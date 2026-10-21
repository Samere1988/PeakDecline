#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "../../ports/mk64/include/web_matrix_history.h"

static void translate(float m[4][4], float x, float z) {
    memset(m, 0, sizeof(float)*16);
    for(int i=0;i<4;i++) m[i][i]=1;
    m[3][0]=x;m[3][2]=z;
}
int main(void) {
    struct WebMatrixHistory camera={0}, lakitu={0};
    float c[4][4], l[4][4];
    translate(c,-100,1000);translate(l,100,-1040);
    web_matrix_history_apply(&camera,c,10,0,0,1,1);
    web_matrix_history_apply(&lakitu,l,10,4,0,1,1);
    translate(c,-108,1008);translate(l,108,-1048);
    assert(web_matrix_history_apply(&camera,c,11,0,1,1,1));
    assert(web_matrix_history_apply(&lakitu,l,11,4,1,1,1));
    // Camera-relative depth stays 40 units: interpolating only the camera
    // previously changed it to 44, causing alternating sprite size.
    assert(c[3][2]+l[3][2]==-40);
    assert(c[3][0]+l[3][0]==0);
    assert(lakitu.frame==10 && lakitu.values[3][0]==100);
    translate(l,108,-1048);
    assert(!web_matrix_history_apply(&lakitu,l,11,5,1,1,1));
    assert(l[3][0]==108); // A new lap/finish/rescue role cannot reuse history.
    assert(!web_matrix_history_apply(&lakitu,l,12,4,1,1,1)); // visibility gap
    assert(!web_matrix_history_apply(&lakitu,l,11,4,1,0,1)); // scene cut
    web_matrix_history_apply(&lakitu,l,11,5,0,1,1);
    translate(l,116,-1056);
    assert(web_matrix_history_apply(&lakitu,l,12,5,1,1,1));
    assert(l[3][0]==112 && lakitu.frame==11);
    puts("MK64 matrix history: camera-relative depth, animation identity, visibility gaps and scene cuts passed.");
}
