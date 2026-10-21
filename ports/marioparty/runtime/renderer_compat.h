#ifndef MP_RENDERER_COMPAT_H
#define MP_RENDERER_COMPAT_H
#include <stdint.h>
#include <emscripten/emscripten.h>
extern uint8_t *mp_gfx_ram;
extern uint8_t mp_gfx_bytes[8*1024*1024];
extern uint32_t mp_segments[16],mp_commands,mp_opcode,mp_triangles;
extern int mp_trace;
extern unsigned configFiltering;
_Noreturn void sys_fatal(const char *format,...);
void mp_clear_depth(void);
#endif
