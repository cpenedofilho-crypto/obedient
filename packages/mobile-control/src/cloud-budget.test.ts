// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { reserveBudget, settleBudget, remainingBudget } from "./cloud-budget.ts";
test("reserve and settle without exceeding limit", () => {
  const initial = { limitMicros: 100, spentMicros: 10, reservedMicros: 0 };
  const reserved = reserveBudget(initial, 80);
  assert.equal(remainingBudget(reserved), 10);
  assert.throws(() => reserveBudget(reserved, 11));
  assert.throws(() => settleBudget(reserved, 80, 81));
  assert.deepEqual(settleBudget(reserved, 80, 30), {limitMicros:100, spentMicros:40, reservedMicros:0});
});
test("reject invalid amounts and inconsistent state", () => {
  const b = {limitMicros:100, spentMicros:0, reservedMicros:0};
  for (const n of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER+1]) assert.throws(() => reserveBudget(b,n));
  assert.throws(() => remainingBudget({...b, reservedMicros:101}));
  assert.throws(() => settleBudget(b,1,0));
});
