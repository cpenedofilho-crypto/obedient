// SPDX-License-Identifier: AGPL-3.0-only
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createEvidence,verifyEvidence} from './verification.js';
const limits={maxCost:30000,minSuccess:0,minFairness:0};
test('synthetic evidence reproduces without granting authority',()=>{
 const e=createEvidence(42,10000,limits);
 const r=verifyEvidence(e);
 assert.equal(r.reproduced,true);assert.equal(r.scoreUsable,false);assert.equal(r.persistenceAuthorized,false);assert.equal(r.productionAuthorized,false);
});
test('altered digest or seed rejected',()=>{
 const e=createEvidence(42,100,limits);
 assert.equal(verifyEvidence({...e,sha256:'0'.repeat(64)}).reproduced,false);
 assert.equal(verifyEvidence({...e,seed:43}).reproduced,false);
});
test('altered report rejected even with original digest',()=>{
 const e=createEvidence(42,100,limits);
 assert.equal(verifyEvidence({...e,report:[]}).reproduced,false);
});
test('invalid evidence fails closed',()=>{
 const e=createEvidence(42,100,limits);
 assert.equal(verifyEvidence({...e,count:10001}).reproduced,false);
});
