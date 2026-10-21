const assert=require('node:assert/strict');
(async()=>{
 const m=await require('../../.tmp/marioparty2-port/audio-test.js')();
 assert.equal(m._mp_test_audio(),1);
 console.log('PASS: native Wasm audio ADPCM decoding, sample byte order, pole-filter unity gain and saved history.');
})().catch(e=>{console.error(e);process.exitCode=1;});
