/* PeakDecline browser admission wrapper around recomp-net's unchanged rings.
 * Transport, delayed sampling and session lifecycle live in the browser SDK.
 * No UDP, ICE, rollback or native rnet_session API is compiled into this target.
 */
#include <string.h>
#include <emscripten.h>
#include "input/rnet_rings.h"

static RNetInputRing rings[RNET_MAX_SLOTS];
static unsigned players, current;

EMSCRIPTEN_KEEPALIVE int pn_reset(unsigned count) {
    if (count < 1 || count > RNET_MAX_SLOTS) return 0;
    players = count;
    current = 1;
    memset(rings, 0, sizeof(rings));
    return 1;
}

EMSCRIPTEN_KEEPALIVE int pn_store(unsigned slot, unsigned frame, unsigned value) {
    if (slot >= players || frame < current || frame - current >= RNET_HISTORY_LENGTH) return 0;
    RNetInputSample previous, sample = {0};
    sample.tick = frame;
    sample.size = 4;
    sample.valid = 1;
    for (unsigned i = 0; i < 4; ++i) sample.bytes[i] = (value >> (8 * i)) & 255;
    if (rnet_ring_get(&rings[slot], frame, &previous))
        return memcmp(previous.bytes, sample.bytes, 4) == 0;
    rnet_ring_store(&rings[slot], &sample);
    return 1;
}

EMSCRIPTEN_KEEPALIVE int pn_ready(unsigned frame) {
    RNetInputSample sample;
    if (frame < current || frame - current > 1) return 0;
    for (unsigned i = 0; i < players; ++i)
        if (!rnet_ring_get(&rings[i], frame, &sample)) return 0;
    current = frame;
    return 1;
}

EMSCRIPTEN_KEEPALIVE unsigned pn_input(unsigned slot, unsigned frame) {
    RNetInputSample sample;
    if (slot >= players || !rnet_ring_get(&rings[slot], frame, &sample)) return 0;
    return (unsigned)sample.bytes[0] | ((unsigned)sample.bytes[1] << 8) |
           ((unsigned)sample.bytes[2] << 16) | ((unsigned)sample.bytes[3] << 24);
}

