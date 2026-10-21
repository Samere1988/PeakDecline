/* Browser platform bridge for the MKart360 source port. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include <emscripten.h>
#include <ultra64.h>
#include <PR/os.h>
#include "main.h"
#include "menus.h"
#include "buffers.h"
#include "xbox360/platform.h"
#include "xbox360/assets.h"
#include "xbox360/netplay.h"
#include "xbox360/race8.h"
extern struct SPTask *create_next_audio_frame_task(void);
extern OSMesgQueue *D_800EA3B4;

unsigned char x360_rom[0xC00000] __attribute__((aligned(16)));
unsigned char x360_game_heap[0x1000000] __attribute__((aligned(16)));
u64 osClockRate = 62500000;
u32 osTvType = 1, osResetType;
s32 osAppNmiBuffer[16];
static unsigned char eeprom[512];
static OSTime time_origin;
static int web_multiplayer, web_native_menus, web_local_slot, web_player_count;
static int web_stop_requested, web_running;
static int graphics_baseline;
#ifdef WEB_AUTHORITY_CANDIDATE
static int web_headless, web_replaying, web_stepping, web_graphics_ready;
extern void web_graphics_shutdown(void);
static OSContPad web_step_pads[8];
extern void web_game_tick(void);
EMSCRIPTEN_KEEPALIVE void web_set_pad(int slot, int buttons, int x, int y) {
    if ((unsigned)slot >= 4) return;
    web_step_pads[slot].button = buttons;
    web_step_pads[slot].stick_x = x;
    web_step_pads[slot].stick_y = y;
}
EMSCRIPTEN_KEEPALIVE void web_step(int replaying) {
    web_replaying = replaying;
    web_stepping = 1;
    web_game_tick();
    web_stepping = web_replaying = 0;
}
#endif
int web_skip_audio(void) {
#ifdef WEB_AUTHORITY_CANDIDATE
    return web_headless || web_replaying;
#else
    return 0;
#endif
}
int web_skip_graphics(void) {
#ifdef WEB_AUTHORITY_CANDIDATE
    return web_headless || web_stepping;
#else
    return 0;
#endif
}

/* Asyncify suspends the original native while loop, not an Emscripten main
 * loop callback. Its owner must request cancellation and wait for the native
 * stack to return before replacing the module or canvas. */
EMSCRIPTEN_KEEPALIVE void web_stop(void) {
    web_stop_requested = 1;
#ifdef WEB_AUTHORITY_CANDIDATE
    if (web_graphics_ready) { web_graphics_shutdown(); web_graphics_ready = 0; }
#endif
    EM_ASM({ Module.mk64HD?.dispose(); });
}
int web_should_stop(void) { return web_stop_requested; }
EMSCRIPTEN_KEEPALIVE int web_is_stopped(void) { return !web_running; }
EMSCRIPTEN_KEEPALIVE int web_frame(void) { return gGlobalTimer; }
#ifdef WEB_AUTHORITY_CANDIDATE
EMSCRIPTEN_KEEPALIVE unsigned web_current_hash(void) {
    unsigned h = x360_net_state_hash();
    /* Menu choices must reconcile before entering the race, too. */
    const int values[] = {gMenuSelection, gMainMenuSelection, gMenuTimingCounter,
        gMenuDelayTimer, gMenuFadeType, gCupSelection, gCourseIndexInCup,
        gPlayerCountSelection1};
    for (unsigned i=0; i<sizeof(values)/sizeof(values[0]); ++i) h=(h^(unsigned)values[i])*16777619U;
    for (int i=0;i<4;++i) {
        h=(h^(unsigned)gCharacterGridSelections[i])*16777619U;
        h=(h^(unsigned)gCharacterGridIsSelected[i])*16777619U;
    }
    return h;
}
#endif
EMSCRIPTEN_KEEPALIVE int web_menu(void) { return gMenuSelection; }
EMSCRIPTEN_KEEPALIVE int web_state(void) { return gGamestate; }
EMSCRIPTEN_KEEPALIVE int web_race_state(void) { return gRaceState; }
EMSCRIPTEN_KEEPALIVE int web_selected_players(void) { return gPlayerCountSelection1; }
EMSCRIPTEN_KEEPALIVE int web_main_menu_selection(void) { return gMainMenuSelection; }
EMSCRIPTEN_KEEPALIVE int web_character_selected(int slot) {
    return slot >= 0 && slot < 4 ? gCharacterGridIsSelected[slot] : -1;
}
EMSCRIPTEN_KEEPALIVE double web_position(int axis) { return axis>=0 && axis<3 ? gPlayerOne->pos[axis] : 0; }
EMSCRIPTEN_KEEPALIVE double web_player_position(int slot, int axis) {
    return slot>=0 && slot<web_player_count && axis>=0 && axis<3 ? gPlayers[slot].pos[axis] : 0;
}
// A completed-frame history lets two browser processes be compared at the
// same simulation frame even when their rendering schedules differ.
struct WebFrameHash { u32 frame, hash; };
static struct WebFrameHash frame_hashes[2048];
EMSCRIPTEN_KEEPALIVE unsigned web_hash_for_frame(unsigned frame) {
    const struct WebFrameHash *entry = &frame_hashes[frame % 2048];
    return entry->frame == frame ? entry->hash : 0;
}

void x360_log(const char *message) { fputs(message, stdout); }
void x360_progress(int stage) {
    if (stage == 6 && !web_stop_requested) {
        u32 frame = gGlobalTimer;
        frame_hashes[frame % 2048] = (struct WebFrameHash){frame, x360_net_state_hash()};
        /* The native port runs audio at 60 Hz; browser game frames are 30 Hz. */
        for (int i = 0; i < 2; ++i) {
            struct SPTask *task = create_next_audio_frame_task();
            if (task) x360_dispatch_audio_task(task);
        }
    }
}
void x360_sleep_ms(unsigned ms) { emscripten_sleep(ms); }
double x360_time_seconds(void) { return emscripten_get_now() / 1000.0; }
int x360_logging_enabled(void) { return 0; }
int x360_net_active(void) { return web_multiplayer && !web_native_menus; }
int x360_net8_active(void) { return web_multiplayer && !web_native_menus; }
int x360_net_player_count(void) { return web_multiplayer ? web_player_count : 1; }
int x360_net_local_slot(void) { return web_multiplayer ? web_local_slot : 0; }
int x360_net_local_count(void) { return 1; }
int x360_net_is_local(int slot) { return slot == x360_net_local_slot(); }
unsigned int x360_net_frame(void) { return gGlobalTimer; }
int x360_music_enabled(void) { return 1; }
// Internal regression mode only; the shipped player always uses 1080p16:9.
int web_graphics_baseline(void) { return graphics_baseline; }
int x360_display_widescreen(void) { return !web_graphics_baseline(); }
float x360_display_aspect(void) { return web_graphics_baseline() ? 4.0f / 3.0f : 16.0f / 9.0f; }
int x360_net8_course(void) { return 8; }
int x360_net8_cc(void) { return 0; }
int x360_net8_character(int slot) { return slot >= 0 && slot < 4 ? slot : 0; }
void x360_net8_configure(void) {}

void osCreateMesgQueue(OSMesgQueue *q, OSMesg *buffer, s32 count) {
    memset(q, 0, sizeof(*q)); q->msg = buffer; q->msgCount = count;
}
s32 osSendMesg(OSMesgQueue *q, OSMesg message, s32 flag) {
    if (q->validCount >= q->msgCount) return -1;
    q->msg[(q->first + q->validCount++) % q->msgCount] = message;
    return 0;
}
s32 osRecvMesg(OSMesgQueue *q, OSMesg *message, s32 flag) {
    /* The original game blocks on the audio-reset completion queue. Audio
     * synthesis shares the browser thread, so drive it until it posts the
     * completion message before allowing the new song to start. */
    if (!q->validCount && flag == OS_MESG_BLOCK && q == D_800EA3B4) {
        for (int attempt = 0; attempt < 128 && !q->validCount && !web_stop_requested; ++attempt) {
            struct SPTask *task = create_next_audio_frame_task();
            if (task) x360_dispatch_audio_task(task);
#ifndef WEB_AUTHORITY_CANDIDATE
            emscripten_sleep(16);
#endif
        }
        if (web_stop_requested) return -1;
        if (!q->validCount) {
            fputs("MK64: audio reset did not complete.\n", stderr);
            abort();
        }
    }
    if (!q->validCount) return -1;
    if (message) *message = q->msg[q->first];
    q->first = (q->first + 1) % q->msgCount; --q->validCount; return 0;
}
void osSetEventMesg(OSEvent event, OSMesgQueue *q, OSMesg message) {}
void osCreatePiManager(OSPri priority, OSMesgQueue *q, OSMesg *buf, s32 count) { osCreateMesgQueue(q, buf, count); }
s32 osPiStartDma(OSIoMesg *io, s32 priority, s32 direction, uintptr_t device, void *ram, size_t size, OSMesgQueue *q) {
    if (direction != OS_READ) return -1;
    memcpy(ram, (void *)device, size);
    /* Serialized audio table headers contain big-endian counts and pointers. */
    uintptr_t offset = device - (uintptr_t)x360_rom;
    if (offset == 0xBC5F60 || offset == 0x966260 || offset == 0x979AA0) {
        u16 *header = ram;
        header[0] = __builtin_bswap16(header[0]);
        header[1] = __builtin_bswap16(header[1]);
        u32 *entries = (u32 *)((u8 *)ram + 4);
        for (size_t i = 0; i < (size - 4) / 4; ++i) entries[i] = __builtin_bswap32(entries[i]);
    }
    return osSendMesg(q, (OSMesg)io, OS_MESG_NOBLOCK);
}
void osInvalDCache(void *p, size_t size) {}
void osInvalICache(void *p, size_t size) {}
void osWritebackDCacheAll(void) {}
OSTime osGetTime(void) { return (OSTime)(emscripten_get_now() * 46875.0) - time_origin; }
void osSetTime(OSTime time) { time_origin = (OSTime)(emscripten_get_now() * 46875.0) - time; }
void osViSetEvent(OSMesgQueue *q, OSMesg msg, u32 count) {}
void rmonPrintf(const char *format, ...) {
    va_list args; va_start(args, format); vprintf(format, args); va_end(args);
}
u32 osGetCount(void) { return (u32)osGetTime(); }
void osViSetSpecialFeatures(u32 flags) {}
void osViBlack(u8 black) {}
void osViSwapBuffer(void *buffer) {}
static u32 audio_rate = 26800;
u32 osAiGetLength(void) {
#ifdef WEB_AUTHORITY_CANDIDATE
    return 0;
#endif
    return EM_ASM_INT({ return Module.mk64Audio ? Module.mk64Audio.queuedSamples($0) * 4 : 0; }, audio_rate);
}
s32 osAiSetFrequency(u32 rate) { audio_rate = rate; return rate; }
s32 osAiSetNextBuffer(void *buffer, u32 bytes) {
    if (!web_skip_audio() && buffer && bytes && (bytes % 4) == 0) EM_ASM({
        if (Module.mk64Audio) Module.mk64Audio.enqueue(HEAP16.subarray($0 >> 1, ($0 + $1) >> 1), $2);
    }, buffer, bytes, audio_rate);
    return 0;
}
int x360_audio_generation_size(int nominal, unsigned queued, int minimum, int maximum) {
    int wanted = ((nominal - (int)queued + 2680) & ~15) + 16;
    return wanted < minimum ? minimum : wanted > maximum ? maximum : wanted;
}
s32 osContInit(OSMesgQueue *q, u8 *bits, OSContStatus *status) {
    *bits = 1; memset(status, 0, sizeof(OSContStatus) * 4);
    status[0].type = CONT_TYPE_NORMAL;
    for (int i = 1; i < 4; ++i) status[i].errnum = CONT_NO_RESPONSE_ERROR;
    return 0;
}
void x360_read_controllers(void *data, int count) {
    OSContPad *pads = data;
    memset(pads, 0, sizeof(*pads) * count);
#ifdef WEB_AUTHORITY_CANDIDATE
    memcpy(pads, web_step_pads, sizeof(*pads) * (count < 8 ? count : 8));
    for (int slot=web_player_count; slot<count; ++slot) pads[slot].errno = CONT_NO_RESPONSE_ERROR;
    return;
#endif
    if (web_multiplayer) {
        int network = EM_ASM_INT({ return Module.mk64Network ? 1 : 0; });
        if (network) {
            int ready;
            while (!web_stop_requested && (ready = EM_ASM_INT({ return Module.mk64Network.frameReady($0); }, gGlobalTimer)) == 0)
                emscripten_sleep(2);
            if (web_stop_requested || ready < 0) {
                web_stop_requested = 1;
                return;
            }
        }
        for (int slot=0; slot<web_player_count && slot<count; ++slot) {
            u32 packed = EM_ASM_INT({
                const pair = Module.mk64Network ? Module.mk64Network.getFrame($0) :
                    Module.mk64InputsAtFrame ? Module.mk64InputsAtFrame($0) : null;
                const pad = pair && pair[$1];
                return pad ? ((pad.buttons & 65535) | ((pad.x & 255)<<16) | ((pad.y & 255)<<24)) >>> 0 : 0;
            }, gGlobalTimer, slot);
            pads[slot].button = packed & 0xffff;
            pads[slot].stick_x = (s8)(packed >> 16);
            pads[slot].stick_y = (s8)(packed >> 24);
        }
        for (int slot=web_player_count; slot<count; ++slot) pads[slot].errno = CONT_NO_RESPONSE_ERROR;
        return;
    }
    int buttons = EM_ASM_INT({ const input = Module.mk64InputAtFrame ? Module.mk64InputAtFrame($0) : Module.mk64Input; return input ? input.buttons : 0; }, gGlobalTimer);
    int x = EM_ASM_INT({ const input = Module.mk64InputAtFrame ? Module.mk64InputAtFrame($0) : Module.mk64Input; return input ? input.x : 0; }, gGlobalTimer);
    int y = EM_ASM_INT({ const input = Module.mk64InputAtFrame ? Module.mk64InputAtFrame($0) : Module.mk64Input; return input ? input.y : 0; }, gGlobalTimer);
    pads[0].button = buttons; pads[0].stick_x = x; pads[0].stick_y = y;
    for (int i = 1; i < count; ++i) pads[i].errno = CONT_NO_RESPONSE_ERROR;
}
s32 osEepromProbe(OSMesgQueue *q) { return 1; }
/* No Controller Pak device is attached to the browser build. */
s32 osPfsIsPlug(OSMesgQueue *q, u8 *pattern) { if (pattern) *pattern = 0; return 0; }
s32 osPfsInit(OSMesgQueue *q, OSPfs *pak, int channel) { return PFS_ERR_NOPACK; }
s32 osPfsFreeBlocks(OSPfs *pak, s32 *bytes) { if (bytes) *bytes = 0; return PFS_ERR_NOPACK; }
s32 osPfsNumFiles(OSPfs *pak, s32 *max, s32 *used) { if (max) *max = 0; if (used) *used = 0; return PFS_ERR_NOPACK; }
s32 osPfsAllocateFile(OSPfs *pak, u16 company, u32 game, u8 *name, u8 *ext, int size, s32 *number) { if (number) *number = -1; return PFS_ERR_NOPACK; }
s32 osPfsFindFile(OSPfs *pak, u16 company, u32 game, u8 *name, u8 *ext, s32 *number) { if (number) *number = -1; return PFS_ERR_NOPACK; }
s32 osPfsDeleteFile(OSPfs *pak, u16 company, u32 game, u8 *name, u8 *ext) { return PFS_ERR_NOPACK; }
s32 osPfsReadWriteFile(OSPfs *pak, s32 file, u8 flag, int offset, int size, u8 *data) { return PFS_ERR_NOPACK; }
s32 osPfsFileState(OSPfs *pak, s32 file, OSPfsState *state) { if (state) memset(state, 0, sizeof(*state)); return PFS_ERR_NOPACK; }
s32 osEepromLongRead(OSMesgQueue *q, u8 address, u8 *data, s32 length) {
    unsigned offset = address * 8;
    if (length < 0 || offset + length > 512) return -1;
    memcpy(data, eeprom + offset, length); return 0;
}
s32 osEepromLongWrite(OSMesgQueue *q, u8 address, u8 *data, s32 length) {
    unsigned offset = address * 8;
    if (length < 0 || offset + length > 512) return -1;
    memcpy(eeprom + offset, data, length);
#ifdef WEB_AUTHORITY_CANDIDATE
    return 0; /* Never persist speculative or replayed account saves. */
#endif
    FILE *save = fopen("/eeprom.bin", "wb");
    if (!save) return -1;
    size_t written = fwrite(eeprom, 1, sizeof(eeprom), save);
    fclose(save);
    return written == sizeof(eeprom) ? 0 : -1;
}

extern void web_graphics_init(void);
extern void web_graphics_shutdown(void);
extern void setup_mesg_queues(void);
extern void setup_game_memory(void);
extern void audio_init(void);
extern void thread5_game_loop(void *);
static int web_main(void) {
    graphics_baseline = EM_ASM_INT({ return Module.mk64GraphicsBaseline === true ? 1 : 0; });
    web_multiplayer = EM_ASM_INT({ return Module.mk64Multiplayer ? 1 : 0; });
    web_native_menus = EM_ASM_INT({ return Module.mk64NativeMenus ? 1 : 0; });
    web_local_slot = EM_ASM_INT({ return Module.mk64LocalSlot || 0; });
    web_player_count = web_multiplayer ? EM_ASM_INT({ return Math.max(2, Math.min(4, Module.mk64PlayerCount || 2)); }) : 1;
#ifdef WEB_AUTHORITY_CANDIDATE
    web_player_count = EM_ASM_INT({ return Math.max(1, Math.min(4, Module.mk64PlayerCount || 1)); });
#endif
    FILE *rom = fopen("/baserom.us.z64", "rb");
    if (!rom || fread(x360_rom, 1, sizeof(x360_rom), rom) != sizeof(x360_rom)) {
        fputs("Mario Kart ROM is missing or incomplete.\n", stderr); return 1;
    }
    fclose(rom);
    /* Refuse unknown ROM data before any native pointer or asset decoding. */
    u32 crc = 0xffffffffU;
    for (size_t i = 0; i < sizeof(x360_rom); ++i) {
        crc ^= x360_rom[i];
        for (int bit = 0; bit < 8; ++bit) crc = (crc >> 1) ^ (0xedb88320U & -(crc & 1));
    }
    if ((crc ^ 0xffffffffU) != 0x434389c1U) {
        fputs("This build requires the original US Mario Kart 64 ROM.\n", stderr);
        abort();
    }
    memset(eeprom, 0xff, sizeof(eeprom));
    FILE *save = fopen("/eeprom.bin", "rb");
    if (save) {
        if (fread(eeprom, 1, sizeof(eeprom), save) != sizeof(eeprom)) {
            fclose(save); fputs("Invalid account EEPROM.\n", stderr); return 1;
        }
        fclose(save);
    }
    // The browser starts the game loop directly, bypassing thread3_video's
    // framebuffer setup. Track televisions still use these three CPU buffers.
    for (int i=0; i<3; ++i) gPhysicalFramebuffers[i] = gFramebuffers[i];
#ifdef WEB_AUTHORITY_CANDIDATE
    web_headless = EM_ASM_INT({ return Module.mk64Headless ? 1 : 0; });
#endif
    if (!web_skip_graphics()) {
        web_graphics_init();
#ifdef WEB_AUTHORITY_CANDIDATE
        web_graphics_ready = 1;
#endif
    }
    setup_mesg_queues();
    setup_game_memory();
    puts("MK64: browser game memory ready");
    audio_init();
    if (web_stop_requested) { web_graphics_shutdown(); return 0; }
    thread5_game_loop(NULL);
#ifndef WEB_AUTHORITY_CANDIDATE
    web_graphics_shutdown();
#endif
    return 0;
}

int main(void) {
    if (web_stop_requested) return 0;
    web_running = 1;
    int result = web_main();
    web_running = 0;
    return result;
}
