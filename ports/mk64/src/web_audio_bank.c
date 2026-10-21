/* Convert the N64's big-endian audio-bank records before the native pointer
 * patcher in audio/load.c reads them on little-endian WebAssembly. */
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

static uint32_t word(unsigned char *data, unsigned size, unsigned at) {
    uint32_t value = 0;
    if (at > size || size - at < 4) return 0;
    memcpy(&value, data + at, 4);
    value = __builtin_bswap32(value);
    memcpy(data + at, &value, 4);
    return value;
}
static int valid(unsigned size, unsigned at, unsigned bytes) {
    return at && at <= size && bytes <= size - at;
}
static void sample(unsigned char *data, unsigned size, unsigned at, unsigned char *seen) {
    if (!valid(size, at, 20) || seen[at]) return;
    seen[at] = 1;
    word(data, size, at + 4); /* Raw sample-table offset. */
    unsigned loop = word(data, size, at + 8);
    unsigned book = word(data, size, at + 12);
    word(data, size, at + 16);
    if (valid(size, loop, 16) && !seen[loop]) {
        seen[loop] = 1;
        unsigned count = word(data, size, loop + 8);
        word(data, size, loop); word(data, size, loop + 4); word(data, size, loop + 12);
        if (count && valid(size, loop, 48))
            for (unsigned i = 0; i < 16; ++i) {
                uint16_t value;
                memcpy(&value, data + loop + 16 + i * 2, 2);
                value = __builtin_bswap16(value);
                memcpy(data + loop + 16 + i * 2, &value, 2);
            }
    }
    if (valid(size, book, 8) && !seen[book]) {
        seen[book] = 1;
        unsigned order = word(data, size, book), predictors = word(data, size, book + 4);
        unsigned count = order * predictors * 8;
        if (order <= 8 && predictors <= 16 && valid(size, book, 8 + count * 2))
            for (unsigned i = 0; i < count; ++i) {
                uint16_t value;
                memcpy(&value, data + book + 8 + i * 2, 2);
                value = __builtin_bswap16(value);
                memcpy(data + book + 8 + i * 2, &value, 2);
            }
    }
}
static void sound(unsigned char *data, unsigned size, unsigned at, unsigned char *seen) {
    if (!valid(size, at, 8)) return;
    unsigned location = word(data, size, at);
    word(data, size, at + 4); /* IEEE-754 tuning value. */
    sample(data, size, location, seen);
}
void web_audio_bank_endian(void *bank, unsigned size, unsigned instruments, unsigned drums) {
    unsigned char *data = bank;
    unsigned char *seen = calloc(size ? size : 1, 1);
    if (!seen || size < 4) { free(seen); return; }
    unsigned drum_table = word(data, size, 0);
    for (unsigned i = 0; i < instruments && i < 256 && 4 + i * 4 + 4 <= size; ++i) {
        unsigned at = word(data, size, 4 + i * 4);
        if (!valid(size, at, 32) || seen[at]) continue;
        seen[at] = 1;
        word(data, size, at + 4); /* Envelopes remain big-endian byte streams. */
        sound(data, size, at + 8, seen);
        sound(data, size, at + 16, seen);
        sound(data, size, at + 24, seen);
    }
    if (valid(size, drum_table, drums * 4)) {
        for (unsigned i = 0; i < drums && i < 256; ++i) {
            unsigned at = word(data, size, drum_table + i * 4);
            if (!valid(size, at, 16) || seen[at]) continue;
            seen[at] = 1;
            sound(data, size, at + 4, seen);
            word(data, size, at + 12);
        }
    }
    free(seen);
}
