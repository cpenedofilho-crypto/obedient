// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectPaymentRequired } from "./index.ts";
const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");
test("never proposes a payment for non-402", () => {
  assert.deepEqual(inspectPaymentRequired(200, {}), { status: "not_required" });
});
test("rejects missing and invalid payment requirements", () => {
  assert.equal(inspectPaymentRequired(402, {}).status, "unsupported");
  assert.equal(inspectPaymentRequired(402, { "payment-required": "!!!" }).status, "unsupported");
});
test("rejects ambiguous or nonpositive amounts", () => {
  assert.equal(inspectPaymentRequired(402, { "payment-required": encode({ accepts: [] }) }).status, "unsupported");
  assert.equal(inspectPaymentRequired(402, { "payment-required": encode({ accepts: [{ amount: "0", asset: "USDC", network: "eip155:8453" }] }) }).status, "unsupported");
});
test("only returns a review proposal, never a payment", () => {
  const result = inspectPaymentRequired(402, { "Payment-Required": encode({ accepts: [{ amount: "100", asset: "USDC", network: "eip155:8453" }] }) });
  assert.equal(result.status, "review_required");
  assert.equal("transaction" in result, false);
});
