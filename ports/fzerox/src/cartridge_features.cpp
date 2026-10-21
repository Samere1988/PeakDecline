// The cartridge browser target has no 64DD Course Editor. These optional
// editor hooks explicitly leave all keyboard/mouse input available to the game.
extern "C" int gdx_course_edit_mouse_on_key(int, int) { return 0; }
extern "C" int gdx_course_edit_mouse_owns_button(int) { return 0; }
extern "C" void gdx_course_edit_mouse_all_keys_up(void) {}
extern "C" void gdx_course_edit_mouse_on_wheel(int) {}
#include <cstdint>
#include <climits>
#include <cstddef>
// The browser release runs the stock US cartridge: no workshop model overrides,
// mouse-driven 64DD editor, or mutable desktop mod configuration.
extern "C" void GdxModelPacks_BeginMachineDraw(int32_t) {}
extern "C" void GdxModelPacks_OverrideMachineLodLists(int32_t, int32_t) {}
extern "C" int gdx_mouse_steer_stick_x(void) { return INT_MIN; }
extern "C" int gdx_course_edit_mouse_buttons(void) { return 0; }
extern "C" void gdx_course_edit_mouse_keyboard_tick(int) {}
extern "C" {
bool gInCourseEditTestRun = false;
void gdx_course_edit_mouse_inject_key_tap(int) {}
int gdx_audio_thread_active(void) { return 0; } // Audio runs on the cooperative game scheduler.
int gdx_workshop_texture_packs_enabled(void) { return 0; }
int gdx_workshop_texture_dump_enabled(void) { return 0; }
uint32_t GdxWorkshopPackEpoch(void) { return 0; }
const char* GdxWorkshopLookupOverridePath(const char*) { return nullptr; }
const char* GdxWorkshopLookupOverridePathMinSize(const char*, size_t) { return nullptr; }
const char* GdxWorkshopLookupAtlasTileOverride(const char*, size_t, int, int, int, int) { return nullptr; }
void gdx_workshop_dump_texture(const void*, size_t, const char*, const uint8_t*, int, int, int, int) {}
// Desktop ghost-library files are unavailable; the cartridge SRAM path remains active.
int gdx_ghost_library_archive_sram(void) { return 0; }
int gdx_ghost_library_save_player(int, const void*) { return 0; }
int gdx_ghost_library_get_player_stats(int32_t, int32_t*, int32_t*) { return 0; }
}
