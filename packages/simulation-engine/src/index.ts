// SPDX-License-Identifier: AGPL-3.0-only
export type Policy = 'bounded-retry' | 'single-attempt';
export type Scenario = Readonly<{ synthetic: true; id: number; failures: number; budget: number }>;
export function generate(seed: number, count: number): readonly Scenario[] {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff || !Number.isSafeInteger(count) || count < 1 || count > 10000) throw new RangeError('invalid experiment limits');
  let state = seed >>> 0;
  const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
  return Object.freeze(Array.from({length: count}, (_, id) => Object.freeze({synthetic: true as const, id, failures: next() % 5, budget: 1 + ((next() >>> 16) % 4)})));
}
export function simulate(seed: number, count: number, policy: Policy) {
  if (policy !== 'bounded-retry' && policy !== 'single-attempt') throw new RangeError('unknown policy');
  const scenarios = generate(seed, count);
  let successes = 0, attempts = 0, exhausted = 0;
  for (const s of scenarios) {
    const limit = policy === 'single-attempt' ? 1 : Math.min(3, s.budget);
    const used = Math.min(limit, s.failures + 1);
    attempts += used;
    if (s.failures < limit) successes++; else exhausted++;
  }
  return Object.freeze({version: 1, synthetic: true, seed, count, policy, successes, attempts, exhausted, successRate: successes / count, externalEffects: 0});
}
