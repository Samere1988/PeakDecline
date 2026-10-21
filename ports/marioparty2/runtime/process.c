/* Stackful host implementation of the pinned game's HuPrc scheduler. Guest
 * process records, allocation, ordering, child links and destructors stay in
 * the translated game. Only non-local control transfer is replaced. */
#include "os.h"
#include <emscripten/fiber.h>
#include <emscripten/emscripten.h>
#include <stdlib.h>
#include <string.h>
#define PROC_TOP 0x800eb8ecu
#define PROC_CURRENT 0x800eb8f0u
#define PROC_COUNT 0x800eb8f4u
#define STACK_SIZE 131072
#define MAX_PROCESSES 256
struct ProcessFiber {
    uint32_t address;int finished;
    recomp_context ctx;
    emscripten_fiber_t fiber;
    uint8_t *stack,*unwind;
};
static struct ProcessFiber processes[MAX_PROCESSES],*running;
static emscripten_fiber_t dispatcher;
static uint8_t dispatch_unwind[STACK_SIZE];
static uint8_t *ram;
static void fail(const char *message){EM_ASM({throw new Error(UTF8ToString($0));},message);abort();}
static uint16_t read_half(uint32_t a){uint32_t word=mp_os_read(a&~3u);return a&2?word:word>>16;}
static void write_half(uint32_t a,uint16_t value){uint32_t word=mp_os_read(a&~3u);mp_os_write(a&~3u,a&2?(word&0xffff0000)|value:(word&0xffff)|((uint32_t)value<<16));}
void mp_process_reset(void){
    for(int i=0;i<MAX_PROCESSES;i++){free(processes[i].stack);free(processes[i].unwind);}
    memset(processes,0,sizeof(processes));running=NULL;
}
static void enter(void *opaque){
    struct ProcessFiber *p=opaque;
    get_function((int32_t)mp_os_read(p->address+0x30))(ram,&p->ctx);
    get_function((int32_t)0x8007d9a4)(ram,&p->ctx); /* HuPrcEnd on return */
    fail("Mario Party process returned after termination");
}
static void init(struct ProcessFiber *p,uint32_t address){
    p->address=address;p->finished=0;
    if(!p->stack)p->stack=malloc(STACK_SIZE);
    if(!p->unwind)p->unwind=malloc(STACK_SIZE);
    if(!p->stack||!p->unwind)fail("Mario Party process stack allocation failed");
    mp_context_init(&p->ctx);p->ctx.r29=(int32_t)mp_os_read(address+0x2c);
    emscripten_fiber_init(&p->fiber,enter,p,p->stack,STACK_SIZE,p->unwind,STACK_SIZE);
}
static struct ProcessFiber *find(uint32_t address){
    for(int i=0;i<MAX_PROCESSES;i++)if(processes[i].address==address)return &processes[i];
    for(int i=0;i<MAX_PROCESSES;i++)if(!processes[i].address){init(&processes[i],address);return &processes[i];}
    fail("Mario Party process limit reached");return NULL;
}
static void suspend(void){
    if(!running)fail("Mario Party process suspension outside dispatcher");
    emscripten_fiber_swap(&running->fiber,&dispatcher);
}
void HuPrcSleep(uint8_t *rdram,recomp_context *ctx){
    (void)rdram;uint32_t p=mp_os_read(PROC_CURRENT);
    if(ctx->r4&&read_half(p+0x1c)!=3){write_half(p+0x1c,1);mp_os_write(p+0x24,ctx->r4);}
    suspend();
}
void HuPrcChildWatch(uint8_t *rdram,recomp_context *ctx){
    (void)rdram;(void)ctx;uint32_t p=mp_os_read(PROC_CURRENT);
    if(mp_os_read(p+8)){write_half(p+0x1c,2);suspend();}
}
void HuPrcTerminate(uint8_t *rdram,recomp_context *ctx){
    uint32_t p=ctx->r4;if(!running||running->address!=p)fail("Mario Party terminated a noncurrent process");
    uint32_t destructor=mp_os_read(p+0x88);
    if(destructor)get_function((int32_t)destructor)(rdram,ctx);
    ctx->r4=(int32_t)PROC_TOP;ctx->r5=(int32_t)p;get_function((int32_t)0x8007d598)(rdram,ctx);
    write_half(PROC_COUNT,read_half(PROC_COUNT)-1);
    running->finished=1;suspend();fail("Mario Party resumed a terminated process");
}
void HuPrcCall(uint8_t *rdram,recomp_context *ctx){
    ram=rdram;int32_t time=ctx->r4;
    emscripten_fiber_init_from_current_context(&dispatcher,dispatch_unwind,sizeof(dispatch_unwind));
    uint32_t p=mp_os_read(PROC_TOP);unsigned visited=0;
    while(p){
        if(++visited>MAX_PROCESSES)fail("Mario Party process list cycle or limit");
        mp_os_write(PROC_CURRENT,p);
        unsigned mode=read_half(p+0x1c),flags=read_half(p+0x1e);
        if(!(flags&1)||mode==3){
            if(mode==1){
                int32_t sleep=mp_os_read(p+0x24);
                if(sleep>0){sleep-=time;mp_os_write(p+0x24,sleep>0?sleep:0);if(sleep<=0)write_half(p+0x1c,0);}
            }else if(mode!=2||!mp_os_read(p+8)){
                if(mode==2)write_half(p+0x1c,0);
                running=find(p);
                if(mode==3){mp_os_write(p+0x30,0x8007d9a4);init(running,p);}
                emscripten_fiber_swap(&dispatcher,&running->fiber);
                uint32_t next=mp_os_read(p);
                if(running->finished){
                    ctx->r4=(int32_t)mp_os_read(p+0x18);get_function((int32_t)0x80040dc8)(rdram,ctx);
                    free(running->stack);free(running->unwind);memset(running,0,sizeof(*running));
                }
                running=NULL;p=next;continue;
            }
        }
        p=mp_os_read(p);
    }
    mp_os_write(PROC_CURRENT,0);
}
