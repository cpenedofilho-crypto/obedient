// SPDX-License-Identifier: AGPL-3.0-only
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compareFlow} from './lean.js';
test('flow is reproducible and preserves work',()=>{
 const r=compareFlow(42,10000,[20,40,30]);
 assert.deepEqual(r,compareFlow(42,10000,[20,40,30]));
 assert.equal(r[0]!.workSeconds,r[1]!.workSeconds);
 assert.ok(r[1]!.elapsedSeconds<=r[0]!.elapsedSeconds);
 for(const x of r){assert.ok(x.utilization>0&&x.utilization<=1);assert.equal(x.externalEffects,0);assert.equal(x.productionAuthorized,false);}
});
test('one unit has identical elapsed time',()=>{const r=compareFlow(42,1,[20,40]);assert.equal(r[0]!.elapsedSeconds,r[1]!.elapsedSeconds);});
test('invalid stages rejected',()=>assert.throws(()=>compareFlow(42,100,[0,40])));
