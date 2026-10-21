#ifndef WEB_TEXTURE_HASH_H
#define WEB_TEXTURE_HASH_H
#include <stdint.h>
#include <stddef.h>

/* Dimension + CRC32 + Adler32 keys are shared with prepare_hd.py. Both
 * checksums cover the complete decoded RGBA image, including palette alpha. */
static inline void web_texture_hash(const uint8_t *bytes, size_t length,
                                    uint32_t *crc_out, uint32_t *adler_out) {
    static uint32_t table[256];
    static int initialized;
    if (!initialized) {
        for (uint32_t i = 0; i < 256; ++i) {
            uint32_t value = i;
            for (int bit = 0; bit < 8; ++bit)
                value = (value >> 1) ^ (0xedb88320U & (0U - (value & 1U)));
            table[i] = value;
        }
        initialized = 1;
    }
    uint32_t crc = 0xffffffffU, a = 1, b = 0;
    while (length) {
        size_t count = length > 5552 ? 5552 : length;
        length -= count;
        while (count--) {
            uint8_t byte = *bytes++;
            crc = table[(crc ^ byte) & 255] ^ (crc >> 8);
            a += byte;
            b += a;
        }
        a %= 65521U;
        b %= 65521U;
    }
    *crc_out = crc ^ 0xffffffffU;
    *adler_out = (b << 16) | a;
}
#endif
