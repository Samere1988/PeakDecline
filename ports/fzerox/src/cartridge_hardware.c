/* US cartridge hardware boundary. No 64DD or controller Pak is attached. */
#include "global.h"
#include "PR/leo.h"

LEODiskID leoBootID;
long long gspL3DEX2_fifoTextStart[1];
long long gspF3DEX2_Rej_fifoTextStart[1];
static OSIntMask interruptMask = OS_IM_ALL;
OSIntMask osGetIntMask(void) { return interruptMask; }
OSIntMask osSetIntMask(OSIntMask mask) {
    OSIntMask old = interruptMask; interruptMask = mask; return old;
}
OSPiHandle* osLeoDiskInit(void) { return NULL; }
s32 LeoCACreateLeoManager(OSPri a, OSPri b, OSMesg* messages, s32 count) { return LEO_ERROR_DEVICE_COMMUNICATION_FAILURE; }
void LeoReset(void) {}
s32 LeoResetClear(void) { return LEO_ERROR_DEVICE_COMMUNICATION_FAILURE; }
s32 LeoByteToLBA(s32 start, u32 bytes, s32* blocks) { if (blocks) *blocks = 0; return LEO_ERROR_MEDIUM_NOT_PRESENT; }
s32 LeoLBAToByte(s32 start, u32 blocks, s32* bytes) { if (bytes) *bytes = 0; return LEO_ERROR_MEDIUM_NOT_PRESENT; }
static s32 no_disk(LEOCmd* command, OSMesgQueue* queue) {
    if (queue) osSendMesg(queue, (OSMesg)LEO_ERROR_MEDIUM_NOT_PRESENT, OS_MESG_NOBLOCK);
    return LEO_ERROR_MEDIUM_NOT_PRESENT;
}
s32 LeoSpdlMotor(LEOCmd* c, LEOSpdlMode mode, OSMesgQueue* q) { return no_disk(c, q); }
s32 LeoReadDiskID(LEOCmd* c, LEODiskID* id, OSMesgQueue* q) { return no_disk(c, q); }
s32 LeoReadWrite(LEOCmd* c, s32 dir, u32 lba, void* data, u32 count, OSMesgQueue* q) { return no_disk(c, q); }
int LeoGetAAdr2(u32 code, int* dx, int* dy, int* cy) { *dx = *dy = *cy = 0; return 0; }
u16 Mfs_GetFileIndex(u16 dir, char* name, char* ext) { return 0xFFFF; }
s32 Mfs_LoadFileInDir(u16 dir, char* name, char* ext, u8* data, s32 size) { return -1; }
