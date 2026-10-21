const assert=require('node:assert/strict');
require('../../.tmp/marioparty2-port/fpu-test.js')().then(m=>{
 assert.equal(m._mp_test_fpu(),0);
 console.log('PASS: guest rounding modes, ties, invalid conversions and separate context state');
}).catch(e=>{console.error(e);process.exitCode=1;});
