// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, type Evidence, type Verdict } from './business-invariants.js';
type Scenario = { id: string; rule: string; evidence: Evidence; expected: Verdict };
const scenarios: Scenario[] = [];
const add = (id: string, rule: string, evidence: Evidence, expected: Verdict) => scenarios.push({id,rule,evidence,expected});
for (let i=0;i<20;i++) {
 const tenant = 'synthetic-'+i;
 const amount = 100+i;
 const base: Evidence = {expectedTenant:tenant,actualTenant:tenant,expectedAmount:amount,settledAmount:amount,expectedCurrency:'BRL',settledCurrency:'BRL',verifiedSettlement:true,entitlementGranted:true};
 const mode=i%5;
 add('payment-'+i,'payment-entitlement',mode===0?base:mode===1?{...base,settledAmount:amount+1}:mode===2?{...base,verifiedSettlement:false}:mode===3?{...base,settledCurrency:'USD'}:{...base,verifiedSettlement:undefined},mode===0?'pass':mode===4?'inconclusive':'fail');
 add('tenant-'+i,'tenant',{expectedTenant:tenant,actualTenant:i%3===0?tenant:i%3===1?'other':undefined},i%3===0?'pass':i%3===1?'fail':'inconclusive');
 add('workflow-'+i,'workflow',{transitionAllowed:i%4!==1,transitionAuthorized:i%4===3?undefined:i%4!==2},i%4===0?'pass':i%4===3?'inconclusive':'fail');
 add('duplicate-'+i,'idempotency',{duplicateFinancialEffect:i%3===0?false:i%3===1?true:undefined},i%3===0?'pass':i%3===1?'fail':'inconclusive');
 add('promotion-'+i,'promotion',{promotionApplied:true,promotionEligible:i%4!==1,promotionLimitExceeded:i%4===3?undefined:i%4===2},i%4===0?'pass':i%4===3?'inconclusive':'fail');
}
test('catalog contains 100 unique synthetic scenario IDs',()=>{assert.equal(scenarios.length,100);assert.equal(new Set(scenarios.map(s=>s.id)).size,100);});
for (const s of scenarios) test(s.id,()=>assert.equal(evaluate(s.evidence).find(f=>f.id===s.rule)?.verdict,s.expected));
