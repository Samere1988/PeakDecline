#include <stdint.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdarg.h>
#include <GLES2/gl2.h>
#include <emscripten/emscripten.h>
#include <emscripten/html5.h>
#include <PR/mbi.h>
#include "gfx_pc.h"
#include "gfx_opengl.h"
#include "gfx_window_manager_api.h"
#include "renderer_compat.h"
uint8_t *mp_gfx_ram;
uint8_t mp_gfx_bytes[8*1024*1024];
uint32_t mp_segments[16],mp_commands,mp_opcode,mp_triangles;
int mp_trace;
unsigned configFiltering=0;
void mp_clear_depth(void){GLboolean mask;glGetBooleanv(GL_DEPTH_WRITEMASK,&mask);glDepthMask(GL_TRUE);glClear(GL_DEPTH_BUFFER_BIT);glDepthMask(mask);}
static int initialized;
static unsigned frames;
_Noreturn void sys_fatal(const char *format,...){
    char message[512];va_list args;va_start(args,format);vsnprintf(message,sizeof(message),format,args);va_end(args);
    EM_ASM({throw new Error(UTF8ToString($0));},message);abort();
}
static void init(const char *title){
    (void)title;EmscriptenWebGLContextAttributes attr;emscripten_webgl_init_context_attributes(&attr);
    attr.alpha=0;attr.antialias=0;attr.preserveDrawingBuffer=1;attr.majorVersion=1;
    EMSCRIPTEN_WEBGL_CONTEXT_HANDLE context=emscripten_webgl_create_context("#canvas",&attr);
    if(context<=0)sys_fatal("Mario Party WebGL context failed");
    emscripten_webgl_make_context_current(context);
}
static void dimensions(uint32_t *w,uint32_t *h){*w=640;*h=480;}
static void noop(void){}
static bool start(void){return true;}
static double renderer_time(void){return frames/60.0;}
static struct GfxWindowManagerAPI window={.init=init,.get_dimensions=dimensions,.handle_events=noop,.start_frame=start,.swap_buffers_begin=noop,.swap_buffers_end=noop,.get_time=renderer_time,.shutdown=noop};
void mp_render(uint8_t *ram,uint32_t display_list){
    int flags=EM_ASM_INT({return (Module.skipPresentation?1:0)|(Module.traceCommands?2:0);});
    if(flags&1){++frames;return;}
    if(!initialized){gfx_init(&window,&gfx_opengl_api,"Mario Party");initialized=1;}
    mp_gfx_ram=ram;
    mp_trace=flags&2;
    for(unsigned i=0;i<sizeof(mp_gfx_bytes);i++)mp_gfx_bytes[i]=ram[i^3];
    mp_triangles=0;gfx_start_frame();gfx_run((Gfx *)(ram+(display_list&0x1fffffff)));gfx_end_frame();++frames;
    EM_ASM({Module.renderInfo=({commands:$0,triangles:$1});Module.renderHistory=Module.renderHistory||[];Module.renderHistory.push(Module.renderInfo);if(Module.renderHistory.length>20)Module.renderHistory.shift();},mp_commands,mp_triangles);
    if(mp_trace)EM_ASM({if(Module.captureTasks){Module.taskImages=Module.taskImages||[];Module.taskImages.push(document.getElementById('canvas').toDataURL());}},0);
}
EMSCRIPTEN_KEEPALIVE unsigned mp_rendered_frames(void){return frames;}
EM_JS(void, mp_output_audio, (uint8_t *ram,uint32_t address,uint32_t bytes,uint32_t rate), {
    if(Module.inspectAudio){
        var peak=0,clipped=0;
        for(var offset=0;offset<bytes;offset+=2){var amplitude=Math.abs(HEAP16[(ram+((address+offset)^2))>>>1]);peak=Math.max(peak,amplitude);if(amplitude>=32767)clipped++;}
        Module.audioStats=Module.audioStats||{peak:0,samples:0,clipped:0};
        Module.audioStats.peak=Math.max(Module.audioStats.peak,peak);Module.audioStats.samples+=bytes/2;Module.audioStats.clipped+=clipped;
    }
    var audio=Module.mpAudio;
    if(!audio){
        var Audio=globalThis.AudioContext||globalThis.webkitAudioContext;
        if(!Audio)return;
        var context=new Audio();var gain=context.createGain();gain.connect(context.destination);
        audio=Module.mpAudio={context:context,gain:gain,next:0};
        var resume=()=>context.resume();document.addEventListener('pointerdown',resume);document.addEventListener('keydown',resume);
    }
    if(audio.context.state!=='running'||!bytes)return;
    var start=Math.max(audio.next,audio.context.currentTime+0.01);
    if(start>audio.context.currentTime+0.25)return;
    var frames=bytes>>>2,buffer=audio.context.createBuffer(2,frames,rate);
    for(var channel=0;channel<2;channel++){
        var data=buffer.getChannelData(channel);
        for(var i=0;i<frames;i++)data[i]=HEAP16[(ram+((address+i*4+channel*2)^2))>>>1]/32768;
    }
    var source=audio.context.createBufferSource();source.buffer=buffer;source.connect(audio.gain);source.start(start);
    audio.next=start+frames/rate;
});
EMSCRIPTEN_KEEPALIVE void mp_render_test(void){
    static uint8_t test_ram[8*1024*1024];Gfx *dl=(Gfx *)(test_ram+0x1000),*p=dl;
    gDPSetScissor(p++,G_SC_NON_INTERLACE,0,0,320,240);
    gDPSetColorImage(p++,G_IM_FMT_RGBA,G_IM_SIZ_16b,320,0x100000);
    gDPSetCycleType(p++,G_CYC_FILL);
    gDPSetFillColor(p++,0xf801f801);
    gDPFillRectangle(p++,0,0,319,239);
    gSPEndDisplayList(p++);
    mp_render(test_ram,0x1000);
}
