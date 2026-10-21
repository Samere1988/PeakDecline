#include <stdint.h>
#include <assert.h>
#include <string.h>
#include <emscripten/emscripten.h>
static uint8_t ram[8*1024*1024];
void mp_audio_render(uint8_t *,uint32_t,uint32_t);
static unsigned commands;
static void cmd(uint32_t a,uint32_t b){*(uint32_t *)(ram+0x1000+commands*8)=a;*(uint32_t *)(ram+0x1004+commands*8)=b;++commands;}
static void sample(unsigned a,int16_t value){*(int16_t *)(ram+(a^2))=value;}
static int16_t read_sample(unsigned a){return *(int16_t *)(ram+(a^2));}
EMSCRIPTEN_KEEPALIVE int mp_test_audio(void){
    memset(ram,0,sizeof(ram));commands=0;
    ram[0x2000^3]=0;for(int i=1;i<=8;i++)ram[(0x2000+i)^3]=0x11;
    cmd(0x08000000,16);cmd(0x04000000,0x2000);
    cmd(0x0b000020,0x2100);cmd(0x08000000,(64<<16)|32);cmd(0x01010000,0x2200);
    cmd(0x08000000,(96<<16)|32);cmd(0x06000000,0x3000);
    mp_audio_render(ram,0x1000,commands*8);
    for(unsigned i=0;i<16;i++)assert(read_sample(0x3000+i*2)==1);
    commands=0;
    for(unsigned i=0;i<8;i++)sample(0x4000+i*2,(i&1)?-1234:2345);
    cmd(0x08000000,16);cmd(0x04000000,0x4000);
    cmd(0x08000000,(64<<16)|16);cmd(0x0e014000,0x2200); // zero coefficients, unity gain
    cmd(0x06000000,0x5000);mp_audio_render(ram,0x1000,commands*8);
    for(unsigned i=0;i<8;i++)assert(read_sample(0x5000+i*2)==((i&1)?-1234:2345));
    for(unsigned i=0;i<4;i++)assert(read_sample(0x2200+i*2)==((i&1)?-1234:2345));
    return 1;
}
