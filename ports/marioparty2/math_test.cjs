const assert=require('node:assert/strict');
require('../../.tmp/marioparty2-port/math-test.js')().then(m=>{
 assert.equal(m._mp_test_math(),0);
 console.log('PASS: translated squared-length entry and vector length, including train direction, axis and zero vectors');
}).catch(e=>{console.error(e);process.exitCode=1;});
