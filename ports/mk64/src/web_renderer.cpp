/* WebGL backend for MKart360's native display-list renderer. */
#include <GLES2/gl2.h>
#include <cstdio>
#include <cstdlib>
#include <map>
#include <string>
#include <vector>
#include <emscripten/heap.h>
#include <emscripten.h>
#include "xbox360/gfx_cc.h"
#include "xbox360/gfx_rendering_api.h"
#include "web_texture_hash.h"

struct Attribute { GLint location; int size; };
struct ShaderProgram {
    GLuint program;
    CCFeatures features;
    std::vector<Attribute> attributes;
    int stride;
};
static std::map<uint32_t, ShaderProgram> shaders;
static ShaderProgram *current;
static GLuint buffer;
static bool depth_write;
static std::map<GLuint, bool> texture_pot;
static GLuint bound[2];
static std::vector<GLuint> game_textures;
static int active_tile;
static bool depth_enabled, blend_enabled, decal_enabled;
static int current_viewport[4], current_scissor[4];
static GLuint scene_framebuffer, scene_texture, scene_depth, tv_framebuffer, tv_texture;
static GLuint post_program, post_buffer;
static unsigned aa_frames;
static int hd_enabled;
extern "C" unsigned web_render_width(void);
extern "C" unsigned web_render_height(void);
extern "C" int web_graphics_baseline(void);
extern "C" { EMSCRIPTEN_KEEPALIVE unsigned web_aa_frames(void) { return aa_frames; } }
static void draw_post(GLuint target, int width, int height, float u, float v, float uw, float vh, bool aa);

extern "C" { extern int gGamestate; extern int16_t gCurrentCourseId; }
extern "C" int web_presentation_midpoint(void);

// The track televisions copy six tiles from the previous N64 framebuffer.
// WebGL draws on the GPU, so preserve its image in the game's RGBA5551 buffer
// before yielding to the browser (which may discard the drawing buffer).
extern "C" void web_store_framebuffer(void *destination) {
    /* Course televisions are simulation data: capture only the original
     * completed frame, never the extra presentation between game ticks. */
    if (web_presentation_midpoint()) return;
    if (gGamestate != 4 || (gCurrentCourseId != 8 && gCurrentCourseId != 14)) return;
    uintptr_t address = reinterpret_cast<uintptr_t>(destination);
    if (address < 0x10000000U || address + 320*240*2 > emscripten_get_heap_size()) {
        std::fprintf(stderr,"MK64: invalid video-screen framebuffer %p.\n", destination); std::abort();
    }
    // Resolve/downsample on the GPU rather than reading eight megabytes of
    // 1080p pixels into game RAM each tick. The TV retains its native4:3 shape.
    static uint8_t pixels[320*240*4];
    draw_post(tv_framebuffer, 320, 240, web_graphics_baseline() ? 0.0f : 0.125f,
              0.0f, web_graphics_baseline() ? 1.0f : 0.75f, 1.0f, false);
    glBindFramebuffer(GL_FRAMEBUFFER, tv_framebuffer);
    glReadPixels(0, 0, 320, 240, GL_RGBA, GL_UNSIGNED_BYTE, pixels);
    glBindFramebuffer(GL_FRAMEBUFFER, scene_framebuffer);
    auto *out = static_cast<uint8_t *>(destination);
    for (int y=0; y<240; ++y) for (int x=0; x<320; ++x) {
        const uint8_t *p = pixels + ((239-y)*320+x)*4;
        uint16_t color = ((p[0]>>3)<<11) | ((p[1]>>3)<<6) | ((p[2]>>3)<<1) | 1;
        *out++ = color >> 8; *out++ = color & 255;
    }
}

static GLuint compile(GLenum kind, const std::string &source) {
    GLuint shader = glCreateShader(kind);
    const char *text = source.c_str();
    glShaderSource(shader, 1, &text, nullptr);
    glCompileShader(shader);
    GLint success; glGetShaderiv(shader, GL_COMPILE_STATUS, &success);
    if (!success) {
        char log[4096]; glGetShaderInfoLog(shader, sizeof(log), nullptr, log);
        std::fprintf(stderr, "WebGL shader failed: %s\n%s\n", log, text); std::abort();
    }
    return shader;
}
static std::string component(int code, bool alpha, int cycle) {
    const char *value = "vec4(0.0)";
    switch (code) {
        case CC_TEXEL0: value = cycle ? "tex1" : "tex0"; break;
        case CC_TEXEL1: value = cycle ? "tex0" : "tex1"; break;
        case CC_TEXEL0A: value = cycle ? "vec4(tex1.a)" : "vec4(tex0.a)"; break;
        case CC_TEXEL1A: value = cycle ? "vec4(tex0.a)" : "vec4(tex1.a)"; break;
        case CC_PRIM: value = "vInput0"; break;
        case CC_SHADE: value = "vInput1"; break;
        case CC_ENV: value = "vInput2"; break;
        case CC_PRIMA: value = "vec4(vInput0.a)"; break;
        case CC_SHADEA: value = "vec4(vInput1.a)"; break;
        case CC_ENVA: value = "vec4(vInput2.a)"; break;
        case CC_LOD: value = "vec4(vInput3.r)"; break;
        case CC_PRIMLOD: value = "vec4(vInput3.g)"; break;
        case CC_ONE: value = "vec4(1.0)"; break;
        case CC_COMBINED: value = "combined"; break;
        case CC_COMBINEDA: value = "vec4(combined.a)"; break;
    }
    return std::string("(") + value + (alpha ? ").a" : ").rgb");
}
static void load(ShaderProgram *shader) {
    current = shader; glUseProgram(shader->program);
}
static ShaderProgram *create(uint32_t id) {
    ShaderProgram &shader = shaders[id];
    gfx_cc_get_features(id, &shader.features);
    const auto &f = shader.features;
    std::string vs = "precision highp float;\nattribute vec4 aPosition;\n";
    std::string fs = "precision mediump float;\n";
    std::string assignments = "gl_Position = aPosition;\n";
    std::vector<std::pair<std::string,int>> attributes = {{"aPosition",4}};
    auto varying = [&](const std::string &name, int size) {
        std::string type = "vec" + std::to_string(size);
        vs += "attribute " + type + " a" + name + ";\nvarying " + type + " v" + name + ";\n";
        fs += "varying " + type + " v" + name + ";\n";
        assignments += "v" + name + " = a" + name + ";\n";
        attributes.push_back({"a" + name, size});
    };
    for (int i=0;i<2;++i) if (f.used_textures[i]) {
        varying("UV" + std::to_string(i),2);
        fs += "uniform sampler2D uTexture" + std::to_string(i) + ";\n";
    }
    if (f.opt_fog) varying("Fog",4);
    for (int i=0;i<f.num_inputs;++i) varying("Input" + std::to_string(i),4);
    vs += "void main(){\n" + assignments + "}\n";
    fs += "void main(){\nvec4 combined=vec4(0.0);\n";
    for (int i=0;i<2;++i) {
        std::string n = std::to_string(i);
        fs += "vec4 tex" + n + "=" + (f.used_textures[i] ? "texture2D(uTexture" + n + ",vUV" + n + ")" : "vec4(1.0)") + ";\n";
    }
    fs += "float compareAlpha=0.0;\n";
    for (int cycle=0;cycle<(f.two_cycle?2:1);++cycle) {
        auto formula = [&](bool alpha) {
            const auto *c = (cycle ? f.c2 : f.c)[alpha ? 1 : 0];
            return "clamp(("+component(c[0],alpha,cycle)+"-"+component(c[1],alpha,cycle)+")*"+component(c[2],alpha,cycle)+"+"+component(c[3],alpha,cycle)+",0.0,1.0)";
        };
        fs += "combined=vec4(" + formula(false) + "," + formula(true) + ");\n";
        if (cycle == 0) fs += "compareAlpha=combined.a;\n";
    }
    if (!f.opt_alpha) fs += "combined.a=1.0;\n";
    if (f.opt_texture_edge) fs += "if(compareAlpha<=0.3)discard;combined.a=1.0;\n";
    if (f.opt_fog) fs += "combined.rgb=mix(combined.rgb,vFog.rgb,vFog.a);\n";
    fs += "gl_FragColor=combined;\n}\n";
    GLuint vertex = compile(GL_VERTEX_SHADER,vs), fragment = compile(GL_FRAGMENT_SHADER,fs);
    shader.program=glCreateProgram(); glAttachShader(shader.program,vertex); glAttachShader(shader.program,fragment);
    glLinkProgram(shader.program); glDeleteShader(vertex); glDeleteShader(fragment);
    GLint success; glGetProgramiv(shader.program,GL_LINK_STATUS,&success);
    if (!success) { char log[4096]; glGetProgramInfoLog(shader.program,sizeof(log),nullptr,log); std::fprintf(stderr,"WebGL link failed: %s\n",log); std::abort(); }
    shader.stride=0;
    for (const auto &attr:attributes) { shader.attributes.push_back({glGetAttribLocation(shader.program,attr.first.c_str()),attr.second}); shader.stride+=attr.second; }
    load(&shader);
    for (int i=0;i<2;++i) if(f.used_textures[i]) glUniform1i(glGetUniformLocation(shader.program,("uTexture"+std::to_string(i)).c_str()),i);
    return &shader;
}
static bool zero_to_one() {return false;}
static void unload(ShaderProgram *) {}
static ShaderProgram *lookup(uint32_t id) {auto it=shaders.find(id);return it==shaders.end()?nullptr:&it->second;}
static void info(ShaderProgram *s,uint8_t *inputs,bool textures[2]) {*inputs=s->features.num_inputs;textures[0]=s->features.used_textures[0];textures[1]=s->features.used_textures[1];}
static uint32_t new_texture() {GLuint id;glGenTextures(1,&id);game_textures.push_back(id);return id;}
static void select_texture(int tile,uint32_t id) {active_tile=tile;bound[tile]=id;glActiveTexture(GL_TEXTURE0+tile);glBindTexture(GL_TEXTURE_2D,id);}
static void upload(const uint8_t *pixels,int w,int h) {
    texture_pot[bound[active_tile]]=(w&(w-1))==0&&(h&(h-1))==0;
    glTexImage2D(GL_TEXTURE_2D,0,GL_RGBA,w,h,0,GL_RGBA,GL_UNSIGNED_BYTE,pixels);
    if (hd_enabled) {
        uint32_t crc, adler;
        web_texture_hash(pixels, size_t(w)*h*4, &crc, &adler);
        EM_ASM({ Module.mk64HD.replace(GLctx, $0, $1, $2, $3); }, w, h, crc, adler);
    }
}
static void sampler(int tile,bool linear,uint32_t s,uint32_t t) {
    glActiveTexture(GL_TEXTURE0+tile);
    auto wrap=[&](uint32_t flags) {return !texture_pot[bound[tile]]||(flags&2)?GL_CLAMP_TO_EDGE:(flags&1)?GL_MIRRORED_REPEAT:GL_REPEAT;};
    glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MIN_FILTER,linear?GL_LINEAR:GL_NEAREST);glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MAG_FILTER,linear?GL_LINEAR:GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_WRAP_S,wrap(s));glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_WRAP_T,wrap(t));
}
static void toggle(GLenum cap,bool on) {if(on)glEnable(cap);else glDisable(cap);}
static void apply_depth() {
    // OpenGL only writes depth with its test enabled. A write-only RDP pass
    // therefore uses ALWAYS; comparison and writes remain independent.
    toggle(GL_DEPTH_TEST, depth_enabled || depth_write);
    glDepthFunc(depth_enabled ? GL_LEQUAL : GL_ALWAYS);
    glDepthMask(depth_write);
}
static void depth(bool on) {depth_enabled=on;apply_depth();}
static void mask(bool on) {depth_write=on;apply_depth();}
static void decal(bool on) {decal_enabled=on;toggle(GL_POLYGON_OFFSET_FILL,on);glPolygonOffset(-2,-2);}
static void viewport(int x,int y,int w,int h) {current_viewport[0]=x;current_viewport[1]=y;current_viewport[2]=w;current_viewport[3]=h;glViewport(x,y,w,h);}
static void scissor(int x,int y,int w,int h) {current_scissor[0]=x;current_scissor[1]=y;current_scissor[2]=w;current_scissor[3]=h;glScissor(x,y,w,h);}
static void alpha(bool on) {blend_enabled=on;toggle(GL_BLEND,on);}
static void triangles(float *vertices,size_t length,size_t count) {
    for(int i=0;i<8;++i)glDisableVertexAttribArray(i);
    glBufferData(GL_ARRAY_BUFFER,length*sizeof(float),vertices,GL_STREAM_DRAW);
    size_t offset=0;
    for(const auto &attr:current->attributes){if(attr.location>=0){glEnableVertexAttribArray(attr.location);glVertexAttribPointer(attr.location,attr.size,GL_FLOAT,GL_FALSE,current->stride*sizeof(float),(void *)(offset*sizeof(float)));}offset+=attr.size;}
    glDrawArrays(GL_TRIANGLES,0,count*3);
}
static void target(GLuint *framebuffer, GLuint *texture, int width, int height, bool with_depth) {
    glGenTextures(1, texture); glBindTexture(GL_TEXTURE_2D, *texture);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, width, height, 0, GL_RGBA, GL_UNSIGNED_BYTE, nullptr);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    glGenFramebuffers(1, framebuffer); glBindFramebuffer(GL_FRAMEBUFFER, *framebuffer);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, *texture, 0);
    if (with_depth) {
        glGenRenderbuffers(1, &scene_depth); glBindRenderbuffer(GL_RENDERBUFFER, scene_depth);
        glRenderbufferStorage(GL_RENDERBUFFER, GL_DEPTH_COMPONENT16, width, height);
        glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, GL_RENDERBUFFER, scene_depth);
    }
    if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) {
        std::fputs("MK64: graphics framebuffer unavailable.\n", stderr); std::abort();
    }
}
static void draw_post(GLuint destination, int width, int height, float u, float v, float uw, float vh, bool aa) {
    GLint previous_active; glGetIntegerv(GL_ACTIVE_TEXTURE, &previous_active);
    glBindFramebuffer(GL_FRAMEBUFFER, destination);
    glViewport(0,0,width,height); glDisable(GL_SCISSOR_TEST); glDisable(GL_DEPTH_TEST);
    glDisable(GL_BLEND); glDisable(GL_POLYGON_OFFSET_FILL); glDepthMask(false);
    glUseProgram(post_program); glBindBuffer(GL_ARRAY_BUFFER,post_buffer);
    for (int i=0;i<8;++i) glDisableVertexAttribArray(i);
    glEnableVertexAttribArray(0); glVertexAttribPointer(0,2,GL_FLOAT,GL_FALSE,0,nullptr);
    glActiveTexture(GL_TEXTURE0); glBindTexture(GL_TEXTURE_2D,scene_texture);
    glUniform1i(glGetUniformLocation(post_program,"uTexture"),0);
    glUniform2f(glGetUniformLocation(post_program,"uPixel"),1.0f/web_render_width(),1.0f/web_render_height());
    glUniform4f(glGetUniformLocation(post_program,"uRect"),u,v,uw,vh);
    glUniform1i(glGetUniformLocation(post_program,"uAA"),aa);
    glDrawArrays(GL_TRIANGLES,0,3);
    glDisableVertexAttribArray(0);
    // Restore all state represented by the display-list interpreter's cache.
    glActiveTexture(GL_TEXTURE0); glBindTexture(GL_TEXTURE_2D,bound[0]);
    glActiveTexture(GL_TEXTURE1); glBindTexture(GL_TEXTURE_2D,bound[1]);
    glActiveTexture(previous_active); glBindBuffer(GL_ARRAY_BUFFER,buffer);
    glUseProgram(current ? current->program : 0); apply_depth();
     toggle(GL_BLEND,blend_enabled); toggle(GL_POLYGON_OFFSET_FILL,decal_enabled);
    glEnable(GL_SCISSOR_TEST);
    glViewport(current_viewport[0],current_viewport[1],current_viewport[2],current_viewport[3]);
    glScissor(current_scissor[0],current_scissor[1],current_scissor[2],current_scissor[3]);
    glBindFramebuffer(GL_FRAMEBUFFER,scene_framebuffer);
}
static void init() {
    glActiveTexture(GL_TEXTURE0);glDisable(GL_DEPTH_TEST);glDisable(GL_BLEND);
    glDisable(GL_POLYGON_OFFSET_FILL);glDepthMask(false);
    glGenBuffers(1,&buffer); glBindBuffer(GL_ARRAY_BUFFER,buffer);
    glDepthFunc(GL_LEQUAL); glBlendFunc(GL_SRC_ALPHA,GL_ONE_MINUS_SRC_ALPHA);
    target(&scene_framebuffer,&scene_texture,web_render_width(),web_render_height(),true);
    target(&tv_framebuffer,&tv_texture,320,240,false);
    const std::string vs="attribute vec2 aPosition; varying vec2 vUV; uniform vec4 uRect; void main(){gl_Position=vec4(aPosition,0.0,1.0);vUV=uRect.xy+(aPosition*0.5+0.5)*uRect.zw;}";
    const std::string fs=R"GLSL(
precision highp float;
varying vec2 vUV; uniform sampler2D uTexture; uniform vec2 uPixel; uniform bool uAA;
float luma(vec3 c){return dot(c,vec3(0.299,0.587,0.114));}
void main(){
    vec3 middle=texture2D(uTexture,vUV).rgb;
    if(!uAA){gl_FragColor=vec4(middle,1.0);return;}
    float nw=luma(texture2D(uTexture,vUV+uPixel*vec2(-1.0,-1.0)).rgb);
    float ne=luma(texture2D(uTexture,vUV+uPixel*vec2(1.0,-1.0)).rgb);
    float sw=luma(texture2D(uTexture,vUV+uPixel*vec2(-1.0,1.0)).rgb);
    float se=luma(texture2D(uTexture,vUV+uPixel*vec2(1.0,1.0)).rgb);
    float lm=luma(middle),lo=min(lm,min(min(nw,ne),min(sw,se))),hi=max(lm,max(max(nw,ne),max(sw,se)));
    if(hi-lo<max(0.0312,hi*0.125)){gl_FragColor=vec4(middle,1.0);return;}
    vec2 direction=vec2(-((nw+ne)-(sw+se)),(nw+sw)-(ne+se));
    float reduce=max((nw+ne+sw+se)*0.03125,0.0078125);
    direction=clamp(direction/(min(abs(direction.x),abs(direction.y))+reduce),vec2(-8.0),vec2(8.0))*uPixel;
    vec3 narrow=0.5*(texture2D(uTexture,vUV-direction/6.0).rgb+texture2D(uTexture,vUV+direction/6.0).rgb);
    vec3 wide=narrow*0.5+0.25*(texture2D(uTexture,vUV-direction*0.5).rgb+texture2D(uTexture,vUV+direction*0.5).rgb);
    float lw=luma(wide);
    gl_FragColor=vec4(lw<lo||lw>hi?narrow:wide,1.0);
})GLSL";
    GLuint vertex=compile(GL_VERTEX_SHADER,vs),fragment=compile(GL_FRAGMENT_SHADER,fs);
    post_program=glCreateProgram();glAttachShader(post_program,vertex);glAttachShader(post_program,fragment);
    glBindAttribLocation(post_program,0,"aPosition");glLinkProgram(post_program);
    glDeleteShader(vertex);glDeleteShader(fragment);
    GLint linked;glGetProgramiv(post_program,GL_LINK_STATUS,&linked);
    if(!linked){std::fputs("MK64: anti-aliasing shader link failed.\n",stderr);std::abort();}
    const float positions[]={-1,-1,3,-1,-1,3};
    glGenBuffers(1,&post_buffer);glBindBuffer(GL_ARRAY_BUFFER,post_buffer);
    glBufferData(GL_ARRAY_BUFFER,sizeof(positions),positions,GL_STATIC_DRAW);
    glBindBuffer(GL_ARRAY_BUFFER,buffer);glBindTexture(GL_TEXTURE_2D,0);
    glBindFramebuffer(GL_FRAMEBUFFER,scene_framebuffer);
    hd_enabled=EM_ASM_INT({return Module.mk64HD && !Module.mk64GraphicsBaseline ? 1 : 0;});
    viewport(0,0,web_render_width(),web_render_height());scissor(0,0,web_render_width(),web_render_height());
}
static void noop() {}
static void start() {glBindFramebuffer(GL_FRAMEBUFFER,scene_framebuffer);glDisable(GL_SCISSOR_TEST);glDepthMask(true);glClearColor(0,0,0,1);glClear(GL_COLOR_BUFFER_BIT|GL_DEPTH_BUFFER_BIT);glDepthMask(depth_write);glEnable(GL_SCISSOR_TEST);}
static void end() {bool aa=!web_graphics_baseline();draw_post(0,web_render_width(),web_render_height(),0,0,1,1,aa);if(aa)++aa_frames;}
static void shutdown() {
    // Restart keeps the canvas/context. Release every resource from the retired
    // module even when diagnostics retain a reference to that module's memory.
    glBindFramebuffer(GL_FRAMEBUFFER,0);glUseProgram(0);
    for (auto &entry:shaders) glDeleteProgram(entry.second.program);
    shaders.clear();current=nullptr;
    if (!game_textures.empty()) glDeleteTextures(game_textures.size(),game_textures.data());
    game_textures.clear();texture_pot.clear();
    const GLuint textures[]={scene_texture,tv_texture};glDeleteTextures(2,textures);
    const GLuint framebuffers[]={scene_framebuffer,tv_framebuffer};glDeleteFramebuffers(2,framebuffers);
    const GLuint buffers[]={buffer,post_buffer};glDeleteBuffers(2,buffers);
    glDeleteRenderbuffers(1,&scene_depth);glDeleteProgram(post_program);
}
GfxRenderingAPI gfx_opengl_api={zero_to_one,unload,load,create,lookup,info,new_texture,select_texture,upload,sampler,depth,mask,decal,viewport,scissor,alpha,triangles,init,shutdown,start,end,noop};
