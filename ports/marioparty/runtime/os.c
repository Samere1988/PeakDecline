/* Hosted libultra subset. Guest functions are ahead-of-time compiled C, never
 * interpreted. Fibers retain their C call stacks across libultra blocking calls.
 * Hardware services not implemented here remain explicit errors in the probe. */
#include "os.h"
#include <emscripten/fiber.h>
#include <emscripten/emscripten.h>
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#define THREADS 32
#define STACK_BYTES (256*1024)
#define RAM_BYTES (8*1024*1024)
enum { UNUSED, STOPPED, READY, RUNNING, RECEIVE, SEND, DEAD };
typedef struct {
    uint32_t address, entry, queue, mask;
    int priority, state;
    uint64_t order;
    recomp_context ctx;
    emscripten_fiber_t fiber;
    _Alignas(16) uint8_t stack[STACK_BYTES], unwind[STACK_BYTES];
} Thread;
static Thread threads[THREADS];
static Thread *current;
static uint8_t *memory;
static emscripten_fiber_t host;
static uint8_t host_unwind[STACK_BYTES];
static uint64_t sequence;
static unsigned entered;
unsigned mp_os_entered(void){return entered;}
static uint32_t interrupt_mask;
static void error(const char *message) {
    EM_ASM({throw new Error(UTF8ToString($0));}, message);
    abort();
}
static uint32_t offset(uint32_t address, uint32_t size) {
    uint32_t physical=address & 0x1fffffffu;
    if ((address & 0xc0000000u)!=0x80000000u || physical>RAM_BYTES || size>RAM_BYTES-physical){
        char message[128];snprintf(message,sizeof(message),"Mario Party OS: invalid RDRAM pointer %08x size %u",address,size);error(message);
    }
    return physical;
}
uint32_t mp_os_read(uint32_t address) {
    if(address&3)error("Mario Party OS: unaligned word");
    return *(uint32_t *)(memory+offset(address,4));
}
void mp_os_write(uint32_t address,uint32_t value) {
    if(address&3)error("Mario Party OS: unaligned word");
    *(uint32_t *)(memory+offset(address,4))=value;
}
static void half(uint32_t address,uint16_t value) {
    *(uint16_t *)(memory+(offset(address,2)^2))=value;
}
void mp_context_init(recomp_context *ctx) {
    memset(ctx,0,sizeof(*ctx));ctx->f_odd=&ctx->f0.u32h;ctx->status_reg=0x2000ff03;
}
static void state(Thread *t,int value) {
    t->state=value;
    if(t->address)half(t->address+0x10,value==RUNNING?4:value==READY?2:(value==RECEIVE||value==SEND)?8:1);
    if(value==READY)t->order=++sequence;
}
static Thread *find(uint32_t address) {
    if(!address && current)return current;
    for(int i=0;i<THREADS;i++)if(threads[i].state!=UNUSED&&threads[i].address==address)return &threads[i];
    error("Mario Party OS: unknown thread");return NULL;
}
static void yield(void) {
    if(!current)error("Mario Party OS: blocking outside a thread");
    emscripten_fiber_swap(&current->fiber,&host);
}
static void preempt(void) {
    if(!current)return;
    for(int i=0;i<THREADS;i++)if(threads[i].state==READY && threads[i].priority>current->priority){
        state(current,READY);yield();return;
    }
}
static void enter(void *arg) {
    Thread *t=arg;++entered;
    get_function((int32_t)t->entry)(memory,&t->ctx);
    state(t,DEAD);yield();error("Mario Party OS: resumed a finished thread");
}
static Thread *allocate(uint32_t address,uint32_t entry,int priority) {
    Thread *t=NULL;
    for(int i=0;i<THREADS;i++)if(threads[i].state!=UNUSED&&threads[i].address==address){
        if(threads[i].state!=DEAD)error("Mario Party OS: duplicate live thread");
        t=&threads[i];break;
    }
    if(!t)for(int i=0;i<THREADS;i++)if(threads[i].state==UNUSED||threads[i].state==DEAD){t=&threads[i];break;}
    if(!t)error("Mario Party OS: thread limit reached");
    t->address=address;t->entry=entry;t->priority=priority;t->queue=0;t->mask=0x3fff01;
    mp_context_init(&t->ctx);state(t,STOPPED);
    emscripten_fiber_init(&t->fiber,enter,t,t->stack,sizeof(t->stack),t->unwind,sizeof(t->unwind));
    return t;
}
static void reset_devices(void);
static void reset_controllers(void);
void mp_os_reset(uint8_t *rdram) {
    reset_devices();reset_controllers();
    memory=rdram;current=NULL;sequence=0;entered=0;interrupt_mask=0x3fff01;
    memset(threads,0,sizeof(threads));
    /* IPL-provided cartridge globals: NTSC, cartridge boot, cold reset, 8 MiB. */
    mp_os_write(0x80000300,1);mp_os_write(0x80000308,0xb0000000);
    mp_os_write(0x8000030c,0);mp_os_write(0x80000318,RAM_BYTES);
}
int mp_os_run(void) {
    emscripten_fiber_init_from_current_context(&host,host_unwind,sizeof(host_unwind));
    int switches=0;
    for(;;){
        Thread *next=NULL;
        /* Priority zero is the cartridge's infinite idle loop. Yield to the host
         * instead; future VI/timer events will wake blocked game threads. */
        for(int i=0;i<THREADS;i++)if(threads[i].state==READY&&threads[i].priority>0 &&
            (!next||threads[i].priority>next->priority||(threads[i].priority==next->priority&&threads[i].order<next->order)))next=&threads[i];
        if(!next)break;
        if(++switches>10000)error("Mario Party OS: scheduler dispatch limit reached");
        current=next;interrupt_mask=next->mask;state(next,RUNNING);
        emscripten_fiber_swap(&host,&next->fiber);next->mask=interrupt_mask;current=NULL;
    }
    return switches;
}
void mp_os_boot(uint32_t entry) { Thread *t=allocate(0,entry,1);state(t,READY);mp_os_run(); }
void __osInitialize_common_recomp(uint8_t *rdram,recomp_context *ctx) {
    (void)rdram;(void)ctx;
    /* Guest-visible stores from this pinned ROM's initialize routine. Hardware
     * interrupt vectors, TLB and cache setup are replaced by hosted services. */
    mp_os_write(0x800f5458,1);
    uint64_t clock=((uint64_t)mp_os_read(0x800c7720)<<32)|mp_os_read(0x800c7724);
    clock=clock*3/4;mp_os_write(0x800c7720,clock>>32);mp_os_write(0x800c7724,clock);
    mp_os_write(0x800c7728,48681812);
    if(!mp_os_read(0x8000030c))for(unsigned i=0;i<64;i+=4)mp_os_write(0x8000031c+i,0);
}
void osCreateThread_recomp(uint8_t *rdram,recomp_context *ctx) {
    (void)rdram;uint32_t a=ctx->r4;offset(a,0x1b0);
    uint32_t stack=mp_os_read((uint32_t)ctx->r29+16);
    int priority=(int32_t)mp_os_read((uint32_t)ctx->r29+20);
    offset(stack-16,16);
    memset(memory+offset(a,0x1b0),0,0x1b0);
    Thread *t=allocate(a,ctx->r6,priority);
    t->ctx.r4=(int32_t)ctx->r7;t->ctx.r29=(int32_t)(stack-16);
    mp_os_write(a+4,priority);mp_os_write(a+0x14,ctx->r5);
    mp_os_write(a+0x11c,ctx->r6);
}
void osStartThread_recomp(uint8_t *rdram,recomp_context *ctx) {
    (void)rdram;Thread *t=find(ctx->r4);
    if(t->state==STOPPED)state(t,READY);
    preempt();
}
void osSetThreadPri_recomp(uint8_t *rdram,recomp_context *ctx) {
    (void)rdram;Thread *t=find(ctx->r4);t->priority=(int32_t)ctx->r5;
    if(t->address)mp_os_write(t->address+4,t->priority);
    if(t==current&&t->priority==0){state(t,READY);yield();}else preempt();
}
void osGetThreadPri_recomp(uint8_t *rdram,recomp_context *ctx) {(void)rdram;ctx->r2=find(ctx->r4)->priority;}
void osStopThread_recomp(uint8_t *rdram,recomp_context *ctx) {
    (void)rdram;Thread *t=find(ctx->r4);state(t,STOPPED);if(t==current)yield();
}
void osDestroyThread_recomp(uint8_t *rdram,recomp_context *ctx) {
    (void)rdram;Thread *t=find(ctx->r4);state(t,DEAD);if(t==current)yield();
}
void osSetIntMask_recomp(uint8_t *rdram,recomp_context *ctx) {(void)rdram;uint32_t old=interrupt_mask;interrupt_mask=ctx->r4;ctx->r2=old;}
/* Hosted memory is coherent: these guest cache maintenance calls need no flush. */
void osWritebackDCache_recomp(uint8_t *rdram,recomp_context *ctx){(void)rdram;(void)ctx;}
void osWritebackDCacheAll_recomp(uint8_t *rdram,recomp_context *ctx){(void)rdram;(void)ctx;}
void osInvalDCache_recomp(uint8_t *rdram,recomp_context *ctx){(void)rdram;(void)ctx;}
void osInvalICache_recomp(uint8_t *rdram,recomp_context *ctx){(void)rdram;(void)ctx;}
void osGetMemSize_recomp(uint8_t *rdram,recomp_context *ctx){(void)rdram;ctx->r2=RAM_BYTES;}
void osVirtualToPhysical_recomp(uint8_t *rdram,recomp_context *ctx){
    (void)rdram;uint32_t address=ctx->r4;
    /* Address translation does not dereference RDRAM. libultra also translates
     * direct-mapped cartridge/device addresses; unmapped TLB addresses return -1. */
    ctx->r2=(address&0xc0000000u)==0x80000000u?(address&0x1fffffffu):(gpr)-1;
}
static void queue(uint32_t q) {
    offset(q,24);uint32_t count=mp_os_read(q+16),valid=mp_os_read(q+8),first=mp_os_read(q+12);
    if(!count||count>RAM_BYTES/4||valid>count||first>=count)error("Mario Party OS: invalid message queue");
    offset(mp_os_read(q+20),count*4);
}
void osCreateMesgQueue_recomp(uint8_t *rdram,recomp_context *ctx) {
    (void)rdram;uint32_t q=ctx->r4,count=ctx->r6;offset(q,24);
    if(!count||count>RAM_BYTES/4)error("Mario Party OS: invalid message capacity");
    offset(ctx->r5,count*4);
    mp_os_write(q,0x800c64a0);mp_os_write(q+4,0x800c64a0);
    mp_os_write(q+8,0);mp_os_write(q+12,0);mp_os_write(q+16,count);mp_os_write(q+20,ctx->r5);
}
static void wake(uint32_t q,int waiting) {
    Thread *best=NULL;
    for(int i=0;i<THREADS;i++)if(threads[i].state==waiting&&threads[i].queue==q &&
        (!best||threads[i].priority>best->priority||(threads[i].priority==best->priority&&threads[i].order<best->order)))best=&threads[i];
    if(best){best->queue=0;state(best,READY);}
}
static void block(uint32_t q,int waiting) {
    if(!current)error("Mario Party OS: blocking outside a thread");
    current->queue=q;current->order=++sequence;state(current,waiting);yield();
}
static void send(recomp_context *ctx,int jam) {
    uint32_t q=ctx->r4;queue(q);
    while(mp_os_read(q+8)==mp_os_read(q+16)){
        if(!ctx->r6){ctx->r2=(gpr)-1;return;}block(q,SEND);
    }
    uint32_t count=mp_os_read(q+16),first=mp_os_read(q+12),valid=mp_os_read(q+8);
    uint32_t index=(first+valid)%count;
    if(jam){index=(first+count-1)%count;mp_os_write(q+12,index);}
    mp_os_write(mp_os_read(q+20)+index*4,ctx->r5);mp_os_write(q+8,valid+1);
    ctx->r2=0;wake(q,RECEIVE);preempt();
}
void osSendMesg_recomp(uint8_t *rdram,recomp_context *ctx){(void)rdram;send(ctx,0);}
void osJamMesg_recomp(uint8_t *rdram,recomp_context *ctx){(void)rdram;send(ctx,1);}
void osRecvMesg_recomp(uint8_t *rdram,recomp_context *ctx) {
    (void)rdram;uint32_t q=ctx->r4;queue(q);
    while(!mp_os_read(q+8)){if(!ctx->r6){ctx->r2=(gpr)-1;return;}block(q,RECEIVE);}
    uint32_t first=mp_os_read(q+12);
    if(ctx->r5)mp_os_write(ctx->r5,mp_os_read(mp_os_read(q+20)+first*4));
    mp_os_write(q+12,(first+1)%mp_os_read(q+16));mp_os_write(q+8,mp_os_read(q+8)-1);
    ctx->r2=0;wake(q,SEND);preempt();
}

/* VI and interrupt events run on deterministic host ticks, not wall-clock time. */
static struct {uint32_t queue,message;} events[16];
static struct {
    uint32_t queue,message,interval,phase,mode,features,current,next;
    int created,black;
    uint64_t ticks;
} video;
static void (*read_rom)(uint32_t,uint32_t,uint32_t);
void mp_os_set_rom(void (*reader)(uint32_t,uint32_t,uint32_t)){read_rom=reader;}
static int post(uint32_t q,uint32_t message){
    if(!q)return -1;
    recomp_context ctx;mp_context_init(&ctx);ctx.r4=(int32_t)q;ctx.r5=message;ctx.r6=0;
    send(&ctx,0);return (int32_t)ctx.r2;
}
void mp_os_event(unsigned event){
    if(event>=16)error("Mario Party OS: invalid event");
    post(events[event].queue,events[event].message);
}
void osSetEventMesg_recomp(uint8_t *rdram,recomp_context *ctx){
    (void)rdram;if(ctx->r4>=16)error("Mario Party OS: invalid event");
    events[ctx->r4].queue=ctx->r5;events[ctx->r4].message=ctx->r6;
}
void osCreateViManager_recomp(uint8_t *rdram,recomp_context *ctx){(void)rdram;(void)ctx;video.created=1;video.black=1;}
void osViSetMode_recomp(uint8_t *rdram,recomp_context *ctx){(void)rdram;offset(ctx->r4,80);video.mode=ctx->r4;}
void osViBlack_recomp(uint8_t *rdram,recomp_context *ctx){(void)rdram;video.black=!!ctx->r4;}
void osViSetSpecialFeatures_recomp(uint8_t *rdram,recomp_context *ctx){(void)rdram;video.features=ctx->r4;}
void osViSetEvent_recomp(uint8_t *rdram,recomp_context *ctx){
    (void)rdram;video.queue=ctx->r4;video.message=ctx->r5;video.interval=(uint16_t)ctx->r6;video.phase=0;
}
void osViSwapBuffer_recomp(uint8_t *rdram,recomp_context *ctx){(void)rdram;offset(ctx->r4,1);video.next=ctx->r4;}
void osViGetCurrentFramebuffer_recomp(uint8_t *rdram,recomp_context *ctx){(void)rdram;ctx->r2=(int32_t)video.current;}
void osViGetNextFramebuffer_recomp(uint8_t *rdram,recomp_context *ctx){(void)rdram;ctx->r2=(int32_t)video.next;}
void osGetTime_recomp(uint8_t *rdram,recomp_context *ctx){(void)rdram;uint64_t count=video.ticks*781250;ctx->r2=count>>32;ctx->r3=(int32_t)count;}
void osGetCount_recomp(uint8_t *rdram,recomp_context *ctx){(void)rdram;ctx->r2=(int32_t)(video.ticks*781250);}
static void audio_tick(void);
void mp_os_tick(void){
    if(current)error("Mario Party OS: video tick during dispatch");
    ++video.ticks;audio_tick();
    if(video.created){
        video.current=video.next;
        if(video.interval&&++video.phase>=video.interval){video.phase=0;post(video.queue,video.message);}
        mp_os_event(7);
    }
    mp_os_run();
}
void osCreatePiManager_recomp(uint8_t *rdram,recomp_context *ctx){
    recomp_context q;mp_context_init(&q);q.r4=ctx->r5;q.r5=ctx->r6;q.r6=ctx->r7;osCreateMesgQueue_recomp(rdram,&q);
}
void osCartRomInit_recomp(uint8_t *rdram,recomp_context *ctx){
    (void)rdram;uint32_t handle=0x800f2a80;
    memset(memory+offset(handle,0x74),0,0x74);mp_os_write(handle+0xc,0xb0000000);
    mp_os_write(0x800c653c,handle);ctx->r2=(int32_t)handle;
}
void osEPiStartDma_recomp(uint8_t *rdram,recomp_context *ctx){
    (void)rdram;uint32_t io=ctx->r5;offset(io,24);
    if(ctx->r6!=0)error("Mario Party OS: cartridge writes are unsupported");
    if((uint32_t)ctx->r4!=0x800f2a80||!read_rom)error("Mario Party OS: unsupported PI device");
    read_rom(mp_os_read(io+12),mp_os_read(io+8),mp_os_read(io+16));
    /* DMA data is visible before its completion message can resume a receiver. */
    ctx->r2=0;post(mp_os_read(io+4),io);
}

static struct {uint16_t buttons;int8_t x,y;} pads[4];
static unsigned connected=1,channels=4;
static uint8_t eeprom[512];
static void byte(uint32_t address,uint8_t value){memory[offset(address,1)^3]=value;}
void mp_os_pad(unsigned slot,uint16_t buttons,int x,int y,int present){
    if(slot>=4)error("Mario Party OS: invalid controller slot");
    pads[slot].buttons=buttons;pads[slot].x=x;pads[slot].y=y;
    connected=(connected&~(1u<<slot))|(!!present<<slot);
}
void osContInit_recomp(uint8_t *rdram,recomp_context *ctx){
    (void)rdram;byte(ctx->r5,connected);
    for(unsigned i=0;i<4;i++){uint32_t out=(uint32_t)ctx->r6+i*4;half(out,0x0500);byte(out+2,0);byte(out+3,connected&(1u<<i)?0:8);}
    ctx->r2=0;
}
void osContSetCh_recomp(uint8_t *rdram,recomp_context *ctx){(void)rdram;channels=ctx->r4>4?4:ctx->r4;ctx->r2=0;}
void osContStartReadData_recomp(uint8_t *rdram,recomp_context *ctx){(void)rdram;ctx->r2=0;mp_os_event(5);}
void osContGetReadData_recomp(uint8_t *rdram,recomp_context *ctx){
    (void)rdram;for(unsigned i=0;i<channels;i++){
        uint32_t out=(uint32_t)ctx->r4+i*6;half(out,pads[i].buttons);byte(out+2,pads[i].x);byte(out+3,pads[i].y);byte(out+4,connected&(1u<<i)?0:8);
    }
}
void osPfsIsPlug_recomp(uint8_t *rdram,recomp_context *ctx){(void)rdram;byte(ctx->r5,0);ctx->r2=0;}
void osEepromProbe_recomp(uint8_t *rdram,recomp_context *ctx){(void)rdram;ctx->r2=1;}
static void eeprom_io(recomp_context *ctx,int write,int single){
    uint32_t begin=(uint8_t)ctx->r5*8,size=single?8:ctx->r7,dest=ctx->r6;
    if(begin>sizeof(eeprom)||size>sizeof(eeprom)-begin||size%8){ctx->r2=(gpr)-1;return;}
    offset(dest,size);
    for(unsigned i=0;i<size;i++)if(write)eeprom[begin+i]=memory[offset(dest+i,1)^3];else byte(dest+i,eeprom[begin+i]);
    ctx->r2=0;
    if(write){FILE *file=fopen("/marioparty.eep","wb");if(!file||fwrite(eeprom,1,sizeof(eeprom),file)!=sizeof(eeprom)){if(file)fclose(file);error("Mario Party EEPROM write failed");}fclose(file);}
}
void osEepromLongRead_recomp(uint8_t *rdram,recomp_context *ctx){(void)rdram;eeprom_io(ctx,0,0);}
void osEepromLongWrite_recomp(uint8_t *rdram,recomp_context *ctx){(void)rdram;eeprom_io(ctx,1,0);}
void osEepromWrite_recomp(uint8_t *rdram,recomp_context *ctx){(void)rdram;eeprom_io(ctx,1,1);}
void osEepromRead_recomp(uint8_t *rdram,recomp_context *ctx){(void)rdram;eeprom_io(ctx,0,1);}
static void reset_controllers(void){
    memset(pads,0,sizeof(pads));connected=1;channels=4;memset(eeprom,0xff,sizeof(eeprom));
    FILE *file=fopen("/marioparty.eep","rb");
    if(file){size_t size=fread(eeprom,1,sizeof(eeprom),file);int extra=fgetc(file);fclose(file);if(size!=sizeof(eeprom)||extra!=EOF)error("Mario Party EEPROM file has invalid size");}
}
/* No controller-pak or rumble accessory is attached to the browser pads. */
void osMotorInit_recomp(uint8_t *rdram,recomp_context *ctx){(void)rdram;ctx->r2=1;}
static uint32_t sp_task;
static void (*audio_renderer)(uint8_t *,uint32_t,uint32_t);
void mp_os_set_audio(void (*renderer)(uint8_t *,uint32_t,uint32_t)){audio_renderer=renderer;}
static void (*render_task)(uint8_t *,uint32_t);
void mp_os_set_renderer(void (*renderer)(uint8_t *,uint32_t)){render_task=renderer;}
void osSpTaskLoad_recomp(uint8_t *rdram,recomp_context *ctx){(void)rdram;offset(ctx->r4,64);sp_task=ctx->r4;}
void osSpTaskStartGo_recomp(uint8_t *rdram,recomp_context *ctx){
    (void)ctx;uint32_t task=sp_task,type=mp_os_read(task);sp_task=0;
    if(type==1){
        if(!render_task)error("Mario Party renderer is not attached");
        render_task(rdram,mp_os_read(task+0x30));
        mp_os_event(4);mp_os_event(9);
    }else if(type==2){if(!audio_renderer)error("Mario Party audio renderer is not attached");audio_renderer(rdram,mp_os_read(task+0x30),mp_os_read(task+0x34));mp_os_event(4);}
    else error("Mario Party unknown RSP task type");
}
/* Tasks complete synchronously in the host, so none remain partially yielded. */
void osSpTaskYield_recomp(uint8_t *rdram,recomp_context *ctx){(void)rdram;(void)ctx;}
void osSpTaskYielded_recomp(uint8_t *rdram,recomp_context *ctx){(void)rdram;ctx->r2=0;}
static uint32_t audio_rate=32000,audio_pending[2],audio_count;
static void (*audio_output)(uint8_t *,uint32_t,uint32_t,uint32_t);
static void reset_devices(void){
    memset(events,0,sizeof(events));memset(&video,0,sizeof(video));read_rom=NULL;
    sp_task=0;audio_rate=32000;audio_count=0;memset(audio_pending,0,sizeof(audio_pending));
    audio_renderer=NULL;render_task=NULL;audio_output=NULL;
}
void mp_os_set_audio_output(void (*output)(uint8_t *,uint32_t,uint32_t,uint32_t)){audio_output=output;}
void osAiSetFrequency_recomp(uint8_t *rdram,recomp_context *ctx){
    (void)rdram;uint32_t requested=ctx->r4;
    if(!requested){ctx->r2=(gpr)-1;return;}
    uint32_t divisor=(48681812u+requested/2)/requested;
    if(divisor<132||divisor>16384){ctx->r2=(gpr)-1;return;}
    audio_rate=48681812u/divisor;ctx->r2=audio_rate;
}
void osAiGetLength_recomp(uint8_t *rdram,recomp_context *ctx){(void)rdram;ctx->r2=audio_count?audio_pending[0]:0;}
void osAiSetNextBuffer_recomp(uint8_t *rdram,recomp_context *ctx){
    (void)rdram;offset(ctx->r4,ctx->r5);
    if(audio_count==2){ctx->r2=(gpr)-1;return;}
    audio_pending[audio_count++]=(uint32_t)ctx->r5&~7u;ctx->r2=0;
    if(audio_output)audio_output(memory,(uint32_t)ctx->r4&0x1fffffff,(uint32_t)ctx->r5&~7u,audio_rate);
}
static void audio_tick(void){
    uint32_t bytes=audio_rate*4/60;
    while(bytes&&audio_count){
        if(bytes<audio_pending[0]){audio_pending[0]-=bytes;break;}
        bytes-=audio_pending[0];audio_pending[0]=audio_pending[1];--audio_count;mp_os_event(6);
    }
}
