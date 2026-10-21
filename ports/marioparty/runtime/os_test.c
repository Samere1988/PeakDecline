/* Tests hosted services with compiled C thread entries; no game substitutes are
 * linked into the cartridge boot diagnostic or future release. */
#include "os.h"
#include <assert.h>
#include <emscripten/emscripten.h>
#include <string.h>
static uint8_t ram[8*1024*1024];
static int trace[16],used,complete;
EMSCRIPTEN_KEEPALIVE int mp_test_result(void){return complete;}
#define Q 0x80100000u
#define OUT 0x80100080u
static void mask(recomp_context *ctx,uint32_t value,uint32_t expected){
    ctx->r4=value;osSetIntMask_recomp(ram,ctx);assert(ctx->r2==expected);
}
static void mark(int n){assert(used<16);trace[used++]=n;}
static void message(recomp_context *ctx,int send,int value,int block){
    ctx->r4=(int32_t)Q;ctx->r5=send?value:(int32_t)OUT;ctx->r6=block;
    if(send)osSendMesg_recomp(ram,ctx);else osRecvMesg_recomp(ram,ctx);
}
static void create(recomp_context *ctx,int id,int priority){
    ctx->r4=(int32_t)(0x80101000u+id*0x200);ctx->r5=id;ctx->r6=(int32_t)(0x80001000+id*4);ctx->r7=0;
    mp_os_write((uint32_t)ctx->r29+16,0x807f0000-id*0x1000);
    mp_os_write((uint32_t)ctx->r29+20,priority);
    osCreateThread_recomp(ram,ctx);osStartThread_recomp(ram,ctx);
}
static void high(uint8_t *rdram,recomp_context *ctx){
    (void)rdram;assert(ctx->f_odd==&ctx->f0.u32h);mark(2);mask(ctx,0x3fff00,0x3fff01);
    message(ctx,0,0,1);assert(mp_os_read(OUT)==11);mask(ctx,0x3fff00,0x3fff00);mark(4);
    message(ctx,0,0,1);assert(mp_os_read(OUT)==22);mark(6);
}
static void low(uint8_t *rdram,recomp_context *ctx){
    (void)rdram;mark(3);mask(ctx,0x3fff01,0x3fff01);message(ctx,1,11,1);mark(5);
    message(ctx,1,22,1);mark(7);message(ctx,1,33,1);
    message(ctx,1,44,1);mark(8);
}
static void root(uint8_t *rdram,recomp_context *ctx){
    (void)rdram;ctx->r29=(int32_t)0x807ff000;mark(1);
    create(ctx,1,10);create(ctx,2,2);
    message(ctx,0,0,1);assert(mp_os_read(OUT)==33);mark(9);
    message(ctx,0,0,1);assert(mp_os_read(OUT)==44);
}
recomp_func_t *mp_test_process_function(int32_t address);
recomp_func_t *get_function(int32_t address){
    switch((uint32_t)address){case 0x80001000:return root;case 0x80001004:return high;case 0x80001008:return low;}
    return mp_test_process_function(address);
}
EMSCRIPTEN_KEEPALIVE int mp_test_os(void){
    complete=0;memset(ram,0,sizeof(ram));mp_os_reset(ram);recomp_context ctx;mp_context_init(&ctx);
    assert(mp_os_read(0x80000300)==1);assert(mp_os_read(0x80000318)==sizeof(ram));
    mp_os_write(0x800c7724,62500000);__osInitialize_common_recomp(ram,&ctx);
    assert(mp_os_read(0x800c7724)==46875000);assert(mp_os_read(0x800c7728)==48681812);
    ctx.r4=(int32_t)Q;ctx.r5=(int32_t)(Q+0x40);ctx.r6=2;osCreateMesgQueue_recomp(ram,&ctx);
    message(&ctx,0,0,0);assert((int64_t)ctx.r2==-1);
    message(&ctx,1,10,0);message(&ctx,1,20,0);message(&ctx,1,30,0);assert((int64_t)ctx.r2==-1);
    message(&ctx,0,0,0);assert(mp_os_read(OUT)==10);
    ctx.r4=(int32_t)Q;ctx.r5=30;ctx.r6=0;osJamMesg_recomp(ram,&ctx);
    message(&ctx,0,0,0);assert(mp_os_read(OUT)==30);
    message(&ctx,0,0,0);assert(mp_os_read(OUT)==20);
    message(&ctx,1,40,0);message(&ctx,0,0,0);assert(mp_os_read(OUT)==40);
    ctx.r4=(int32_t)Q;ctx.r5=(int32_t)(Q+0x40);ctx.r6=1;osCreateMesgQueue_recomp(ram,&ctx);
    used=0;mp_os_boot(0x80001000);
    assert(used==9);for(int i=0;i<used;i++)assert(trace[i]==i+1);
    assert(mp_os_run()==0);assert(mp_os_read(Q+8)==0);
    ctx.r4=(int32_t)Q;ctx.r5=(int32_t)(Q+0x40);ctx.r6=2;osCreateMesgQueue_recomp(ram,&ctx);
    osCreateViManager_recomp(ram,&ctx);
    ctx.r4=(int32_t)Q;ctx.r5=123;ctx.r6=2;osViSetEvent_recomp(ram,&ctx);
    mp_os_tick();message(&ctx,0,0,0);assert((int64_t)ctx.r2==-1);
    mp_os_tick();message(&ctx,0,0,0);assert(mp_os_read(OUT)==123);
    osGetTime_recomp(ram,&ctx);assert(ctx.r2==0&&ctx.r3==1562500);
    ctx.r4=(int32_t)0x80123456;osVirtualToPhysical_recomp(ram,&ctx);assert(ctx.r2==0x123456);
    ctx.r4=(int32_t)0xb0001234;osVirtualToPhysical_recomp(ram,&ctx);assert(ctx.r2==0x10001234);
    ctx.r4=0;osVirtualToPhysical_recomp(ram,&ctx);assert((int64_t)ctx.r2==-1);
    ctx.r5=(int32_t)(OUT+16);ctx.r6=(int32_t)(OUT+32);osContInit_recomp(ram,&ctx);
    assert(mp_os_read(OUT+16)==0x01000000);assert(mp_os_read(OUT+32)==0x05000000);assert(mp_os_read(OUT+36)==0x05000008);
    mp_os_pad(0,0x8000,33,-34,1);ctx.r4=(int32_t)(OUT+64);osContGetReadData_recomp(ram,&ctx);
    assert(mp_os_read(OUT+64)==0x800021de);
    mp_os_write(OUT,0x01234567);mp_os_write(OUT+4,0x89abcdef);
    ctx.r5=63;ctx.r6=(int32_t)OUT;ctx.r7=8;osEepromLongWrite_recomp(ram,&ctx);assert(ctx.r2==0);
    mp_os_reset(ram);mp_os_write(OUT,0);mp_os_write(OUT+4,0);
    ctx.r5=63;ctx.r6=(int32_t)OUT;ctx.r7=8;osEepromLongRead_recomp(ram,&ctx);assert(ctx.r2==0);
    assert(mp_os_read(OUT)==0x01234567&&mp_os_read(OUT+4)==0x89abcdef);
    ctx.r7=16;osEepromLongRead_recomp(ram,&ctx);assert((int64_t)ctx.r2==-1);
    complete=used;return used;
}
