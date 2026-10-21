# Cartridge-only game sources use the decomp's types; host C++ uses system types.
get_filename_component(WORK "${CMAKE_CURRENT_SOURCE_DIR}/../../../.tmp/fzerox" ABSOLUTE)
set(UPSTREAM "${WORK}/G-Diffuser")
set(PORT "${UPSTREAM}/port")
file(READ "${WORK}/build/compile-results.json" COMPILE_RESULTS)
string(JSON SOURCE_COUNT LENGTH "${COMPILE_RESULTS}")
math(EXPR LAST_SOURCE "${SOURCE_COUNT} - 1")
set(GAME_SOURCES)
foreach(INDEX RANGE ${LAST_SOURCE})
  string(JSON SOURCE GET "${COMPILE_RESULTS}" ${INDEX} source)
  if(SOURCE STREQUAL "port/n64_sched.c" OR SOURCE STREQUAL "port/shims.c"
      OR SOURCE STREQUAL "port/n64_audio_hle.c"
      OR SOURCE STREQUAL "decomp/src/sys/sys_gfx.c"
      OR SOURCE STREQUAL "decomp/src/audio/rom/external.c"
      OR SOURCE STREQUAL "decomp/src/audio/rom/lib/load.c"
      OR SOURCE STREQUAL "decomp/src/audio/rom/lib/heap.c"
      OR SOURCE STREQUAL "decomp/src/audio/rom/lib/thread.c"
      OR SOURCE STREQUAL "decomp/src/audio/rom/lib/seqplayer.c")
    list(APPEND GAME_SOURCES "${WORK}/browser-source/${SOURCE}")
  else()
    list(APPEND GAME_SOURCES "${UPSTREAM}/${SOURCE}")
  endif()
endforeach()
add_library(fzero_game OBJECT ${GAME_SOURCES}
  ../src/cartridge_hardware.c
  ../src/web_state.c
  "${UPSTREAM}/decomp/src/libultra/io/devmgr.c"
  "${WORK}/browser-source/port/link_markers.c")
target_include_directories(fzero_game PRIVATE "${WORK}/build/include"
  "${UPSTREAM}/decomp" "${UPSTREAM}/decomp/src" "${UPSTREAM}/include" "${PORT}")
target_compile_definitions(fzero_game PRIVATE PORT=1 GDIFFUSER_PORT=1 NON_MATCHING=1
  NON_EQUIVALENT=1 AVOID_UB=1 F3DEX_GBI_2=1 _LANGUAGE_C=1 VERSION_US=1 ASSET_VERSION=us ASSET_REVISION=rev0)
target_compile_options(fzero_game PRIVATE -O1 -fno-strict-aliasing -fwrapv -w
  -Wno-error=int-conversion -Wno-error=incompatible-pointer-types -Wno-error=implicit-function-declaration)

add_executable(fzerox
  ../src/web_main.cpp ../src/web_fiber.c ../src/cartridge_features.cpp
  "${WORK}/browser-source/port/n64_gfx_bridge.cpp"
  "${PORT}/n64_gfx_convert.cpp" "${PORT}/gdx_interp.cpp"
  "${PORT}/gdx_vi_convert.c" "${PORT}/input_bridge.c"
  "${PORT}/gdx_input_script.c" "${PORT}/AssetLoader.cpp"
  "${PORT}/resource/ResourceFactories.cpp" "${PORT}/rom_buffer.cpp"
  "${PORT}/sram_buffer.cpp" "${PORT}/mio0_wrap.c"
  "${PORT}/enhancements/events/GameEvents.cpp"
  "${PORT}/gdx_xcup_seed.c" "${PORT}/gdx_course_strings.c"
  "${PORT}/gdx_custom_grid.c"
  "${PORT}/gdx_audio_seq_packs.cpp" "${PORT}/gdx_hackmods.cpp"
  "${PORT}/gdx_perf.cpp"
  "${UPSTREAM}/torch/lib/libmio0/mio0.c"
  $<TARGET_OBJECTS:fzero_game>)
target_include_directories(fzerox PRIVATE "${PORT}" "${UPSTREAM}/torch/lib/libmio0")
target_compile_definitions(fzerox PRIVATE PORT=1 GDIFFUSER_PORT=1)
target_compile_options(fzerox PRIVATE -O1 -g -Wno-error=int-conversion -Wno-error=incompatible-pointer-types)
set_source_files_properties("${PORT}/input_bridge.c" PROPERTIES INCLUDE_DIRECTORIES "${WORK}/build/include")
target_compile_options(fzerox PRIVATE -Wno-c++11-narrowing)
target_link_libraries(fzerox PRIVATE libultraship)
target_link_options(fzerox PRIVATE -O0 -g2 -sUSE_WEBGL2=1 -sFULL_ES3=1
  -sMIN_WEBGL_VERSION=2 -sMAX_WEBGL_VERSION=2
  -Wl,--error-limit=0 -Wl,--fatal-warnings
  -Wl,--wrap=osGetTime -Wl,--wrap=osSetTime
  -sALLOW_MEMORY_GROWTH=1 -sPTHREAD_POOL_SIZE=4 -sASSERTIONS=1 -sASYNCIFY=1
  -sSTACK_SIZE=8388608 -sGLOBAL_BASE=268435456 -sINITIAL_MEMORY=402653184
  -sFORCE_FILESYSTEM=1 -sEXPORTED_RUNTIME_METHODS=FS,callMain
  "--preload-file=${CMAKE_BINARY_DIR}/gdiffuser.o2r@/gdiffuser.o2r")
