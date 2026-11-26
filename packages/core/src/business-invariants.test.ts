// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, type Evidence } from './business-invariants.js';
const verdict = (e: Evidence, id: string) => evaluate(e).find(x => x.id === id)?.verdict;
const settled: Evidence = { expectedTenant:'a', actualTenant:'a', expectedAmount:100, settledAmount:100, expectedCurrency:'BRL', settledCurrency:'BRL', verifiedSettlement:true, entitlementGranted:true };
test('missing evidence is never a pass', () => assert.ok(evaluate({}).every(x => x.verdict === 'inconclusive')));
test('verified matching payment', () => assert.equal(verdict(settled,'payment-entitlement'),'pass'));
test('unverified settlement', () => assert.equal(verdict({...settled,verifiedSettlement:false},'payment-entitlement'),'fail'));
test('cross tenant entitlement', () => assert.equal(verdict({...settled,actualTenant:'b'},'payment-entitlement'),'fail'));
test('amount mismatch', () => assert.equal(verdict({...settled,settledAmount:99},'payment-entitlement'),'fail'));
test('currency mismatch', () => assert.equal(verdict({...settled,settledCurrency:'USD'},'payment-entitlement'),'fail'));
test('invalid amount', () => assert.equal(verdict({...settled,settledAmount:NaN},'payment-entitlement'),'inconclusive'));
test('duplicate effect', () => assert.equal(verdict({duplicateFinancialEffect:true},'idempotency'),'fail'));
test('unauthorized workflow', () => assert.equal(verdict({transitionAllowed:true,transitionAuthorized:false},'workflow'),'fail'));
test('promotion limit', () => assert.equal(verdict({promotionApplied:true,promotionEligible:true,promotionLimitExceeded:true},'promotion'),'fail'));
test('valid promotion', () => assert.equal(verdict({promotionApplied:true,promotionEligible:true,promotionLimitExceeded:false},'promotion'),'pass'));
