'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),zlib=require('node:zlib');
const {Codec}=require('../../ports/mk64/state_codec.js');
(async()=>{
 const responses=[],scope={Blob,DecompressionStream,Uint8Array,DataView,Uint32Array,ArrayBuffer,Number,Error};
 scope.self=scope;scope.postMessage=data=>responses.push(data);scope.importScripts=()=>{};scope.MK64StateCodec={Codec};
 vm.createContext(scope);vm.runInContext(fs.readFileSync('static/js/netplay/mk64_checkpoint_worker.js','utf8'),scope);
 async function send(type,sequence,base,data,bytes=data.length){await scope.onmessage({data:{type,sequence,base,bytes,payload:zlib.deflateSync(data)}});return responses.pop();}
 const initial=new Uint8Array(1025),changed=initial.slice();changed[512]=31;changed[1024]=9;
 assert.deepEqual((await send('baseline',0,null,initial)).state,initial);
 assert.deepEqual((await send('anchor',2,0,new Codec(initial).encode(changed))).state,changed);
 assert.match((await send('state',3,0,new Codec(initial).encode(initial))).error,/baseline mismatch/);
 assert.deepEqual((await send('state',4,2,new Codec(changed).encode(changed))).state,changed);
 assert.match((await send('state',5,2,new Codec(changed).encode(changed),1)).error,/Oversized/);
 console.log('PASS checkpoint worker: anchors, stale-base rejection, output bounds');
})().catch(e=>{console.error(e);process.exitCode=1;});
