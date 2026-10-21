#include <stdint.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>

struct DataSwap { unsigned offset, count, stride, components, width; };
static const struct DataSwap common_swaps[] = {
#include "web_common_endian.inc.h"
};

/* Common graphics commands, vertices, matrices and float tables are serialized
 * big-endian. Texture bytes must stay in their original format for the renderer. */
void web_fix_common(void *data, size_t size) {
    for (size_t i=0;i<sizeof(common_swaps)/sizeof(common_swaps[0]);++i) {
        const struct DataSwap *swap=&common_swaps[i];
        if (swap->offset + swap->count * swap->stride > size) abort();
        for(unsigned item=0;item<swap->count;++item) {
            unsigned char *p=(unsigned char *)data+swap->offset+item*swap->stride;
            for(unsigned component=0;component<swap->components;++component,p+=swap->width) {
                if(swap->width==2){uint16_t value;memcpy(&value,p,2);value=__builtin_bswap16(value);memcpy(p,&value,2);}
                else {uint32_t value;memcpy(&value,p,4);value=__builtin_bswap32(value);memcpy(p,&value,4);}
            }
        }
    }
}
