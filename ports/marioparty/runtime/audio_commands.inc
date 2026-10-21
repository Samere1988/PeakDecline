/* ABI1 command adapter. The mixer's sample words are native-endian; byte
 * streams and guest state buffers are converted at the RDRAM/DMEM boundary. */
#include <emscripten/emscripten.h>
#include <stdlib.h>
#include <stdio.h>
static uint32_t audio_segments[16];
static uint8_t *audio_ram;
static int16_t loop_state[16];
static unsigned audio_tasks;
static void audio_fail(const char *message){EM_ASM({throw new Error(UTF8ToString($0));},message);abort();}
static uint32_t audio_address(uint32_t address,unsigned size){
    if(address>>24<16)address=audio_segments[address>>24]+(address&0xffffff);
    address&=0x1fffffff;
    if(address>0x800000||size>0x800000-address)audio_fail("Audio RDRAM bounds");
    return address;
}
static void dmem(unsigned offset,unsigned size){if(offset>sizeof(rspa.buf)||size>sizeof(rspa.buf)-offset)audio_fail("Audio DMEM bounds");}
static void load_state(uint32_t a,int16_t *state,unsigned count){a=audio_address(a,count*2);for(unsigned i=0;i<count;i++)state[i]=*(int16_t *)(audio_ram+((a+i*2)^2));}
static void save_state(uint32_t a,int16_t *state,unsigned count){a=audio_address(a,count*2);for(unsigned i=0;i<count;i++)*(int16_t *)(audio_ram+((a+i*2)^2))=state[i];}
/* ABI1's pole-filter recurrence over eight-sample blocks. Coefficients are
 * Q14, with two carried output samples and a triangular input convolution. */
static void pole_filter(unsigned flags,unsigned gain,uint32_t saved){
    unsigned bytes=ROUND_UP_16(rspa.nbytes);if(!bytes)return;
    dmem(rspa.in,bytes);dmem(rspa.out,bytes);
    int16_t history[4]={0},basis[8],scaled[8];
    if(!(flags&A_INIT))load_state(saved,history,4);
    for(unsigned k=0;k<8;k++){
        basis[k]=rspa.adpcm_table[0][1][k];
        scaled[k]=(int16_t)(((int32_t)basis[k]*gain)>>14);
        rspa.adpcm_table[0][1][k]=scaled[k];
    }
    for(unsigned start=0;start<bytes/2;start+=8){
        int16_t inputs[8],outputs[8];
        memcpy(inputs,&rspa.buf.as_s16[rspa.in/2+start],sizeof(inputs));
        for(unsigned sample=0;sample<8;sample++){
            int64_t sum=(int64_t)inputs[sample]*gain;
            sum+=(int32_t)rspa.adpcm_table[0][0][sample]*history[2]+(int32_t)basis[sample]*history[3];
            for(unsigned k=0;k<sample;k++)sum+=(int32_t)inputs[k]*scaled[sample-k-1];
            outputs[sample]=clamp16(((int32_t)(uint32_t)sum)>>14);
        }
        memcpy(&rspa.buf.as_s16[rspa.out/2+start],outputs,sizeof(outputs));
        memcpy(history,outputs+4,sizeof(history));
    }
    save_state(saved,history,4);
}
void mp_audio_render(uint8_t *ram,uint32_t commands,uint32_t size){
    audio_ram=ram;commands=audio_address(commands,size);if(size%8)audio_fail("Audio command size");
    for(unsigned pos=0;pos<size;pos+=8){
        uint32_t w0=*(uint32_t *)(ram+commands+pos),w1=*(uint32_t *)(ram+commands+pos+4);
        unsigned op=w0>>24,flags=(w0>>16)&255;uint32_t a;int16_t state[256];
        switch(op){
        case 0:break;
        case 1:
            dmem(rspa.out,ROUND_UP_32(rspa.nbytes)+32);dmem(rspa.in,(ROUND_UP_32(rspa.nbytes)/32)*9);
            load_state(w1,state,16);aADPCMdecImpl(flags,state);save_state(w1,state,16);break;
        case 2:dmem(w0&0xffff,ROUND_UP_16(w1));aClearBufferImpl(w0&0xffff,w1);break;
        case 3:
            dmem(rspa.in,ROUND_UP_16(rspa.nbytes));dmem(rspa.out,ROUND_UP_16(rspa.nbytes));
            dmem(rspa.dry_right,ROUND_UP_16(rspa.nbytes));dmem(rspa.wet_left,ROUND_UP_16(rspa.nbytes));dmem(rspa.wet_right,ROUND_UP_16(rspa.nbytes));
            load_state(w1,state,40);aEnvMixerImpl(flags,state);save_state(w1,state,40);break;
        case 4:
            a=audio_address(w1,ROUND_UP_8(rspa.nbytes));dmem(rspa.in,ROUND_UP_8(rspa.nbytes));
            for(unsigned i=0;i<ROUND_UP_8(rspa.nbytes);i++)rspa.buf.as_u8[(rspa.in+i)^1]=ram[(a+i)^3];break;
        case 5:
            if(rspa.in<8)audio_fail("Audio resample history bounds");
            dmem(rspa.out,ROUND_UP_16(rspa.nbytes));load_state(w1,state,16);aResampleImpl(flags,w0,state);save_state(w1,state,16);break;
        case 6:
            a=audio_address(w1,ROUND_UP_8(rspa.nbytes));dmem(rspa.out,ROUND_UP_8(rspa.nbytes));
            for(unsigned i=0;i<ROUND_UP_8(rspa.nbytes);i++)ram[(a+i)^3]=rspa.buf.as_u8[(rspa.out+i)^1];break;
        case 7:audio_segments[(w1>>24)&15]=w1&0xffffff;break;
        case 8:aSetBufferImpl(flags,w0,w1>>16,w1);break;
        case 9:aSetVolumeImpl(flags,w0,w1>>16,w1);break;
        case 10:{
            uint8_t temp[2512];unsigned src=w0&0xffff,dst=w1>>16,n=ROUND_UP_16(w1&0xffff);
            dmem(src,n);dmem(dst,n);for(unsigned i=0;i<n;i++)temp[i]=rspa.buf.as_u8[(src+i)^1];
            for(unsigned i=0;i<n;i++)rspa.buf.as_u8[(dst+i)^1]=temp[i];break;}
        case 11:
            if((w0&0xffff)>sizeof(rspa.adpcm_table))audio_fail("Audio predictor table size");
            load_state(w1,state,(w0&0xffff)/2);aLoadADPCMImpl(w0&0xffff,state);break;
        case 12:dmem(w1>>16,ROUND_UP_32(rspa.nbytes));dmem(w1&0xffff,ROUND_UP_32(rspa.nbytes));aMixImpl(w0,w1>>16,w1);break;
        case 13:dmem(w1>>16,ROUND_UP_16(rspa.nbytes));dmem(w1&0xffff,ROUND_UP_16(rspa.nbytes));dmem(rspa.out,ROUND_UP_16(rspa.nbytes)*2);aInterleaveImpl(w1>>16,w1);break;
        case 14:pole_filter(flags,w0&0xffff,w1);break;
        case 15:load_state(w1,loop_state,16);aSetLoopImpl((ADPCM_STATE *)loop_state);break;
        default:{char message[128];snprintf(message,sizeof(message),"Mario Party audio opcode %u not implemented (words %08x %08x, size %u)",op,w0,w1,size);audio_fail(message);}
        }
    }
    ++audio_tasks;
}
EMSCRIPTEN_KEEPALIVE unsigned mp_audio_tasks(void){return audio_tasks;}
