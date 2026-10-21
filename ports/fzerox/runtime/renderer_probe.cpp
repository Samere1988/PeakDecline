#include "ship/Context.h"
#include "fast/Fast3dWindow.h"
#include <emscripten.h>
#include <memory>
#include <cstdio>

static std::shared_ptr<Ship::Context> context;
static void frame() {
    auto window = context->GetWindow();
    window->HandleEvents();
    window->StartFrame();
    window->EndFrame();
    EM_ASM({window.fzeroRendererFrames = (window.fzeroRendererFrames || 0) + 1;});
}

int main() {
    context = Ship::Context::CreateUninitializedInstance("F-Zero browser renderer", "fzerox", "/fzerox.json");
    puts("InitLogging"); context->InitLogging();
    puts("InitConfiguration"); context->InitConfiguration();
    puts("InitConsoleVariables"); context->InitConsoleVariables();
    puts("InitResourceManager"); context->InitResourceManager({"/gdiffuser.o2r"}, {}, 1);
    puts("InitControlDeck"); context->InitControlDeck(nullptr);
    puts("InitConsole"); context->InitConsole();
    puts("InitWindow"); context->InitWindow(std::make_shared<Fast::Fast3dWindow>());
    puts("InitAudio"); context->InitAudio({});
    puts("InitEventSystem"); context->InitEventSystem();
    puts("InitFileDropMgr"); context->InitFileDropMgr();
    if (!context) return 1;
    emscripten_set_main_loop(frame, 0, true);
    return 0;
}
