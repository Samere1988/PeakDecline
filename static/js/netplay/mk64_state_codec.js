/* Self-contained sparse checkpoints relative to one immutable authority baseline. */
(function(root,factory){const api=factory();if(typeof module==='object')module.exports=api;else root.MK64StateCodec=api;})(typeof globalThis==='object'?globalThis:this,()=>{
 'use strict';const BLOCK=256;
 class Codec {
  constructor(base){this.base=new Uint8Array(base);}
  encode(data){
   if(data.length!==this.base.length)throw Error('Snapshot size mismatch');
   const a=new Uint32Array(data.buffer,data.byteOffset,Math.floor(data.length/4));
   const b=new Uint32Array(this.base.buffer,0,a.length),dirty=[];
   for(let start=0;start<data.length;start+=BLOCK){
    const end=Math.min(start+BLOCK,data.length);let differs=false;
    for(let j=start>>>2;j<end>>>2;j++)if(a[j]!==b[j]){differs=true;break;}
    for(let j=(end>>>2)*4;!differs&&j<end;j++)if(data[j]!==this.base[j])differs=true;
    if(differs)dirty.push(start);
   }
   const output=new Uint8Array(8+dirty.reduce((n,start)=>n+4+Math.min(BLOCK,data.length-start),0));
   const view=new DataView(output.buffer);view.setUint32(0,data.length,true);view.setUint32(4,dirty.length,true);
   let at=8;for(const start of dirty){view.setUint32(at,start,true);at+=4;const part=data.subarray(start,Math.min(start+BLOCK,data.length));output.set(part,at);at+=part.length;}
   return output;
  }
  decode(packet){
   if(!(packet instanceof Uint8Array)||packet.length<8)throw Error('Invalid checkpoint');
   const view=new DataView(packet.buffer,packet.byteOffset,packet.byteLength);
   if(view.getUint32(0,true)!==this.base.length)throw Error('Checkpoint baseline mismatch');
   const count=view.getUint32(4,true);if(count>Math.ceil(this.base.length/BLOCK))throw Error('Invalid block count');
   const data=this.base.slice();let at=8,previous=-1;
   for(let i=0;i<count;i++){
    if(at+4>packet.length)throw Error('Truncated checkpoint');const start=view.getUint32(at,true);at+=4;
    const size=Math.min(BLOCK,data.length-start);
    if(start%BLOCK||start<=previous||size<=0||at+size>packet.length)throw Error('Invalid block');
    data.set(packet.subarray(at,at+size),start);at+=size;previous=start;
   }
   if(at!==packet.length)throw Error('Trailing checkpoint data');return data;
  }
 }
 return {Codec};
});
