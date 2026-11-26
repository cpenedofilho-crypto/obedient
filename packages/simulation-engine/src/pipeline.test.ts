// SPDX-License-Identifier: AGPL-3.0-only
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runExperiment} from './pipeline.js';
test('pipeline reproducible and never authorizes production',()=>{
 const limits={maxCost:30000,minSuccess:0,minFairness:0};
 const a=runExperiment(42,10000,limits);
 assert.deepEqual(a,runExperiment(42,10000,limits));
 assert.equal(a.length,2);
 for(const x of a){assert.equal(x.result.count,10000);assert.equal(x.experience.productionAuthorized,false);assert.equal(x.experience.persistenceAuthorized,false);assert.equal(x.experience.metrics.cost,x.result.attempts);}
 console.log('OSIL_RETRY_REPORT',JSON.stringify(a));
});
test('pipeline rejects insufficient budget',()=>{
 for(const x of runExperiment(42,100,{maxCost:0,minSuccess:0,minFairness:0})) assert.equal(x.experience.status,'rejected');
});
