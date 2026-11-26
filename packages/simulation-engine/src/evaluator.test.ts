// SPDX-License-Identifier: AGPL-3.0-only
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {evaluate} from './evaluator.js';
const m={successRate:1,utilization:1,fairness:1,cost:2,externalEffects:0,violations:0};
const l={maxCost:3,minSuccess:.8,minFairness:.8};
test('eligible only for review',()=>{const r=evaluate(m,l);assert.equal(r.score,1);assert.equal(r.eligibleForReview,true);assert.equal(r.productionAuthorized,false);});
test('safety cannot be compensated',()=>{for(const bad of [{externalEffects:1},{violations:1}]){const r=evaluate({...m,...bad},l);assert.equal(r.score,null);assert.deepEqual(r.reasons,['safety']);}});
test('all limits checked',()=>{assert.deepEqual(evaluate({...m,cost:4,successRate:.2,fairness:.2},l).reasons,['budget','success','fairness']);});
test('invalid metrics fail closed',()=>{assert.throws(()=>evaluate({...m,cost:NaN},l));assert.throws(()=>evaluate({...m,externalEffects:-1},l));assert.throws(()=>evaluate(m,{...l,minSuccess:2}));});
