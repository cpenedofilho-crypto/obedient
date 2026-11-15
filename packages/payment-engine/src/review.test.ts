// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { test } from "node:test";
import { SimulatedPaymentReviewQueue } from "./review.ts";
const proposal = { status: "review_required", challenge: "fake", amount: "100", asset: "TEST", network: "offline" } as const;
test("replay is rejected within a tenant and mission", () => {
  const queue = new SimulatedPaymentReviewQueue();
  const req = { organizationId: "org-a", missionId: "mission-a", requestId: "request-a", proposal };
  assert.equal(queue.submit(req).status, "queued");
  assert.equal(queue.submit(req).status, "duplicate");
});
test("different organizations do not share idempotency keys", () => {
  const queue = new SimulatedPaymentReviewQueue();
  const base = { missionId: "mission-a", requestId: "request-a", proposal };
  assert.equal(queue.submit({ ...base, organizationId: "org-a" }).status, "queued");
  assert.equal(queue.submit({ ...base, organizationId: "org-b" }).status, "queued");
});
test("no payment execution method exists", () => {
  const queue = new SimulatedPaymentReviewQueue();
  assert.equal("pay" in queue, false);
  assert.equal("settle" in queue, false);
  assert.equal(queue.submit({ organizationId: "a", missionId: "m", requestId: "r", proposal: { status: "unsupported", reason: "invalid" } }).status, "rejected");
});
