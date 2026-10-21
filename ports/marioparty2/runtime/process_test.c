#include "os.h"
#include <assert.h>
#include <emscripten/emscripten.h>
#include <string.h>
void mp_process_reset(void);
void HuPrcCall(uint8_t *,recomp_context *);
void HuPrcSleep(uint8_t *,recomp_context *);
void HuPrcTerminate(uint8_t *,recomp_context *);
static uint8_t ram[8*1024*1024];
static unsigned stage,done;
#define P 0x80104000u
static void body(uint8_t *rdram,recomp_context *ctx){
    assert(stage==0);stage=1;ctx->r4=2;HuPrcSleep(rdram,ctx);
    assert(stage==1);stage=2;
}
static void destructor(uint8_t *rdram,recomp_context *ctx){(void)rdram;(void)ctx;assert(stage==2);stage=3;}
static void end(uint8_t *rdram,recomp_context *ctx){ctx->r4=(int32_t)P;HuPrcTerminate(rdram,ctx);}
static void unlink_proc(uint8_t *rdram,recomp_context *ctx){(void)rdram;assert((uint32_t)ctx->r5==P);mp_os_write(0x800eb8ec,0);}
static void free_proc(uint8_t *rdram,recomp_context *ctx){(void)rdram;assert((uint32_t)ctx->r4==0x80200000&&stage==3);stage=4;}
recomp_func_t *mp_test_process_function(int32_t address){
    switch((uint32_t)address){
        case 0x80002000:return body;case 0x80002004:return destructor;
        case 0x8007d9a4:return end;case 0x8007d598:return unlink_proc;case 0x80040dc8:return free_proc;
    }
    assert(0);return NULL;
}
EMSCRIPTEN_KEEPALIVE void mp_test_process(void){
    mp_process_reset();memset(ram,0,sizeof(ram));mp_os_reset(ram);stage=done=0;
    mp_os_write(0x800eb8ec,P);mp_os_write(0x800eb8f4,0x00010000);
    mp_os_write(P+0x18,0x80200000);mp_os_write(P+0x2c,0x807df000);mp_os_write(P+0x30,0x80002000);mp_os_write(P+0x88,0x80002004);
    recomp_context ctx;mp_context_init(&ctx);ctx.r29=(int32_t)0x807ff000;
    ctx.r4=1;HuPrcCall(ram,&ctx);assert(stage==1&&mp_os_read(P+0x24)==2);
    ctx.r4=1;HuPrcCall(ram,&ctx);assert(stage==1&&mp_os_read(P+0x24)==1);
    ctx.r4=1;HuPrcCall(ram,&ctx);assert(stage==1&&mp_os_read(P+0x24)==0);
    ctx.r4=1;HuPrcCall(ram,&ctx);assert(stage==4);
    assert(mp_os_read(0x800eb8ec)==0&&mp_os_read(0x800eb8f0)==0&&mp_os_read(0x800eb8f4)==0);
    mp_process_reset();done=1;
}
EMSCRIPTEN_KEEPALIVE unsigned mp_test_process_result(void){return done;}
