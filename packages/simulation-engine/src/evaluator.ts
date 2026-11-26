// SPDX-License-Identifier: AGPL-3.0-only
export type Metrics = Readonly<{successRate:number; utilization:number; fairness:number; cost:number; externalEffects:number; violations:number}>;
export type Limits = Readonly<{maxCost:number; minSuccess:number; minFairness:number}>;
function unit(n:number){return Number.isFinite(n)&&n>=0&&n<=1;}
function nonnegative(n:number){return Number.isFinite(n)&&n>=0;}
export function evaluate(m:Metrics,l:Limits){
 if(!unit(m.successRate)||!unit(m.utilization)||!unit(m.fairness)||!nonnegative(m.cost)||!Number.isSafeInteger(m.externalEffects)||m.externalEffects<0||!Number.isSafeInteger(m.violations)||m.violations<0||!nonnegative(l.maxCost)||!unit(l.minSuccess)||!unit(l.minFairness)) throw new RangeError('invalid metrics or limits');
 const reasons:string[]=[];
 if(m.externalEffects!==0||m.violations!==0) reasons.push('safety');
 if(m.cost>l.maxCost) reasons.push('budget');
 if(m.successRate<l.minSuccess) reasons.push('success');
 if(m.fairness<l.minFairness) reasons.push('fairness');
 return {synthetic:true as const,eligibleForReview:reasons.length===0,reasons,score:reasons.length?null:0.5*m.successRate+0.25*m.utilization+0.25*m.fairness,productionAuthorized:false as const};
}
