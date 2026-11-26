// SPDX-License-Identifier: AGPL-3.0-only
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createEvidence} from './verification.js';
import {reviewCandidate} from './learning-gateway.js';
test('reproduced evidence is review only',()=>{
 const r=reviewCandidate(createEvidence(42,100,{maxCost:300,minSuccess:0,minFairness:0}));
 assert.equal(r.status,'review-only');
 assert.equal(r.memoryWriteAllowed,false);
 assert.equal(r.missionExecutionAllowed,false);
 assert.equal(r.permissionChangeAllowed,false);
 assert.equal(r.scoreUsable,false);
});
test('tampered evidence rejected',()=>{
 const e=createEvidence(42,100,{maxCost:300,minSuccess:0,minFairness:0});
 assert.equal(reviewCandidate({...e,sha256:'bad'}).status,'rejected');
});
