// SPDX-License-Identifier: AGPL-3.0-only
// Offline evaluator. Inputs are evidence claims, not independently authenticated facts.
export type Verdict = 'pass' | 'fail' | 'inconclusive';
export type Evidence = {
  expectedTenant?: string; actualTenant?: string;
  expectedAmount?: number; settledAmount?: number;
  expectedCurrency?: string; settledCurrency?: string;
  verifiedSettlement?: boolean; entitlementGranted?: boolean;
  duplicateFinancialEffect?: boolean; transitionAllowed?: boolean;
  transitionAuthorized?: boolean; promotionEligible?: boolean;
  promotionLimitExceeded?: boolean; promotionApplied?: boolean;
};
export type Finding = { id: string; verdict: Verdict };
function equal(a: string | number | undefined, b: string | number | undefined): Verdict {
  if (a === undefined || b === undefined) return 'inconclusive';
  if (typeof a === 'number' && (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 0 || Number(b) < 0)) return 'inconclusive';
  if (a === '' || b === '') return 'inconclusive';
  return a === b ? 'pass' : 'fail';
}
function required(v: boolean | undefined): Verdict {
  return v === true ? 'pass' : v === false ? 'fail' : 'inconclusive';
}
function all(...v: Verdict[]): Verdict {
  return v.includes('fail') ? 'fail' : v.includes('inconclusive') ? 'inconclusive' : 'pass';
}
function when(applied: boolean | undefined, verdict: Verdict): Verdict {
  return applied === true ? verdict : 'inconclusive';
}
export function evaluate(e: Readonly<Evidence>): Finding[] {
  const tenant = equal(e.expectedTenant, e.actualTenant);
  return [
    { id: 'tenant', verdict: tenant },
    { id: 'payment-entitlement', verdict: when(e.entitlementGranted, all(tenant, required(e.verifiedSettlement), equal(e.expectedAmount,e.settledAmount), equal(e.expectedCurrency,e.settledCurrency))) },
    { id: 'idempotency', verdict: required(e.duplicateFinancialEffect === undefined ? undefined : !e.duplicateFinancialEffect) },
    { id: 'workflow', verdict: all(required(e.transitionAllowed), required(e.transitionAuthorized)) },
    { id: 'promotion', verdict: when(e.promotionApplied, all(required(e.promotionEligible), required(e.promotionLimitExceeded === undefined ? undefined : !e.promotionLimitExceeded))) },
  ];
}
