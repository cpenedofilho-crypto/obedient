// SPDX-License-Identifier: AGPL-3.0-only
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runAppliedSuite} from './applied.js';
test('applied suite reproduces all five domain reports',()=>{
 const r=runAppliedSuite(42,10000);
 assert.deepEqual(r,runAppliedSuite(42,10000));
 for(const reports of [r.recovery,r.operations,r.followUp,r.marketing,r.flow]){
  assert.equal(reports.length,2);
  for(const report of reports){assert.equal(report.externalEffects,0);assert.equal(report.productionAuthorized,false);}
 }
 assert.equal(r.operationsRounds,1000);
 assert.equal(r.memoryWriteAllowed,false);
 console.log('OSIL_APPLIED_REPORT',JSON.stringify(r));
});
test('applied suite rejects invalid count',()=>assert.throws(()=>runAppliedSuite(42,10001)));
