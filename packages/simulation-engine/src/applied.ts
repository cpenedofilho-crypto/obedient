// SPDX-License-Identifier: AGPL-3.0-only
import {compareRecovery} from './recupera.js';
import {compareOperations} from './ronda.js';
import {compareFollowUp} from './repique.js';
import {compareMarketing} from './growth.js';
import {compareFlow} from './lean.js';
export function runAppliedSuite(seed:number,count:number){
 const recovery=compareRecovery(seed,count);
 const operations=compareOperations([8,2,5],10,Math.min(count,1000));
 const followUp=compareFollowUp(seed,count,count*2,500);
 const marketing=compareMarketing(seed,count,400000);
 const flow=compareFlow(seed,count,[20,40,30]);
 return Object.freeze({version:1,synthetic:true,seed,count,operationsRounds:Math.min(count,1000),recovery,operations,followUp,marketing,flow,externalEffects:0,productionAuthorized:false,memoryWriteAllowed:false});
}
