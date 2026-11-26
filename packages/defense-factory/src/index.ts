// SPDX-License-Identifier: AGPL-3.0-only
// Pure triage only. Scope is supplied by an authenticated policy adapter, not a model.
export type Severity = "low" | "medium" | "high" | "critical";
export type Finding = Readonly<{repository: string; revision: string; rule: string; evidenceId: string; severity: Severity}>;
const repo = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;
const opaque = /^[a-zA-Z0-9_-]{1,128}$/;
const revision = /^[a-f0-9]{40}$/;
const rank: Record<Severity, number> = {low:0,medium:1,high:2,critical:3};
export function triage(scope: readonly string[], findings: readonly Finding[]): Finding[] {
  const allowed = new Set(scope.filter(x => repo.test(x)));
  const unique = new Map<string, Finding>();
  for (const f of findings) {
    if (!allowed.has(f.repository) || !revision.test(f.revision) ||
        !opaque.test(f.rule) || !opaque.test(f.evidenceId) ||
        !Object.hasOwn(rank, f.severity)) throw new Error("Invalid or out-of-scope finding");
    const key = JSON.stringify([f.repository,f.revision,f.rule,f.evidenceId]);
    const previous = unique.get(key);
    if (!previous || rank[f.severity] > rank[previous.severity])
      unique.set(key, {repository:f.repository,revision:f.revision,rule:f.rule,evidenceId:f.evidenceId,severity:f.severity});
  }
  return [...unique.values()].sort((a,b)=>rank[b.severity]-rank[a.severity]);
}
