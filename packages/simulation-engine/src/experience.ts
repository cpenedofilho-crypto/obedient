// SPDX-License-Identifier: AGPL-3.0-only
import {evaluate, type Metrics, type Limits} from './evaluator.js';
export function proposeExperience(input: Readonly<{experimentId:string; seed:number; strategy:string; metrics:Metrics; limits:Limits}>) {
 if(!/^[a-zA-Z0-9_-]{1,80}$/.test(input.experimentId)||!Number.isSafeInteger(input.seed)||input.seed<0||input.seed>0xffffffff||!['bounded-retry','single-attempt','cooperate','compete'].includes(input.strategy)) throw new RangeError('invalid provenance');
 const metrics=Object.freeze({...input.metrics});
 const limits=Object.freeze({...input.limits});
 const evaluation=evaluate(metrics,limits);
 return Object.freeze({schemaVersion:1,source:'synthetic' as const,experimentId:input.experimentId,seed:input.seed,strategy:input.strategy,metrics,limits,status:evaluation.eligibleForReview?'pending-review' as const:'rejected' as const,reasons:Object.freeze([...evaluation.reasons]),score:evaluation.score,verifiedProvenance:false as const,persistenceAuthorized:false as const,productionAuthorized:false as const});
}
