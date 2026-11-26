// SPDX-License-Identifier: AGPL-3.0-only
import {createHash} from 'node:crypto';
import {runExperiment} from './pipeline.js';
import type {Limits} from './evaluator.js';
type Report = ReturnType<typeof runExperiment>;
function digest(report:Report){return createHash('sha256').update(JSON.stringify(report)).digest('hex');}
export function createEvidence(seed:number,count:number,limits:Limits){
 const report=runExperiment(seed,count,limits);
 return {version:1 as const,seed,count,limits:{...limits},report,sha256:digest(report)};
}
export function verifyEvidence(evidence:ReturnType<typeof createEvidence>){
 try {
  const expected=createEvidence(evidence.seed,evidence.count,evidence.limits);
  const reproduced=evidence.version===1 && digest(evidence.report)===evidence.sha256 && expected.sha256===evidence.sha256;
  return {reproduced,source:'synthetic' as const,scoreUsable:false as const,persistenceAuthorized:false as const,productionAuthorized:false as const};
 } catch {
  return {reproduced:false,source:'synthetic' as const,scoreUsable:false as const,persistenceAuthorized:false as const,productionAuthorized:false as const};
 }
}
