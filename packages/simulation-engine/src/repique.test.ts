// SPDX-License-Identifier: AGPL-3.0-only
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compareFollowUp} from './repique.js';
test('follow-up is reproducible and respects capacity',()=>{
 const reports=compareFollowUp(42,10000,15000,500);
 assert.deepEqual(reports,compareFollowUp(42,10000,15000,500));
 for(const r of reports){
  assert.ok(r.attempts<=15000);
  assert.ok(r.conversions<=r.contacted);
  assert.equal(r.contacted,10000);
  assert.equal(r.costCents,r.attempts*500);
  assert.equal(r.externalEffects,0);
  assert.equal(r.productionAuthorized,false);
 }
});
test('first pass precedes retries under scarce capacity',()=>{
 const reports=compareFollowUp(42,100,20,500);
 assert.equal(reports[0]!.contacted,20);
 assert.equal(reports[1]!.contacted,20);
 assert.equal(reports[0]!.conversions,reports[1]!.conversions);
});
test('invalid limits rejected',()=>{
 assert.throws(()=>compareFollowUp(42,100,0,500));
 assert.throws(()=>compareFollowUp(42,100,20,-1));
});
