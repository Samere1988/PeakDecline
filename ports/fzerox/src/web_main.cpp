// Browser host for the US cartridge source port. The game executes as C/WASM.
#include "ship/Context.h"
#include "fast/Fast3dWindow.h"
#include "ship/window/gui/Gui.h"
#include "resource/ResourceFactories.h"
#include "libultraship/controller/controldeck/ControlDeck.h"
#include <SDL.h>
#include "rom_buffer.h"
#include "n64_gfx_bridge.h"
#include "gdx_dev_gates.h"
#include <emscripten.h>
#include <cstdint>
#include <cstdlib>
#include <cstdio>
#include <memory>

extern "C" {
void gdx_sched_init(void);
void gdx_dispatch(void);
void gdx_sched_drain_deferred_wakes(void);
void gdx_rdram_init(void);
void gdx_register_host_range(void*, size_t);
void gdx_register_main_module_range(void);
void gdx_boot_warm_asset_segments(void);
void GDiffuser_LoadAllAssets(void);
void gdx_controller_poll(void);
void gdx_fixed_aspect_tick(void);
void gdx_vi_tick(void);
void bootproc(void);
extern int gGameMode, gGameFrameCount;
extern uint32_t osMemSize;
uint32_t web_state_hash(void);
}

static std::shared_ptr<Ship::Context> context;
static uint32_t tick;
static uint8_t controllerBits;
static uint64_t timeBase;
static uint32_t baseTick;
extern "C" uint64_t __wrap_osGetTime(void) { return timeBase + uint64_t(tick - baseTick) * 781250; }
extern "C" void __wrap_osSetTime(uint64_t value) { timeBase = value; baseTick = tick; }
extern "C" void gdx_request_quit(void) { emscripten_cancel_main_loop(); }
static void frame() {
    if (!EM_ASM_INT({ return window.peakGameBridge ? window.peakGameBridge.ready($0) : 1; }, tick + 1)) return;
    EM_ASM({ if (window.peakGameBridge) window.fzeroPads = window.peakGameBridge.pads($0); }, tick + 1);
    auto window = context->GetWindow();
    window->HandleEvents();
    gdx_controller_poll();
    gdx_fixed_aspect_tick();
    gdx_gfx_interp_tick_config(0, tick / 60.0, 1.0 / 60.0, 1);
    gdx_vi_tick();
    window->GetGui()->StartDraw();
    window->StartFrame();
    gdx_sched_drain_deferred_wakes();
    gdx_dispatch();
    gdx_vi_present_fallback();
    window->GetGui()->EndDraw();
    window->EndFrame();
    ++tick;
    EM_ASM({ window.fzeroState = {}; window.fzeroState.tick = $0; window.fzeroState.mode = $1; window.fzeroState.frame = $2; }, tick, gGameMode, gGameFrameCount);
    EM_ASM({ if (window.peakGameBridge) window.peakGameBridge.completed($0, $1 >>> 0); }, tick, web_state_hash());
}

extern "C" int gdx_lus_read_pads(int capacity, uint16_t* buttons, int8_t* x, int8_t* y, uint8_t* connected) {
    for (int i = 0; i < capacity; ++i) {
        uint32_t packed = EM_ASM_INT({
            var pads = window.fzeroPads || [];
            var p = pads[$0];
            return p ? ((p.buttons & 65535) | ((p.x & 255) << 16) | ((p.y & 255) << 24)) : 0;
        }, i);
        buttons[i] = packed; x[i] = packed >> 16; y[i] = packed >> 24;
        connected[i] = EM_ASM_INT({ return $0 === 0 || $0 < (window.fzeroPads || []).length; }, i);
    }
    return 1;
}

int main() {
    setenv("GDX_TRACE", "0", 1);
    gdx_dev_gates_boot_seed(nullptr);
    setenv("GDX_RAND_SEED1", "12345", 1);
    setenv("GDX_RAND_SEED2", "9876", 1);
    // Window constructors read the global context/config; construct them only
    // after those objects exist (passing one to CreateInstance is too early).
    context = Ship::Context::CreateUninitializedInstance("F-Zero X", "fzerox", "/fzerox.json");
    puts("[boot] configuration");
    context->InitLogging(); context->InitConfiguration(); context->InitConsoleVariables();
    context->InitResourceManager({"/gdiffuser.o2r"}, {}, 1);
    SDL_InitSubSystem(SDL_INIT_GAMECONTROLLER);
    auto deck = std::make_shared<LUS::ControlDeck>();
    context->InitControlDeck(deck); deck->Init(&controllerBits);
    context->InitConsole();
    puts("[boot] window");
    context->InitWindow(std::make_shared<Fast::Fast3dWindow>());
    context->InitAudio({}); context->InitEventSystem(); context->InitFileDropMgr();
    puts("[boot] assets");
    GDiffuser::RegisterResourceFactories(context->GetResourceManager()->GetResourceLoader());
    char name[] = "fzerox";
    char rom[] = "/game.z64";
    char* args[] = {name, rom};
    gdx_init_rom(2, args, false);
    GDiffuser_LoadAllAssets();
    gdx_sched_init();
    gdx_rdram_init();
    gdx_register_host_range(gdx_rom_buffer, gdx_rom_size);
    gdx_register_main_module_range();
    gdx_boot_warm_asset_segments();
    // Expose the cartridge's base console RAM configuration. The host asset
    // arena remains larger; reporting Expansion Pak RAM triggers 64DD overlay
    // DMA/BSS initialization, which has no place in this cartridge-only build.
    osMemSize = 0x400000;
    puts("[boot] game threads");
    bootproc();
    puts("[boot] main loop");
    EM_ASM({ if (window.peakGameBridge) window.peakGameBridge.loaded(); });
    // Do not throw Emscripten's simulated infinite-loop exception while leaving
    // a fiber trampoline: it leaves trampolineRunning latched and blocks swaps.
    emscripten_set_main_loop(frame, 60, false);
    return 0;
}
