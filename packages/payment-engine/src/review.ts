// SPDX-License-Identifier: AGPL-3.0-only
// Offline-only review queue. Never authorizes, signs or settles payments.
import type { PaymentProposal } from "./index.ts";

export interface ReviewRequest {
  organizationId: string;
  missionId: string;
  requestId: string;
  proposal: PaymentProposal;
}
export type ReviewResult =
  | { status: "queued"; key: string }
  | { status: "duplicate" }
  | { status: "rejected"; reason: string };

export class SimulatedPaymentReviewQueue {
  private readonly seen = new Set<string>();
  submit(input: ReviewRequest): ReviewResult {
    if (!input.organizationId || !input.missionId || !input.requestId ||
        input.organizationId.length > 128 || input.missionId.length > 128 || input.requestId.length > 128)
      return { status: "rejected", reason: "invalid_scope" };
    if (input.proposal.status !== "review_required")
      return { status: "rejected", reason: "no_supported_proposal" };
    const key = JSON.stringify([input.organizationId, input.missionId, input.requestId]);
    if (this.seen.has(key)) return { status: "duplicate" };
    this.seen.add(key);
    return { status: "queued", key };
  }
}
