cmake_minimum_required(VERSION 3.24)
project(PeakCMR2 LANGUAGES C CXX)
if(NOT EMSCRIPTEN)
    message(FATAL_ERROR "Use the Emscripten toolchain")
endif()
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_C_STANDARD 99)
add_compile_options(-O2 -fwrapv -fno-strict-aliasing -fsigned-char -ffp-contract=off)
set(SDL_SHARED OFF CACHE BOOL "" FORCE)
set(SDL_STATIC ON CACHE BOOL "" FORCE)
set(SDL_GPU_WEBGPU ON CACHE BOOL "" FORCE)
set(SDL_TESTS OFF CACHE BOOL "" FORCE)
add_subdirectory(${PEAK_SDL_SOURCE} sdl)
# Use the pinned current Dawn bindings, not the SDK's older bundled release.
foreach(prop COMPILE_OPTIONS INTERFACE_LINK_OPTIONS)
    get_target_property(opts SDL3-static ${prop})
    list(TRANSFORM opts REPLACE "--use-port=emdawnwebgpu:cpp_bindings=false" "--use-port=${PEAK_EMDAWN_PORT}:cpp_bindings=false")
    set_target_properties(SDL3-static PROPERTIES ${prop} "${opts}")
endforeach()
set(PEAK_CMR_PORT ${CMAKE_CURRENT_SOURCE_DIR})
add_subdirectory(${PEAK_CMR_SOURCE}/src game)
target_sources(opencmr2_platform PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src/browser.cpp)
set_target_properties(opencmr2 PROPERTIES SUFFIX ".js")
target_link_options(opencmr2 PRIVATE
    -O2 -g2 --emit-symbol-map -sASYNCIFY=1 -sASYNCIFY_STACK_SIZE=262144 -sALLOW_MEMORY_GROWTH=1
    -sINITIAL_MEMORY=134217728 -sMAXIMUM_MEMORY=2147483648 -sSTACK_SIZE=2097152
    -sASSERTIONS=1 -sFORCE_FILESYSTEM=1 -sEMULATE_FUNCTION_POINTER_CASTS=1 -sEXIT_RUNTIME=0
    -lidbfs.js "-sEXPORTED_RUNTIME_METHODS=FS,IDBFS,callMain" "-sEXPORTED_FUNCTIONS=_main,_malloc,_free")

# Runs the actual native packet receiver/decoder under Node, without game data.
add_executable(cmr2_net_regression EXCLUDE_FROM_ALL ../../tests/games/cmr2_net.cpp)
target_link_libraries(cmr2_net_regression PRIVATE opencmr2_platform)
target_link_options(cmr2_net_regression PRIVATE -sASYNCIFY=1 -sALLOW_MEMORY_GROWTH=1
    -sSTACK_SIZE=2097152 -sENVIRONMENT=node -sEXIT_RUNTIME=1)
