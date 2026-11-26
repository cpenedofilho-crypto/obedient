// SPDX-License-Identifier: AGPL-3.0-only
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compareRecovery} from './recupera.js';
test('recovery economics deterministic and bounded',()=>{
 const results=compareRecovery(42,10000);
 assert.deepEqual(results,compareRecovery(42,10000));
 for(const r of results){
  assert.ok(r.successes<=r.count);
  assert.ok(r.attempts<=3*r.count);
  assert.equal(r.recoveredCents,r.successes*250000);
  assert.equal(r.costCents,r.attempts*500);
  assert.equal(r.netCents,r.recoveredCents-r.costCents);
  assert.equal(r.productionAuthorized,false);
  assert.equal(r.externalEffects,0);
 }
});
test('invalid scenario count rejected',()=>assert.throws(()=>compareRecovery(42,10001)));
