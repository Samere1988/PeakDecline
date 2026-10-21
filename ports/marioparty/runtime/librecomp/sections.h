#ifndef PEAK_MP_SECTIONS_H
#define PEAK_MP_SECTIONS_H
#include "recomp.h"
#define ARRLEN(a) (sizeof(a)/sizeof((a)[0]))
#define nullptr NULL
/* Metadata adapter for N64Recomp's generated overlay table. */
typedef struct { recomp_func_t *func; uint32_t offset, rom_size; } FuncEntry;
typedef struct {
    uint32_t rom_addr, ram_addr, size;
    FuncEntry *funcs;
    size_t num_funcs;
    void *relocs;
    size_t num_relocs;
    unsigned index;
} SectionTableEntry;
#endif
