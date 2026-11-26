// SPDX-License-Identifier: AGPL-3.0-only
import {simulate, type Policy} from './index.js';
import {proposeExperience} from './experience.js';
import type {Limits} from './evaluator.js';
export function runExperiment(seed:number,count:number,limits:Limits){
 const policies:Policy[]=['single-attempt','bounded-retry'];
 return policies.map(policy=>{
  const result=simulate(seed,count,policy);
  // Cost is synthetic attempt count; fairness and utilization are not measured in this experiment.
  return Object.freeze({result,experience:proposeExperience({experimentId:'retry-'+seed+'-'+count+'-'+policy,seed,strategy:policy,metrics:{successRate:result.successRate,cost:result.attempts,utilization:null,fairness:null,externalEffects:result.externalEffects,violations:0},limits}),unmeasuredMetrics:['utilization','fairness'] as const});
 });
}
