// SPDX-License-Identifier: AGPL-3.0-only
/** Pure accounting primitives. Not a durable reservation or authorization mechanism. */
export interface CloudBudget {
  readonly limitMicros: number;
  readonly spentMicros: number;
  readonly reservedMicros: number;
}
function amount(n: number): number {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("invalid monetary amount");
  return n;
}
export function remainingBudget(b: CloudBudget): number {
  const limit = amount(b.limitMicros);
  const spent = amount(b.spentMicros);
  const reserved = amount(b.reservedMicros);
  if (spent > limit || reserved > limit - spent) throw new Error("budget exceeded");
  return limit - spent - reserved;
}
export function reserveBudget(b: CloudBudget, cost: number): CloudBudget {
  amount(cost);
  if (cost > remainingBudget(b)) throw new Error("insufficient budget");
  return { ...b, reservedMicros: b.reservedMicros + cost };
}
/** Settle only a confirmed reservation. Unknown outcomes must remain reserved. */
export function settleBudget(b: CloudBudget, reservation: number, actual: number): CloudBudget {
  remainingBudget(b);
  amount(reservation);
  amount(actual);
  if (reservation > b.reservedMicros || actual > reservation) throw new Error("invalid settlement");
  return { ...b, reservedMicros: b.reservedMicros - reservation, spentMicros: b.spentMicros + actual };
}
