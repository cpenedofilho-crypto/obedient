// SPDX-License-Identifier: AGPL-3.0-only
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generate, simulate} from './index.js';
test('deterministic synthetic scenarios', () => {
  assert.deepEqual(generate(42, 100), generate(42, 100));
  assert.notDeepEqual(generate(42, 100), generate(43, 100));
  assert.ok(generate(42, 100).every(s => s.synthetic && s.budget >= 1 && s.budget <= 4));
});
test('bounded retries and accounting', () => {
  const a = simulate(42, 10000, 'bounded-retry');
  const b = simulate(42, 10000, 'single-attempt');
  assert.equal(a.successes + a.exhausted, a.count);
  assert.ok(a.attempts <= 3 * a.count);
  assert.ok(a.attempts <= generate(42, 10000).reduce((sum,s) => sum+s.budget,0));
  assert.ok(a.successes >= b.successes);
  assert.equal(a.externalEffects, 0);
});
test('reject invalid inputs', () => {
  for (const n of [0, -1, 10001, NaN, 1.5]) assert.throws(() => generate(42,n));
  assert.throws(() => generate(-1,1));
  assert.throws(() => simulate(1,1,'unknown' as never));
});
