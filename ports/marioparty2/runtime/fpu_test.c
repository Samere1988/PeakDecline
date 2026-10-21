#include "recomp.h"
#include <emscripten/emscripten.h>
EMSCRIPTEN_KEEPALIVE int mp_test_fpu(void){
    recomp_context first={0},second={0},*ctx=&first;
    set_cop1_cs(1);if(CVT_W_S(2.9f)!=2||CVT_W_D(-2.9)!=-2)return 1;
    ctx=&second;if(get_cop1_cs()!=0||CVT_W_S(2.5f)!=2||CVT_W_D(3.5)!=4)return 2;
    set_cop1_cs(2);if(CVT_W_S(2.1f)!=3||CVT_W_D(-2.9)!=-2)return 3;
    set_cop1_cs(3);if(CVT_W_D(2.9)!=2||CVT_W_S(-2.1f)!=-3)return 4;
    ctx=&first;if(get_cop1_cs()!=1||CVT_W_S(89.9f)!=89)return 5;
    if(CVT_W_D(NAN)!=INT32_MIN||CVT_W_D(INFINITY)!=INT32_MIN)return 6;
    return 0;
}
