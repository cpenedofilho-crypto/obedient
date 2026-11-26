// SPDX-License-Identifier: AGPL-3.0-only
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {analyzeGame} from './game-theory.js';
test('prisoners dilemma',()=>{
 const r=analyzeGame([[[3,3],[0,5]],[[5,0],[1,1]]]);
 assert.deepEqual(r.nash.map(x=>[x.row,x.col]),[[1,1]]);
 assert.equal(r.pareto.length,3);
});
test('matching pennies has no pure Nash',()=>{
 assert.equal(analyzeGame([[[1,-1],[-1,1]],[[-1,1],[1,-1]]]).nash.length,0);
});
test('ties are not strict dominance',()=>{
 const r=analyzeGame([[[1,1],[1,1]]]);
 assert.equal(r.nash.length,2);assert.equal(r.pareto.length,2);
});
test('invalid matrix rejected',()=>{
 assert.throws(()=>analyzeGame([]));
 assert.throws(()=>analyzeGame([[[NaN,1]]]));
 assert.throws(()=>analyzeGame([[[1,1]],[]]));
});
