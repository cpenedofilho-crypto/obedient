// SPDX-License-Identifier: AGPL-3.0-only
import {generate} from './index.js';
export function compareMarketing(seed:number,count:number,budgetCents:number){
 const scenarios=generate(seed,count);
 if(!Number.isSafeInteger(budgetCents)||budgetCents<1||budgetCents>100000000) throw new RangeError('invalid budget');
 // Two hypothetical channels with different cost and conversion assumptions.
 const costs=[200,500] as const;
 return (['balanced','low-cost-first'] as const).map(strategy=>{
  let spentCents=0,conversions=0,impressions=0;
  const byChannel=[0,0];
  for(const s of scenarios){
   const channel=strategy==='balanced'?s.id%2:0;
   const cost=costs[channel]!;
   if(spentCents+cost>budgetCents) continue;
   spentCents+=cost;impressions++;byChannel[channel]=byChannel[channel]!+cost;
   if(s.failures<(channel===0?1:2)) conversions++;
  }
  return Object.freeze({version:1,synthetic:true,seed,count,strategy,budgetCents,spentCents,remainingCents:budgetCents-spentCents,byChannel:Object.freeze(byChannel),impressions,conversions,cacCents:conversions?spentCents/conversions:null,externalEffects:0,productionAuthorized:false});
 });
}
