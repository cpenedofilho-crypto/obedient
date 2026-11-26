// SPDX-License-Identifier: AGPL-3.0-only
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compareMarketing} from './growth.js';
test('marketing allocation is reproducible and budget bounded',()=>{
 const reports=compareMarketing(42,10000,400000);
 assert.deepEqual(reports,compareMarketing(42,10000,400000));
 for(const r of reports){
  assert.equal(r.spentCents+r.remainingCents,r.budgetCents);
  assert.equal(r.byChannel.reduce((a,b)=>a+b,0),r.spentCents);
  assert.ok(r.conversions<=r.impressions&&r.impressions<=r.count);
  assert.equal(r.productionAuthorized,false);
  assert.equal(r.externalEffects,0);
 }
});
test('no conversions yields unknown acquisition cost',()=>{
 for(const r of compareMarketing(42,100,1)) assert.equal(r.cacCents,null);
});
test('invalid budget rejected',()=>assert.throws(()=>compareMarketing(42,100,-1)));
