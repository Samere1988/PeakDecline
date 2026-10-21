/* Inflate and reconstruct checkpoints off the rendering thread. */
'use strict';
importScripts('mk64_state_codec.js');
let codec,anchor;
self.onmessage=async({data:packet})=>{
 try{
  if(!Number.isSafeInteger(packet.bytes)||packet.bytes<0||packet.bytes>32*1024*1024)throw Error('Invalid checkpoint size');
  const reader=new Blob([packet.payload]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
  const chunks=[];let size=0;
  for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;
   if(size>packet.bytes){await reader.cancel();throw Error('Oversized checkpoint');}chunks.push(value);}
  if(size!==packet.bytes)throw Error('Incomplete checkpoint');
  const packed=new Uint8Array(size);let offset=0;for(const chunk of chunks){packed.set(chunk,offset);offset+=chunk.length;}
  let state;
  if(packet.type==='baseline'){codec=new MK64StateCodec.Codec(packed);anchor=packet.sequence;state=packed;}
  else if(codec){
   if(packet.base!==anchor)throw Error('Checkpoint baseline mismatch');
   state=codec.decode(packed);
   if(packet.type==='anchor'){codec=new MK64StateCodec.Codec(state);anchor=packet.sequence;}
  }
  else throw Error('Missing checkpoint baseline');
  self.postMessage({sequence:packet.sequence,state},[state.buffer]);
 }catch(e){self.postMessage({sequence:packet.sequence,error:e.message});}
};
