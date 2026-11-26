// SPDX-License-Identifier: AGPL-3.0-only
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compareOperations} from './ronda.js';
test('allocation conserves demand and capacity',()=>{
 const reports=compareOperations([8,2,5],10,30);
 assert.deepEqual(reports,compareOperations([8,2,5],10,30));
 for(const r of reports){
  assert.equal(r.total+r.unused,300);
  assert.equal(r.total+r.unserved,450);
  assert.ok(r.completionRate>=0&&r.completionRate<=1);
  assert.equal(r.externalEffects,0);
  assert.equal(r.productionAuthorized,false);
 }
});
test('invalid allocation rejected',()=>assert.throws(()=>compareOperations([8,0],10,30)));
