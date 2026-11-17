// SPDX-License-Identifier: AGPL-3.0-only
//
// Parity: the classifier of the casa-mcp-guardian skill (skills/casa-mcp-guardian/scripts/lib/classify.mjs)
// gives the same verdict as the original (classificarFerramentaMcp, packages/server/src/mcp-servidores.ts)
// over a few thousand name × annotation combinations. The only differences allowed are the ones made on
// purpose when the skill was extracted:
//   · the exact tool names of one ad platform (MIDIA_NO_AR in risco.ts) are no longer CRITICAL by
//     themselves (the skill offers --critical-pattern for that);
//   · "quem_sou" (a verb of an internal product) is no longer a read verb;
//   · "notify"/"notification" now count as external communication (the original only knew "notific").
// If this test fails, either the original changed (port the change to the skill) or the skill drifted.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classificarFerramentaMcp } from "../../packages/server/src/mcp-servidores.ts";
// @ts-expect-error: plain JavaScript module with JSDoc types, no declaration file
import { classifyTool } from "../../skills/casa-mcp-guardian/scripts/lib/classify.mjs";

const PREFIXES = ["", "crm_", "svc.", "x-"];
const VERBS = ["get", "list", "listar", "consultar", "buscar", "obter", "read", "search", "detalhar", "contar", "sugerir", "ping", "resumo", "update", "atualizar", "create", "criar", "set", "registrar", "send", "enviar", "post", "publish", "notify", "notificar", "delete", "apagar", "remove", "excluir", "cancel", "cancelar", "revoke", "drop", "purge", "pay", "charge", "refund", "estornar", "transfer", "gerar", "boost", "activate", "ativar", "run", "execute", "move", "upload", "quem_sou", "do", "fazer"];
const NOUNS = ["", "status", "list", "items", "messages", "mensagem", "email", "payment", "pagamento", "pix", "pixel", "boleto", "contract", "acordo", "budget", "orcamento", "bid", "report", "eu", "and_delete_x", "e_cancelar", "notification", "cancelamentos", "juridico", "legal_hold"];
const HINTS: (Record<string, unknown> | undefined)[] = [undefined, { readOnlyHint: true }, { readOnlyHint: false }, { destructiveHint: true }, { readOnlyHint: true, destructiveHint: true }, { readOnlyHint: "true" }];
const AD_PLATFORM = ["ads_update_entity", "ads_create_ad_set", "ads_create_campaign", "ads_experiment_abtest_create_test", "ads_experiment_abtest_update_test", "ads_experiment_lift_create_test", "meta.ads_update_entity"];

type Veredito = string;
const original = (name: string, annotations: unknown): Veredito => {
  const c = classificarFerramentaMcp({ name, inputSchema: { type: "object" }, annotations: annotations as Record<string, unknown> });
  return c ? `${c.risco}/${c.categoria}` : "null";
};
const skill = (name: string, annotations: unknown): Veredito => {
  const c = classifyTool({ name, inputSchema: { type: "object" }, annotations });
  return `${c.risk}/${c.category}`;
};
const norm = (n: string) => n.toLowerCase().replace(/[^a-z0-9]+/g, "_");
const explained = (name: string) => {
  const n = norm(name);
  return AD_PLATFORM.some((a) => n.endsWith(norm(a))) || n.includes("quem_sou") || (/notif/.test(n) && !/notific/.test(n));
};

describe("casa-mcp-guardian: same verdicts as the original classifier", () => {
  it("over every prefix × verb × noun × annotation, differences only where intended", () => {
    const names = [...AD_PLATFORM];
    for (const p of PREFIXES) for (const v of VERBS) for (const n of NOUNS) names.push(`${p}${v}${n ? `_${n}` : ""}`);
    let compared = 0;
    const unexplained: string[] = [];
    const intended: string[] = [];
    for (const name of names) {
      for (const h of HINTS) {
        compared++;
        const a = original(name, h);
        const b = skill(name, h);
        if (a === b) continue;
        (explained(name) ? intended : unexplained).push(`${name} ${JSON.stringify(h ?? {})}: original ${a}, skill ${b}`);
      }
    }
    assert.ok(compared > 5000, `${compared} combinations`);
    assert.deepEqual(unexplained, []);
    assert.ok(intended.length > 0, "the intended differences are exercised");
  });

  it("the intended differences go the expected way", () => {
    // Ad-platform names: no longer CRITICAL on their own (generic write, still HIGH).
    assert.equal(original("ads_update_entity", undefined), "CRITICAL/FINANCIAL");
    assert.equal(skill("ads_update_entity", undefined), "HIGH/WRITE");
    // notify: the skill files it as external communication (the original saw a generic write).
    assert.equal(original("notify_customer", { readOnlyHint: true }), "HIGH/WRITE");
    assert.equal(skill("notify_customer", { readOnlyHint: true }), "HIGH/COMMUNICATION");
  });
});
