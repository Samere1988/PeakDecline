/* Full translated cartridge boot diagnostic. Missing OS services stop execution. */
#include "os.h"
#include "recomp_overlays.inl"
#include <stdio.h>
#include <string.h>
#include <emscripten/emscripten.h>
void mp_process_reset(void);
void mp_render(uint8_t *,uint32_t);
void mp_audio_render(uint8_t *,uint32_t,uint32_t);
void mp_output_audio(uint8_t *,uint32_t,uint32_t,uint32_t);
static uint8_t rdram[8*1024*1024];
static uint8_t rom[32*1024*1024];
static int active[512];
static int32_t addresses[512];
int32_t *section_addresses=addresses;
static void fail(const char *reason) {
    EM_ASM({throw new Error(UTF8ToString($0));},reason);
}
EMSCRIPTEN_KEEPALIVE int mp_load_section(unsigned index) {
    if(index>=num_sections){fail("Invalid Mario Party code section");return -1;}
    SectionTableEntry *s=&section_table[index];
    uint32_t dest=s->ram_addr-0x80000000u;
    if(dest>sizeof(rdram)||s->size>sizeof(rdram)-dest||s->rom_addr>sizeof(rom)||s->size>sizeof(rom)-s->rom_addr){fail("Mario Party section exceeds memory bounds");return -1;}
    for(unsigned i=0;i<num_sections;i++){
        SectionTableEntry *old=&section_table[i];
        if((uint64_t)old->ram_addr+old->size>s->ram_addr&&(uint64_t)s->ram_addr+s->size>old->ram_addr)active[i]=0;
    }
    for(unsigned i=0;i<s->size;i++)rdram[(dest+i)^3]=rom[s->rom_addr+i];
    active[index]=1;addresses[index]=(int32_t)s->ram_addr;return 0;
}
EMSCRIPTEN_KEEPALIVE int mp_lookup_section(uint32_t address) {
    for(unsigned i=0;i<num_sections;i++)if(active[i]){
        SectionTableEntry *s=&section_table[i];
        for(unsigned f=0;f<s->num_funcs;f++)if(s->ram_addr+s->funcs[f].offset==address)return i;
    }
    return -1;
}
recomp_func_t *get_function(int32_t address) {
    int section=mp_lookup_section((uint32_t)address);
    if(section<0){char message[96];snprintf(message,sizeof(message),"Mario Party 2 called unknown function 0x%08x",(unsigned)address);fail(message);return NULL;}
    SectionTableEntry *s=&section_table[section];
    for(unsigned f=0;f<s->num_funcs;f++)if(s->ram_addr+s->funcs[f].offset==(uint32_t)address)return s->funcs[f].func;
    return NULL;
}
static void read_rom(uint32_t source,uint32_t address,uint32_t size) {
    uint32_t dest=address & 0x1fffffffu;
    if(source>sizeof(rom)||size>sizeof(rom)-source||dest>sizeof(rdram)||size>sizeof(rdram)-dest){fail("Mario Party DMA exceeds memory bounds");return;}
    for(uint32_t i=0;i<size;i++)rdram[(dest+i)^3]=rom[source+i];
    for(unsigned i=0;i<num_sections;i++){
        SectionTableEntry *s=&section_table[i];
        if(source==s->rom_addr && size>0 && dest==s->ram_addr-0x80000000u){
            for(unsigned j=0;j<num_sections;j++)if((uint64_t)section_table[j].ram_addr+section_table[j].size>s->ram_addr&&(uint64_t)s->ram_addr+s->size>section_table[j].ram_addr)active[j]=0;
            active[i]=1;addresses[i]=(int32_t)s->ram_addr;
        }
    }
}
EMSCRIPTEN_KEEPALIVE uint32_t mp_word(uint32_t address){return mp_os_read(address);}
EMSCRIPTEN_KEEPALIVE void mp_pad(unsigned slot,unsigned buttons,int x,int y,int present){mp_os_pad(slot,buttons,x,y,present);}
EMSCRIPTEN_KEEPALIVE void mp_tick(void){mp_os_tick();}
/* Guest-state checksum: native pointers and WebGL/audio presentation are excluded. */
EMSCRIPTEN_KEEPALIVE uint32_t mp_hash(void){
    uint32_t hash=2166136261u;
    for(unsigned i=0;i<sizeof(rdram);i++)hash=(hash^rdram[i])*16777619u;
    for(unsigned i=0;i<num_sections;i++)hash=(hash^(unsigned)active[i])*16777619u;
    return hash;
}
EMSCRIPTEN_KEEPALIVE void mp_prepare(void) {
    mp_process_reset();
    FILE *file=fopen("/game.z64","rb");
    if(!file){fail("Mario Party ROM is missing");return;}
    size_t size=fread(rom,1,sizeof(rom),file);int extra=fgetc(file);fclose(file);
    if(size!=sizeof(rom)||extra!=EOF||memcmp(rom,"\x80\x37\x12\x40",4)){fail("Invalid Mario Party ROM size or byte order");return;}
    memset(rdram,0,sizeof(rdram));memset(active,0,sizeof(active));
    mp_load_section(0);mp_load_section(1);mp_os_reset(rdram);mp_os_set_rom(read_rom);mp_os_set_renderer(mp_render);mp_os_set_audio(mp_audio_render);mp_os_set_audio_output(mp_output_audio);
}
EMSCRIPTEN_KEEPALIVE unsigned mp_boot_threads(void) {return mp_os_entered();}
EMSCRIPTEN_KEEPALIVE void mp_boot(void) { mp_os_boot(0x80000400); }
void do_break(uint32_t address){(void)address;fail("Mario Party CPU break reached");}
void switch_error(const char *func,uint32_t address,uint32_t table){(void)func;(void)address;(void)table;fail("Mario Party unresolved jump table");}
void pause_self(uint8_t *memory){(void)memory;fail("Mario Party scheduler is not implemented");}
/* Direct CP0 reads are not a substitute for hosted OS services. */
gpr cop0_status_read(recomp_context *ctx){(void)ctx;fail("Mario Party 2 direct CP0 status read is unsupported");return 0;}
