// SPDX-License-Identifier: AGPL-3.0-only
import {verifyEvidence, type createEvidence} from './verification.js';
export function reviewCandidate(evidence:ReturnType<typeof createEvidence>){
 const verification=verifyEvidence(evidence);
 return Object.freeze({source:'synthetic' as const,status:verification.reproduced?'review-only' as const:'rejected' as const,reason:verification.reproduced?'reproduced-not-real-world-evidence':'invalid-evidence',scoreUsable:false as const,memoryWriteAllowed:false as const,missionExecutionAllowed:false as const,permissionChangeAllowed:false as const});
}
