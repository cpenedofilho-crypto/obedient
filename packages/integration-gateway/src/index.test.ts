// SPDX-License-Identifier: AGPL-3.0-only
// Testes portados de casa-de-ia/src/mcp-gateway/regras.test.ts e categorias.test.ts (commit 45ba448),
// de vitest para node:test. Mesmos casos, menos os de dono de segredo por organização (não extraído)
// e os que dependiam do Policy Engine do Growth OS. O endpoint real de produção foi trocado por um
// host de exemplo.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  casaPadraoFerramenta,
  categoriaEfetiva,
  classificar,
  classificarCategoria,
  hashArgumentos,
  paraAprovacao,
  paraGravar,
  permissoesPadrao,
  podeRepetir,
  redigir,
  riscoEfetivo,
  satisfaz,
  semSegredo,
  temPermissoes,
  validarEndpoint,
} from "./index.ts";

const c = (name: string, annotations?: Record<string, boolean>) => classificar({ name, ...(annotations ? { annotations } : {}) }).nivel;
const cat = (name: string, annotations: Record<string, boolean> = {}) => classificarCategoria({ name, annotations }).categoria;

describe("classificação de risco", () => {
  it("destrutivo, financeiro e jurídico são CRITICAL", () => {
    for (const [n, a] of [["apagar_registro", { destructiveHint: true }], ["qualquer_coisa", { destructiveHint: true }], ["registrar_pagamento"], ["recupera.estornar_pagamento"], ["encaminhar_juridico"], ["criar_acordo"], ["cancelar_matricula"]] as const)
      assert.equal(c(n, a as Record<string, boolean> | undefined), "CRITICAL", n);
  });

  it("readOnlyHint dá LOW, mas não em domínio crítico", () => {
    assert.equal(c("consultar_saldo", { readOnlyHint: true }), "LOW");
    assert.equal(c("listar_pagamentos", { readOnlyHint: true }), "MEDIUM");
  });

  it("sem anotação: leitura pelo nome é MEDIUM; comunicação e escrita são HIGH", () => {
    assert.equal(c("motor_listar_leads_quentes"), "MEDIUM");
    assert.equal(c("motor_obter_lead"), "MEDIUM");
    assert.equal(c("enviar_mensagem"), "HIGH");
    assert.equal(c("motor_atualizar_status"), "HIGH");
    assert.equal(c("registrar_nota"), "HIGH");
  });

  it("verbo de escrita no começo não vira 'prefixo de namespace' de leitura", () => {
    for (const nome of ["atualizar_status", "update_status", "create_list", "set_status", "registrar_consulta"]) {
      assert.equal(c(nome), "HIGH", nome);
      assert.equal(cat(nome), "WRITE", nome);
    }
    for (const nome of ["send_status_update", "post_status", "enviar_listagem"]) {
      assert.equal(c(nome), "HIGH", nome);
      assert.equal(cat(nome), "COMMUNICATION", nome);
    }
    assert.equal(c("status"), "HIGH");
    assert.equal(c("get_status"), "MEDIUM");
    assert.equal(c("recupera_consultar_status_juridico", { readOnlyHint: true }), "MEDIUM");
  });

  it("readOnlyHint não rebaixa comunicação externa; leitura explícita de mensagens segue LOW", () => {
    assert.equal(c("enviar_mensagem", { readOnlyHint: true }), "HIGH");
    assert.equal(cat("enviar_mensagem", { readOnlyHint: true }), "COMMUNICATION");
    assert.equal(c("notificar_cliente", { readOnlyHint: true }), "HIGH");
    assert.equal(c("recupera_consultar_mensagens", { readOnlyHint: true }), "LOW");
    assert.equal(cat("motor_consultar_mensagens", { readOnlyHint: true }), "READ");
  });

  it("verbo destrutivo em qualquer posição vence a leitura na categoria; substantivo não", () => {
    for (const nome of ["get_and_delete_x", "obter_e_cancelar", "listar_e_apagar_registros"]) {
      assert.equal(cat(nome), "DESTRUCTIVE", nome);
      assert.equal(c(nome), "CRITICAL", nome);
    }
    assert.equal(cat("listar_cancelamentos"), "READ");
  });

  it("pix só como palavra: pixel de anúncio não é pagamento", () => {
    assert.equal(c("ads_pixel_event_create"), "HIGH");
    assert.equal(cat("ads_pixel_event_create"), "WRITE");
    assert.equal(c("gerar_pix"), "CRITICAL");
    assert.equal(cat("recupera_gerar_pix_cobranca"), "FINANCIAL");
  });

  it("permissões padrão sobem com o risco", () => {
    assert.deepEqual(permissoesPadrao("motor", "LOW"), ["mcp:motor:read"]);
    assert.deepEqual(permissoesPadrao("motor", "MEDIUM"), ["mcp:motor:read"]);
    assert.deepEqual(permissoesPadrao("motor", "HIGH"), ["mcp:motor:write"]);
    assert.deepEqual(permissoesPadrao("motor", "CRITICAL"), ["mcp:motor:write", "mcp:motor:critical"]);
  });

  it("repete só leitura e idempotente, nunca HIGH+", () => {
    assert.equal(podeRepetir("LOW", {}), true);
    assert.equal(podeRepetir("MEDIUM", {}), false);
    assert.equal(podeRepetir("MEDIUM", { readOnlyHint: true }), true);
    assert.equal(podeRepetir("HIGH", { idempotentHint: true }), false);
  });
});

describe("categoria da ferramenta (nome e anotação, nunca a descrição)", () => {
  const casos: [string, Record<string, boolean>, string][] = [
    ["motor_listar_leads_quentes", {}, "READ"],
    ["motor_obter_contexto_lead_360", { readOnlyHint: true }, "READ"],
    ["consultar_pagamentos", { readOnlyHint: true }, "READ"],
    ["listar_cancelamentos", {}, "READ"],
    ["registrar_nota", {}, "WRITE"],
    ["motor_atualizar_status", {}, "WRITE"],
    ["enviar_mensagem_whatsapp", {}, "COMMUNICATION"],
    ["registrar_pagamento", {}, "FINANCIAL"],
    ["gerar_boleto", {}, "FINANCIAL"],
    ["protestar_titulo", {}, "LEGAL"],
    ["firmar_acordo", {}, "LEGAL"],
    ["apagar_registro", { destructiveHint: true }, "DESTRUCTIVE"],
    ["cancelar_matricula", {}, "DESTRUCTIVE"],
    ["excluir_lead", { readOnlyHint: true }, "DESTRUCTIVE"],
  ];
  for (const [nome, anot, esperado] of casos) it(`${nome} → ${esperado}`, () => assert.equal(cat(nome, anot), esperado));

  const meta: [string, string, string][] = [
    ["ads_activate_entity", "FINANCIAL", "CRITICAL"],
    ["ads_boost_ig_post", "FINANCIAL", "CRITICAL"],
    ["ads_update_adset_budget", "FINANCIAL", "CRITICAL"],
    ["atualizar_orcamento_campanha", "FINANCIAL", "CRITICAL"],
    ["ads_update_entity", "FINANCIAL", "CRITICAL"],
    ["meta.ads_update_entity", "FINANCIAL", "CRITICAL"],
    ["ads_create_ad_set", "FINANCIAL", "CRITICAL"],
    ["ads_create_campaign", "FINANCIAL", "CRITICAL"],
    ["ads_experiment_abtest_create_test", "FINANCIAL", "CRITICAL"],
    ["ads_experiment_abtest_update_test", "FINANCIAL", "CRITICAL"],
    ["ads_experiment_lift_create_test", "FINANCIAL", "CRITICAL"],
    ["ads_create_ad", "WRITE", "HIGH"],
    ["ads_creative_update", "WRITE", "HIGH"],
    ["ads_get_ad_entities", "READ", "MEDIUM"],
    ["ads_delete_custom_audience", "DESTRUCTIVE", "CRITICAL"],
    ["consultar_balance", "READ", "MEDIUM"],
    ["motor_agendar_reativacao", "WRITE", "HIGH"],
  ];
  for (const [nome, categoria, nivel] of meta)
    it(`Meta Ads: ${nome} → ${categoria}, ${nivel}`, () => {
      assert.equal(cat(nome), categoria);
      assert.equal(classificar({ name: nome }).nivel, nivel);
    });

  it("ads_update_entity não fica abaixo de CRITICAL nem com readOnlyHint do servidor", () => {
    assert.equal(classificar({ name: "ads_update_entity", annotations: { readOnlyHint: true } }).nivel, "CRITICAL");
    assert.equal(cat("ads_update_entity", { readOnlyHint: true }), "FINANCIAL");
  });

  it("vale a reclassificação humana; sem nada gravado, calcula na hora", () => {
    assert.equal(categoriaEfetiva({ name: "registrar_nota", annotations: {}, category: "WRITE", categoryOverride: "COMMUNICATION" }), "COMMUNICATION");
    assert.equal(categoriaEfetiva({ name: "registrar_pagamento", annotations: {}, category: null, categoryOverride: null }), "FINANCIAL");
    assert.equal(categoriaEfetiva({ name: "x", annotations: {}, category: "INVENTADA" }), "WRITE");
  });

  it("risco efetivo: categoria crítica não desce por reclassificação humana", () => {
    assert.equal(riscoEfetivo({ riskLevel: "CRITICAL", riskOverride: "LOW", name: "registrar_pagamento" }), "CRITICAL");
    assert.equal(riscoEfetivo({ riskLevel: "HIGH", riskOverride: "LOW", name: "registrar_nota" }), "LOW");
  });
});

describe("permissões", () => {
  it("curinga por segmento", () => {
    assert.equal(satisfaz("mcp:*:read", "mcp:motor:read"), true);
    assert.equal(satisfaz("mcp:motor:*", "mcp:motor:critical"), true);
    assert.equal(satisfaz("*", "mcp:motor:write"), true);
    assert.equal(satisfaz("mcp:motor:read", "mcp:motor:write"), false);
    assert.equal(satisfaz("mcp:*", "mcp:motor:read"), false);
  });

  it("lista o que falta", () => {
    assert.deepEqual(temPermissoes(["mcp:motor:write"], ["mcp:motor:write", "mcp:motor:critical"]), ["mcp:motor:critical"]);
    assert.deepEqual(temPermissoes(["mcp:motor:*"], ["mcp:motor:write", "mcp:motor:critical"]), []);
  });

  it("padrão de ferramenta da política", () => {
    assert.equal(casaPadraoFerramenta("*", "x"), true);
    assert.equal(casaPadraoFerramenta("motor_listar*", "motor_listar_leads"), true);
    assert.equal(casaPadraoFerramenta("motor_listar*", "motor_obter"), false);
    assert.equal(casaPadraoFerramenta("registrar_nota", "registrar_nota"), true);
  });
});

describe("endpoint (SSRF)", () => {
  const nega = (h: string) => assert.throws(() => validarEndpoint(h, { permitirLocal: false }), /local ou privado/, h);
  it("fora: só https e host público", () => {
    assert.ok(validarEndpoint("https://mcp.example.com/mcp", { permitirLocal: false }).startsWith("https://"));
    assert.throws(() => validarEndpoint("http://exemplo.com/mcp", { permitirLocal: false }), /https/);
    for (const h of ["http://127.0.0.1:3000/mcp", "https://localhost/mcp", "https://10.0.0.5/mcp", "https://192.168.1.1/mcp", "https://169.254.169.254/latest", "https://[::1]/mcp", "https://172.20.0.1/mcp"]) nega(h);
    for (const h of [
      "https://[::ffff:169.254.169.254]/latest", "https://[::ffff:127.0.0.1]/mcp", "https://[::ffff:7f00:1]/mcp", "https://[::]/mcp",
      "https://[::127.0.0.1]/mcp", "https://[64:ff9b::a9fe:a9fe]/mcp", "https://[2002:a9fe:a9fe::1]/mcp", "https://[fd12:3456::1]/mcp",
      "https://[fe80::1]/mcp", "https://[ff02::1]/mcp", "https://[2001:db8::1]/mcp",
      "https://100.64.0.1/mcp", "https://100.127.255.254/mcp", "https://198.18.0.1/mcp", "https://192.0.2.10/mcp", "https://224.0.0.1/mcp",
      "https://2130706433/mcp", "https://0x7f000001/mcp", "https://0177.0.0.1/mcp", "https://169.254.169.254.nip.io.localhost/mcp",
    ]) nega(h);
    for (const h of ["https://100.128.0.1/mcp", "https://198.20.0.1/mcp", "https://172.32.0.1/mcp", "https://8.8.8.8/mcp", "https://[2606:4700::1111]/mcp"])
      assert.ok(validarEndpoint(h, { permitirLocal: false }).startsWith("https://"), h);
    assert.throws(() => validarEndpoint("https://user:pass@exemplo.com/mcp", { permitirLocal: false }), /credencial/);
    assert.throws(() => validarEndpoint("ftp://exemplo.com", { permitirLocal: false }));
  });

  it("local só quando permitido (desenvolvimento e testes)", () => {
    assert.equal(validarEndpoint("http://127.0.0.1:3000/mcp", { permitirLocal: true }), "http://127.0.0.1:3000/mcp");
  });
});

describe("argumentos", () => {
  it("hash não depende da ordem das chaves", () => {
    assert.equal(hashArgumentos({ a: 1, b: { c: 2, d: [1, 2] } }), hashArgumentos({ b: { d: [1, 2], c: 2 }, a: 1 }));
    assert.notEqual(hashArgumentos({ a: 1 }), hashArgumentos({ a: 2 }));
  });

  it("redige segredo e dado pessoal, em qualquer nível", () => {
    assert.deepEqual(redigir({ lead_id: "x", api_key: "k", contato: { telefone: "21", email: "a@b" }, lista: [{ token: "t" }] }), {
      lead_id: "x", api_key: "[redigido]", contato: { telefone: "[redigido]", email: "[redigido]" }, lista: [{ token: "[redigido]" }],
    });
  });

  it("para quem aprova: telefone e e-mail mascarados em parte; segredo e CPF redigidos", () => {
    assert.deepEqual(
      paraAprovacao({
        texto: "oi", whatsapp: "+55 (21) 98765-1234", email: "joana.silva@empresa.com.br", api_key: "k", cpf: "123.456.789-00",
        contato: { telefone: 5521987651234, emails: ["a@b.com", "invalido"] }, email_token: "t", destinos: [{ celular: "12" }],
      }),
      {
        texto: "oi", whatsapp: "55219****1234", email: "j***@empresa.com.br", api_key: "[redigido]", cpf: "[redigido]",
        contato: { telefone: "55219****1234", emails: ["a***@b.com", "[redigido]"] }, email_token: "[redigido]", destinos: [{ celular: "[redigido]" }],
      },
    );
    assert.deepEqual(redigir({ whatsapp: "+55 21 98765-1234" }), { whatsapp: "[redigido]" });
  });

  it("trunca o que é grande demais para gravar; tira segredo do texto de erro", () => {
    assert.equal((paraGravar({ x: "a".repeat(10_000) }) as { truncado: boolean }).truncado, true);
    assert.deepEqual(paraGravar({ x: 1 }), { x: 1 });
    assert.equal(semSegredo("falhou com abc123", "abc123"), "falhou com [redigido]");
  });
});
