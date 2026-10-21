"""Adapt the existing pinned SM64 native display-list renderer to guest RDRAM.

Generated adaptations stay in .tmp; this does not change the SM64 installation.
"""
from pathlib import Path
import subprocess
import json
ROOT=Path(__file__).resolve().parents[2]
SRC=ROOT/'.tmp/sm64ex'
OUT=ROOT/'.tmp/marioparty-port/renderer'
PIN=json.loads((ROOT/'ports/marioparty/sources.json').read_text())['renderer']['commit']
if subprocess.check_output(['git','-C',str(SRC),'rev-parse','HEAD'],text=True).strip()!=PIN:raise SystemExit('Wrong SM64 renderer revision')
OUT.mkdir(exist_ok=True)
# Read the pinned objects, not any local SM64 browser edits.
def original(name):return subprocess.check_output(['git','-C',str(SRC),'show',PIN+':src/pc/gfx/'+name],text=True)
for name in ['gfx_pc.h','gfx_cc.h','gfx_cc.c','gfx_window_manager_api.h','gfx_rendering_api.h','gfx_screen_config.h','gfx_opengl.h']:(OUT/name).write_text(original(name))
s=original('gfx_pc.c')
# Board cameras pan a viewport larger than the screen, producing negative origins.
# Converting those floats to SM64's unsigned coordinates saturates to zero in Wasm.
s=s.replace('uint16_t x, y, width, height;', 'int32_t x, y, width, height;')
s=s.replace('color_combiner_pool[64]', 'color_combiner_pool[512]').replace('uint8_t color_combiner_pool_size', 'unsigned color_combiner_pool_size')
s=s.replace('struct ColorCombiner *comb = &color_combiner_pool[color_combiner_pool_size++];','if(color_combiner_pool_size>=512)sys_fatal("Color combiner pool exhausted");\n    struct ColorCombiner *comb = &color_combiner_pool[color_combiner_pool_size++];')
s=s.replace('#define MAX_LIGHTS 2', '#define MAX_LIGHTS 7')
# N64 intensity textures replicate intensity into alpha as well as RGB.
for name,end,alpha in [('import_texture_i4','import_texture_i8','SCALE_4_8(intensity)'),('import_texture_i8','import_texture_ci4','intensity')]:
    a=s.index('static void '+name);b=s.index('static void '+end,a)
    s=s[:a]+s[a:b].replace('rgba32_buf[4*i + 3] = 255;', 'rgba32_buf[4*i + 3] = '+alpha+';')+s[b:]
s=s.replace('rsp.current_num_lights = data / 24 + 1;', 'if(data/24>MAX_LIGHTS)sys_fatal("Too many directional lights"); rsp.current_num_lights = data / 24 + 1;')
for inc in ['#include "config.h"','#include "../platform.h"','#include "../configfile.h"','#include "../fs/fs.h"']:s=s.replace(inc,'')
s=s.replace('#define SUPPORT_CHECK(x) assert(x)','#include "renderer_compat.h"\n#define SUPPORT_CHECK(x) assert(x)')
s=s.replace('#if 0\n    // Original code when fixed point matrices were used','#if 1\n    // Original code when fixed point matrices were used')
s=s.replace('static inline void *seg_addr(uintptr_t w1) {\n    return (void *) w1;\n}', '''static inline void *seg_addr(uintptr_t w1) {
    uint32_t address=(uint32_t)w1;
    if(address>>24<16)address=mp_segments[address>>24]+(address&0xffffff);
    address &= 0x1fffffff;
    if(address>=0x800000)sys_fatal("Graphics address outside RDRAM: %08x (input %08x, opcode %02x)",address,(unsigned)w1,mp_opcode);
    return mp_gfx_ram+address;
}''')
s=s.replace('case G_MW_FOG:', 'case G_MW_SEGMENT: mp_segments[(offset/4)&15]=data;break;\n        case G_MW_FOG:')
s=s.replace('case G_MW_NUMLIGHT:', '''case G_MW_LIGHTCOL: {
            unsigned light=offset/24;
            if(light>MAX_LIGHTS)sys_fatal("Invalid light color index");
            if(offset%24==0||offset%24==4){
                rsp.current_lights[light].col[0]=data>>24;
                rsp.current_lights[light].col[1]=data>>16;
                rsp.current_lights[light].col[2]=data>>8;
            }
            break;
        }
        case G_MW_NUMLIGHT:''')
s=s.replace('#if defined(F3DEX_GBI) || defined(F3DLP_GBI)\n            case (uint8_t)G_TRI2:', '#if defined(F3DEX_GBI) || defined(F3DLP_GBI) || defined(F3DEX_GBI_2)\n#ifdef F3DEX_GBI_2\n            case G_QUAD:\n#endif\n            case (uint8_t)G_TRI2:')
s=s.replace('rdp.texture_tile.cms = cms;', 'rdp.texture_tile.cms = cms | (masks ? 0 : G_TX_CLAMP);').replace('rdp.texture_tile.cmt = cmt;', 'rdp.texture_tile.cmt = cmt | (maskt ? 0 : G_TX_CLAMP);')
s=s.replace('    rdp.texture_to_load.addr = addr;', '    rdp.texture_to_load.addr = mp_gfx_bytes+((const uint8_t *)addr-mp_gfx_ram);')
s=s.replace('    for (size_t i = 0; i < n_vertices; i++, dest_index++) {\n        const Vtx_t *v = &vertices[i].v;\n        const Vtx_tn *vn = &vertices[i].n;', '''    if(n_vertices+dest_index>64)sys_fatal("Vertex cache overflow");
    for (size_t i = 0; i < n_vertices; i++, dest_index++) {
        Vtx decoded; const uint8_t *raw=mp_gfx_bytes+((const uint8_t *)vertices-mp_gfx_ram)+i*16;
        for(int c=0;c<3;c++)decoded.v.ob[c]=(int16_t)((raw[c*2]<<8)|raw[c*2+1]);
        decoded.v.flag=(raw[6]<<8)|raw[7];
        for(int c=0;c<2;c++)decoded.v.tc[c]=(int16_t)((raw[8+c*2]<<8)|raw[9+c*2]);
        memcpy(decoded.v.cn,raw+12,4);
        const Vtx_t *v = &decoded.v;
        const Vtx_tn *vn = &decoded.n;''')
s=s.replace('            gfx_calc_and_set_viewport((const Vp_t *) data);', '''            { Vp_t viewport; const uint8_t *raw=mp_gfx_bytes+((const uint8_t *)data-mp_gfx_ram);
              for(int i=0;i<4;i++){viewport.vscale[i]=(int16_t)((raw[i*2]<<8)|raw[i*2+1]);viewport.vtrans[i]=(int16_t)((raw[8+i*2]<<8)|raw[9+i*2]);}
              gfx_calc_and_set_viewport(&viewport); }''')
s=s.replace('data, sizeof(Light_t)', 'mp_gfx_bytes+((const uint8_t *)data-mp_gfx_ram), sizeof(Light_t)')
s=s.replace('    int dummy = 0;\n    for (;;) {', '    int dummy = 0;\n    for (;;) {\n        mp_opcode=cmd->words.w0>>24; if(++mp_commands>1000000)sys_fatal("Display-list command limit");\n        if(mp_trace)EM_ASM({if(Module.traceCommands){Module.commandTrace=Module.commandTrace||[];Module.commandTrace.push([$0>>>0,$1>>>0]);}},cmd->words.w0,cmd->words.w1);')
s=s.replace('void gfx_run(Gfx *commands) {\n    gfx_sp_reset();','''void gfx_run(Gfx *commands) {
    mp_commands=0;
    gfx_texture_cache.pool_pos=0;
    memset(gfx_texture_cache.hashmap,0,sizeof(gfx_texture_cache.hashmap));
    gfx_sp_reset();''')
s=s.replace('// Don\'t clear Z buffer here since we already did it with glClear', 'gfx_flush();mp_clear_depth();')
s=s.replace('    gfx_dp_set_combine_mode(color_comb(0, 0, 0, G_CCMUX_SHADE), color_comb(0, 0, 0, G_ACMUX_SHADE));\n    gfx_draw_rectangle', '    if(mode == G_CYC_FILL) gfx_dp_set_combine_mode(color_comb(0, 0, 0, G_CCMUX_SHADE), color_comb(0, 0, 0, G_ACMUX_SHADE));\n    gfx_draw_rectangle')
# CI4 banks and partial TLUT uploads used by Mario Party's UI.
s=s.replace('const uint8_t *palette;', 'uint8_t palette[512];')
s=s.replace('uint8_t tile_number;', 'uint8_t tile_number; uint16_t tmem;')
s=s.replace('uint8_t cms, cmt;', 'uint8_t cms, cmt; uint8_t palette;')
s=s.replace('SUPPORT_CHECK(palette == 0);', 'rdp.texture_tile.palette=palette;')
s=s.replace('rdp.texture_to_load.tile_number = tmem / 256;', 'rdp.texture_to_load.tile_number = tmem / 256; rdp.texture_to_load.tmem=tmem;')
s=s.replace('rdp.palette = rdp.texture_to_load.addr;', 'unsigned start=(rdp.texture_to_load.tmem-256)*2, bytes=(high_index+1)*2; SUPPORT_CHECK(start+bytes<=512); memcpy(rdp.palette+start,rdp.texture_to_load.addr,bytes);')
s=s.replace('uint8_t idx = (byte >> (4 - (i % 2) * 4)) & 0xf;', 'uint8_t idx = ((byte >> (4 - (i % 2) * 4)) & 0xf) | (rdp.texture_tile.palette<<4);')
s=s.replace('if (CMPADDR((*node)->texture_addr, orig_addr) &&', 'if (fmt != G_IM_FMT_CI && CMPADDR((*node)->texture_addr, orig_addr) &&')
# Rectangular texture loads may select rows/columns from a larger source image.
s=s.replace('uint16_t tmem;', 'uint16_t tmem; uint32_t width,line;')
s=s.replace('rdp.texture_to_load.siz = size;', 'rdp.texture_to_load.siz = size; rdp.texture_to_load.width=width+1;')
s=s.replace('rdp.texture_to_load.tmem=tmem;', 'rdp.texture_to_load.tmem=tmem; rdp.texture_to_load.line=line*8;')
a=s.index('static void gfx_dp_load_tile(');b=s.index('static uint8_t color_comb_component',a)
s=s[:a]+r"""static void gfx_dp_load_tile(uint8_t tile,uint32_t uls,uint32_t ult,uint32_t lrs,uint32_t lrt) {
    static uint8_t images[2][8192];
    if(tile!=G_TX_LOADTILE)sys_fatal("Unsupported load tile %u",tile);
    unsigned slot=rdp.texture_to_load.tile_number;
    if(slot>1||lrs<uls||lrt<ult)sys_fatal("Invalid texture rectangle");
    unsigned bits=4u<<rdp.texture_to_load.siz;
    unsigned width=((lrs-uls)>>2)+1,height=((lrt-ult)>>2)+1;
    unsigned rowbytes=(width*bits+7)/8,line=rdp.texture_to_load.line;
    if(bits==32)line*=2;
    if(!line)line=(rowbytes+7)&~7u;
    if(line<rowbytes||line*height>sizeof(images[0]))sys_fatal("Texture rectangle exceeds TMEM staging: width %u height %u line %u row %u bits %u",width,height,line,rowbytes,bits);
    gfx_flush();gfx_texture_cache.pool_pos=0;memset(gfx_texture_cache.hashmap,0,sizeof(gfx_texture_cache.hashmap));
    memset(images[slot],0,line*height);
    for(unsigned y=0;y<height;y++)for(unsigned x=0;x<width;x++){
        unsigned pixel=((ult>>2)+y)*rdp.texture_to_load.width+(uls>>2)+x;
        if(bits==4){unsigned value=(rdp.texture_to_load.addr[pixel/2]>>(pixel&1?0:4))&15;images[slot][y*line+x/2]|=value<<(x&1?0:4);}
        else memcpy(images[slot]+y*line+x*(bits/8),rdp.texture_to_load.addr+pixel*(bits/8),bits/8);
    }
    rdp.loaded_texture[slot].addr=images[slot];rdp.loaded_texture[slot].size_bytes=line*height;
    rdp.texture_tile.uls=uls;rdp.texture_tile.ult=ult;rdp.texture_tile.lrs=lrs;rdp.texture_tile.lrt=lrt;
    rdp.textures_changed[slot]=true;
}

"""+s[b:]
s=s.replace('C0(19, 2), C0(0, 10), seg_addr','C0(19, 2), C0(0, 12), seg_addr')
(OUT/'gfx_pc.c').write_text(s)
s=original('gfx_opengl.c').replace('#include "../platform.h"','#include "renderer_compat.h"').replace('#include "../configfile.h"','')
s=s.replace('shader_program_pool[64]', 'shader_program_pool[512]').replace('uint8_t shader_program_pool_size', 'unsigned shader_program_pool_size')
s=s.replace('struct ShaderProgram *prg = &shader_program_pool[shader_program_pool_size++];','if(shader_program_pool_size>=512)sys_fatal("Shader program pool exhausted");\n    struct ShaderProgram *prg = &shader_program_pool[shader_program_pool_size++];')
s=s.replace('texelVal0.a','texVal0.a')
a=s.index('static const char *shader_item_to_str');b=s.index('\nstatic ',a+10)
part=s[a:b];end=part.rfind('}')
s=s[:a]+part[:end]+'    sys_fatal("Invalid shader combiner input %u",item);\n'+part[end:]+s[b:]
s=s.replace('#define GL_GLEXT_PROTOTYPES 1','#define GL_GLEXT_PROTOTYPES 1\n#include <GLES2/gl2.h>\n#include <stdio.h>\n#include <stdlib.h>\n#include <string.h>')
s=s.replace('glDrawArrays(GL_TRIANGLES,', 'mp_triangles += buf_vbo_num_tris; glDrawArrays(GL_TRIANGLES,')
a=s.index('static void gfx_opengl_start_frame(void)');b=s.index('static void gfx_opengl_end_frame',a)
s=s[:a]+'static void gfx_opengl_start_frame(void) { frame_count++; glEnable(GL_SCISSOR_TEST); }\n\n'+s[b:]
(OUT/'gfx_opengl.c').write_text(s)
# Reuse the pinned source port's scalar ABI1 mixer, with guest byte-stream access.
mixer=subprocess.check_output(['git','-C',str(SRC),'show',PIN+':src/pc/mixer.c'],text=True)
a=mixer.index('void aADPCMdecImpl');b=mixer.index('void aResampleImpl',a)
part=mixer[a:b].replace('*in++','rspa.buf.as_u8[((in++ - rspa.buf.as_u8) ^ 1)]').replace('*in >>','rspa.buf.as_u8[((in - rspa.buf.as_u8) ^ 1)] >>')
part=part.replace('int16_t (*tbl)[8] = rspa.adpcm_table[table_index];','if(table_index>=8)abort();\n        int16_t (*tbl)[8] = rspa.adpcm_table[table_index];')
mixer=mixer[:a]+part+mixer[b:]
mixer='#include <stdlib.h>\n'+mixer+'\n'+(ROOT/'ports/marioparty/runtime/audio_commands.inc').read_text()
(OUT/'mixer.c').write_text(mixer)
