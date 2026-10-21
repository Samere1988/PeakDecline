/* Stable, pointer-free diagnostics for the shared lockstep framework. */
#include "global.h"
#include "fzx_racer.h"
#include "fzx_game.h"
#include <emscripten/em_asm.h>

extern s32 gRandSeed1, gRandSeed2;
extern u32 gRandMask1, gRandMask2;
extern s32 gGameMode, gGameFrameCount, gNumPlayers, gTotalRacers;
extern Racer gRacers[];

static u32 hash_bytes(u32 hash, const void* data, size_t size) {
    const u8* bytes = data;
    for (size_t i = 0; i < size; ++i) hash = (hash ^ bytes[i]) * 16777619u;
    return hash;
}
#define HASH(value) hash = hash_bytes(hash, &(value), sizeof(value))
u32 web_state_hash(void) {
    u32 hash = 2166136261u;
    HASH(gGameMode); HASH(gGameFrameCount); HASH(gNumPlayers); HASH(gTotalRacers);
    HASH(gRandSeed1); HASH(gRandMask1); HASH(gRandSeed2); HASH(gRandMask2);
    EM_ASM({ window.fzeroState.racers = []; });
    for (int i = 0; i < gTotalRacers && i < 30; ++i) {
        const Racer* racer = &gRacers[i];
        HASH(racer->id); HASH(racer->stateFlags); HASH(racer->character);
        HASH(racer->segmentPositionInfo.pos); HASH(racer->segmentPositionInfo.segmentTValue);
        HASH(racer->velocity); HASH(racer->speed); HASH(racer->energy);
        HASH(racer->raceTime); HASH(racer->raceDistance); HASH(racer->lap);
        HASH(racer->position); HASH(racer->boostTimer); HASH(racer->attackState);
        if (i < gNumPlayers && i < 4) {
            EM_ASM({ window.fzeroState.racers.push({speed:$0, time:$1, lap:$2, x:$3, y:$4, z:$5}); },
                racer->speed, racer->raceTime, racer->lap,
                racer->segmentPositionInfo.pos.x, racer->segmentPositionInfo.pos.y, racer->segmentPositionInfo.pos.z);
        }
    }
    return hash;
}
