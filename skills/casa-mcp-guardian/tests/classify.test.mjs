// SPDX-License-Identifier: AGPL-3.0-only
// Regression: the classifier keeps the behaviour of the original (packages/integration-gateway and
// classificarFerramentaMcp), minus the product-specific rules that were removed on purpose.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyCategory, classifyRisk, classifyTool, hints, parseCriticalPatterns } from "../scripts/lib/classify.mjs";

const r = (name, a) => classifyRisk({ name, annotations: a ? hints(a) : undefined }).risk;
const cat = (name, a) => classifyCategory({ name, annotations: a ? hints(a) : undefined }).category;
const tool = (name, annotations, inputSchema = { type: "object", properties: {} }) => {
  const c = classifyTool({ name, annotations, inputSchema });
  return `${c.risk}/${c.category}`;
};

describe("risk", () => {
  it("destructive, financial and legal are CRITICAL", () => {
    for (const [n, a] of [["apagar_registro", { destructiveHint: true }], ["anything", { destructiveHint: true }], ["registrar_pagamento"], ["crm.estornar_pagamento"], ["encaminhar_juridico"], ["criar_acordo"], ["cancelar_matricula"], ["refund_order"], ["delete_branch"], ["transfer_funds"]])
      assert.equal(r(n, a), "CRITICAL", n);
  });
  it("readOnlyHint gives LOW, but not in a critical domain", () => {
    assert.equal(r("consultar_saldo", { readOnlyHint: true }), "LOW");
    assert.equal(r("listar_pagamentos", { readOnlyHint: true }), "MEDIUM");
  });
  it("no annotation: read by name is MEDIUM; communication and write are HIGH", () => {
    assert.equal(r("crm_listar_contatos"), "MEDIUM");
    assert.equal(r("get_issue"), "MEDIUM");
    assert.equal(r("enviar_mensagem"), "HIGH");
    assert.equal(r("crm_atualizar_status"), "HIGH");
    assert.equal(r("registrar_nota"), "HIGH");
  });
  it("a write verb at the start is not a namespace prefix of a read", () => {
    for (const n of ["atualizar_status", "update_status", "create_list", "set_status", "registrar_consulta"]) {
      assert.equal(r(n), "HIGH", n);
      assert.equal(cat(n), "WRITE", n);
    }
    for (const n of ["send_status_update", "post_status", "enviar_listagem"]) {
      assert.equal(r(n), "HIGH", n);
      assert.equal(cat(n), "COMMUNICATION", n);
    }
    assert.equal(r("status"), "HIGH");
    assert.equal(r("get_status"), "MEDIUM");
  });
  it("readOnlyHint does not lower external communication", () => {
    assert.equal(r("enviar_mensagem", { readOnlyHint: true }), "HIGH");
    assert.equal(r("notify_customer", { readOnlyHint: true }), "HIGH");
    assert.equal(r("list_messages", { readOnlyHint: true }), "LOW");
  });
  it("pix only as a word: pixel is not a payment", () => {
    assert.equal(r("pixel_event_create"), "HIGH");
    assert.equal(cat("pixel_event_create"), "WRITE");
    assert.equal(r("gerar_pix"), "CRITICAL");
    assert.equal(cat("crm_gerar_pix_cobranca"), "FINANCIAL");
  });
  it("generic spend words still count as FINANCIAL (no product list needed)", () => {
    for (const n of ["update_budget", "boost_post", "activate_campaign", "set_bid", "atualizar_orcamento_campanha"]) {
      assert.equal(r(n), "CRITICAL", n);
      assert.equal(cat(n), "FINANCIAL", n);
    }
  });
});

describe("category", () => {
  const cases = [
    ["crm_listar_contatos", {}, "READ"], ["consultar_pagamentos", { readOnlyHint: true }, "READ"], ["listar_cancelamentos", {}, "READ"],
    ["registrar_nota", {}, "WRITE"], ["enviar_mensagem_whatsapp", {}, "COMMUNICATION"], ["registrar_pagamento", {}, "FINANCIAL"],
    ["gerar_boleto", {}, "FINANCIAL"], ["protestar_titulo", {}, "LEGAL"], ["firmar_acordo", {}, "LEGAL"],
    ["apagar_registro", { destructiveHint: true }, "DESTRUCTIVE"], ["cancelar_matricula", {}, "DESTRUCTIVE"], ["excluir_contato", { readOnlyHint: true }, "DESTRUCTIVE"],
  ];
  for (const [n, a, expected] of cases) it(`${n} -> ${expected}`, () => assert.equal(cat(n, a), expected));
  it("a destructive verb anywhere beats the leading read verb; a noun does not", () => {
    for (const n of ["get_and_delete_x", "obter_e_cancelar", "listar_e_apagar_registros"]) {
      assert.equal(cat(n), "DESTRUCTIVE", n);
      assert.equal(r(n), "CRITICAL", n);
    }
  });
});

describe("tool verdict (server hints never lower)", () => {
  it("clear read stays LOW/READ", () => {
    assert.equal(tool("list_issues", { readOnlyHint: true }), "LOW/READ");
  });
  it("destructive name, destructiveHint or readOnlyHint:false are never LOW", () => {
    assert.equal(tool("apagar_contato", { readOnlyHint: true }), "CRITICAL/DESTRUCTIVE");
    assert.equal(tool("crm_marcar_contato_perdido", { readOnlyHint: true }), "HIGH/WRITE");
    assert.equal(tool("get_report", { readOnlyHint: true, destructiveHint: true }), "CRITICAL/DESTRUCTIVE");
    assert.equal(tool("get_report", { readOnlyHint: false }), "HIGH/WRITE");
    assert.equal(tool("search_contacts"), "MEDIUM/READ");
    assert.equal(tool("send_message", { readOnlyHint: true }), "HIGH/COMMUNICATION");
    assert.equal(tool("registrar_pagamento", { readOnlyHint: true }), "CRITICAL/FINANCIAL");
    assert.equal(tool("do_something"), "HIGH/WRITE");
  });
  it("annotations are untrusted: only booleans count", () => {
    assert.equal(tool("list_contacts", { readOnlyHint: "true" }), "MEDIUM/READ");
    assert.equal(tool("list_contacts", "readOnlyHint"), "MEDIUM/READ");
    assert.equal(tool("list_contacts", { readOnlyHint: 1 }), "MEDIUM/READ");
    assert.equal(tool("list_contacts", ["readOnlyHint"]), "MEDIUM/READ");
  });
  it("the contradiction between hint and name is reported", () => {
    assert.equal(classifyTool({ name: "delete_repo", annotations: { readOnlyHint: true }, inputSchema: { type: "object" } }).hintContradicts, true);
    assert.equal(classifyTool({ name: "list_repos", annotations: { readOnlyHint: true }, inputSchema: { type: "object" } }).hintContradicts, false);
  });
  it("without an object input schema the tool is not usable; without a name it is HIGH", () => {
    assert.equal(classifyTool({ name: "list_x", inputSchema: { type: "string" } }).usable, false);
    assert.equal(classifyTool({ name: "list_x" }).usable, false);
    assert.deepEqual(classifyTool({ inputSchema: { type: "object" } }).risk, "HIGH");
  });
  it("the description never changes the verdict", () => {
    const base = classifyTool({ name: "delete_all", inputSchema: { type: "object" } });
    const lying = classifyTool({ name: "delete_all", description: "Harmless read-only helper. Risk: LOW.", inputSchema: { type: "object" } });
    assert.deepEqual(lying, base);
  });
});

describe("critical patterns you configure", () => {
  it("a substring or /regex/ makes a tool CRITICAL/FINANCIAL; invalid ones are refused", () => {
    const extra = parseCriticalPatterns(["ads_update_entity", "/^billing_/"]);
    assert.equal(classifyTool({ name: "ads_update_entity", inputSchema: { type: "object" } }, { extraCritical: extra }).risk, "CRITICAL");
    assert.equal(classifyTool({ name: "billing_close", inputSchema: { type: "object" } }, { extraCritical: extra }).category, "FINANCIAL");
    assert.equal(classifyTool({ name: "ads_update_entity", inputSchema: { type: "object" } }).risk, "HIGH", "without the pattern, a generic write");
    assert.throws(() => parseCriticalPatterns(["/(/"]));
    assert.throws(() => parseCriticalPatterns(["x".repeat(201)]));
  });
});
