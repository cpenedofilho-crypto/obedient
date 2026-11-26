// SPDX-License-Identifier: AGPL-3.0-only
import {generate} from './index.js';
export function compareFollowUp(seed:number,count:number,capacity:number,costPerAttemptCents:number){
 const scenarios=generate(seed,count);
 if(!Number.isSafeInteger(capacity)||capacity<1||capacity>30000||!Number.isSafeInteger(costPerAttemptCents)||costPerAttemptCents<0||costPerAttemptCents>100000) throw new RangeError('invalid experiment limits');
 return (['single-attempt','bounded-retry'] as const).map(strategy=>{
  let attempts=0,conversions=0,contacted=0;
  // First pass gives each synthetic lead an opportunity before retries.
  const used=scenarios.map(()=>0);
  for(let round=0;round<(strategy==='single-attempt'?1:3);round++){
   for(const s of scenarios){
    if(attempts>=capacity) break;
    if(round>=s.budget||used[s.id]!==round||s.failures<round) continue;
    used[s.id]=round+1;attempts++;
    if(round===0) contacted++;
    if(s.failures===round) conversions++;
   }
  }
  return Object.freeze({version:1,synthetic:true,seed,count,strategy,capacity,attempts,contacted,conversions,uncontacted:count-contacted,conversionRate:conversions/count,costCents:attempts*costPerAttemptCents,externalEffects:0,productionAuthorized:false});
 });
}
