// SPDX-License-Identifier: AGPL-3.0-only
import {simulateAgents} from './multi-agent.js';
export function compareOperations(demands:readonly number[],capacity:number,rounds:number){
 return (['cooperate','compete'] as const).map(strategy=>{
  const result=simulateAgents(demands.map(demand=>({strategy,demand})),capacity,rounds);
  const requested=demands.reduce((a,b)=>a+b,0)*rounds;
  return Object.freeze({...result,served:Object.freeze(result.served),strategy,requested,unserved:requested-result.total,completionRate:result.total/requested,productionAuthorized:false as const});
 });
}
