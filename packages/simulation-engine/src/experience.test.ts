// SPDX-License-Identifier: AGPL-3.0-only
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {proposeExperience} from './experience.js';
const input={experimentId:'run-42',seed:42,strategy:'bounded-retry',metrics:{successRate:1,utilization:1,fairness:1,cost:1,externalEffects:0,violations:0},limits:{maxCost:2,minSuccess:.8,minFairness:.8}};
test('synthetic experience remains unverified and pending',()=>{const r=proposeExperience(input);assert.equal(r.status,'pending-review');assert.equal(r.source,'synthetic');assert.equal(r.persistenceAuthorized,false);assert.equal(r.productionAuthorized,false);assert.equal(r.verifiedProvenance,false);});
test('unsafe experience rejected',()=>{assert.equal(proposeExperience({...input,metrics:{...input.metrics,violations:1}}).status,'rejected');});
test('invalid provenance rejected',()=>{assert.throws(()=>proposeExperience({...input,experimentId:'../bad'}));assert.throws(()=>proposeExperience({...input,seed:-1}));});
test('snapshot isolated from input changes',()=>{const metrics={...input.metrics};const r=proposeExperience({...input,metrics});metrics.cost=99;assert.equal(r.metrics.cost,1);});
