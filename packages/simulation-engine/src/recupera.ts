// SPDX-License-Identifier: AGPL-3.0-only
import {generate} from './index.js';
// Hypothetical economics only; no debtor attributes or external actions.
export function compareRecovery(seed:number,count:number){
 const scenarios=generate(seed,count);
 return (['single-attempt','bounded-retry'] as const).map(strategy=>{
  let recoveredCents=0,costCents=0,successes=0,attempts=0;
  for(const s of scenarios){
   const limit=strategy==='single-attempt'?1:Math.min(3,s.budget);
   const used=Math.min(limit,s.failures+1);
   attempts+=used;costCents+=used*500;
   if(s.failures<limit){successes++;recoveredCents+=250000;}
  }
  return Object.freeze({version:1,synthetic:true,seed,count,strategy,successes,attempts,recoveredCents,costCents,netCents:recoveredCents-costCents,externalEffects:0,productionAuthorized:false});
 });
}
