// SPDX-License-Identifier: AGPL-3.0-only
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {simulateAgents} from './multi-agent.js';
test('equal cooperative allocation',()=>{
 const a=simulateAgents([{strategy:'cooperate',demand:10},{strategy:'cooperate',demand:10}],10,10);
 assert.deepEqual(a.served,[50,50]);assert.equal(a.fairness,1);assert.equal(a.unused,0);
});
test('rotation and conservation',()=>{
 const a=simulateAgents([{strategy:'compete',demand:10},{strategy:'compete',demand:10}],10,2);
 assert.deepEqual(a.served,[10,10]);assert.equal(a.total+a.unused,20);assert.equal(a.externalEffects,0);
});
test('unused capacity and bounds',()=>{
 const agents=[{strategy:'cooperate' as const,demand:1},{strategy:'cooperate' as const,demand:1}];
 assert.equal(simulateAgents(agents,10,2).unused,16);
 assert.throws(()=>simulateAgents(agents,10,1001));
 assert.throws(()=>simulateAgents(agents,0,1));
});
