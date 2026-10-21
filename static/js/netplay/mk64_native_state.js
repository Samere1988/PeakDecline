/* Fixed-build native state adapter, shared by authority and browser candidates. */
(function(root,factory){const api=factory();if(typeof module==='object')module.exports=api;else root.MK64Native=api;})(typeof globalThis==='object'?globalThis:this,()=>{
 'use strict';
 function attach(module,manifest,players=2){
  const regions=[];
  for(const region of manifest.regions){
   const previous=regions.at(-1);
   if(previous&&previous.address+previous.size===region.address)previous.size+=region.size;
   else regions.push({address:region.address,size:region.size});
  }
  const bytes=regions.reduce((n,r)=>n+r.size,0),frame=()=>module._web_frame();
  const timer=manifest.regions.find(r=>r.symbol==='gGlobalTimer');
  if(!timer||timer.size!==4)throw new Error('Missing native frame counter');
  let frameOffset=0;
  for(const r of regions){
   if(timer.address>=r.address&&timer.address+4<=r.address+r.size){frameOffset+=timer.address-r.address;break;}
   frameOffset+=r.size;
  }
  const hash=()=>module._web_current_hash()>>>0;
  function snapshot(){
   const data=new Uint8Array(bytes);let offset=0;
   for(const r of regions){data.set(module.HEAPU8.subarray(r.address,r.address+r.size),offset);offset+=r.size;}
   return {schema:1,build:manifest.wasm,frame:frame(),data};
  }
  function restore(state){
   if(state.schema!==1||state.build!==manifest.wasm||!(state.data instanceof Uint8Array)||state.data.length!==bytes||
      !Number.isSafeInteger(state.frame)||state.frame<1)throw new Error('Invalid native snapshot');
   if(new DataView(state.data.buffer,state.data.byteOffset,state.data.byteLength).getUint32(frameOffset,true)!==state.frame)
    throw new Error('Snapshot frame mismatch');
   let offset=0;
   for(const r of regions){module.HEAPU8.set(state.data.subarray(offset,offset+r.size),r.address);offset+=r.size;}
   if(frame()!==state.frame)throw new Error('Snapshot frame mismatch');
  }
  function step(inputs,replaying=true){
   if(!Array.isArray(inputs)||inputs.length!==players||inputs.some(p=>!p||!Number.isInteger(p.buttons)||p.buttons<0||p.buttons>65535||
      !Number.isInteger(p.x)||Math.abs(p.x)>80||!Number.isInteger(p.y)||Math.abs(p.y)>80))throw new Error('Invalid frame inputs');
   inputs.forEach((p,i)=>module._web_set_pad(i,p.buttons,p.x,p.y));
   const before=frame();module._web_step(replaying?1:0);
   if(frame()!==before+1)throw new Error('Native simulation did not advance exactly one frame');return hash();
  }
  return {module,manifest,regions,bytes,frame,hash,snapshot,restore,step};
 }
 return {attach};
});
