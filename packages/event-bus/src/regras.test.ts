// SPDX-License-Identifier: AGPL-3.0-only
// Portado de casa-de-ia/src/event-bus/regras.test.ts (commit 45ba448), de vitest para node:test.
// Mesmos casos. Ficou de fora o "contrato HTTP" (api.ts, que depende de zod e da rota do Growth OS).
// Como validarEvento agora recebe o vocabulário, os casos usam um vocabulário de teste com os tipos
// que o teste original usava.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hashDoToken, identificarProdutor, lerProdutores } from "./produtores.ts";
import { casa, chavePessoal, esperaAntesDaProxima, validarEvento, valorPessoal, ESPERA_MAXIMA_S, REGEX_PADRAO, REGEX_TIPO } from "./regras.ts";
import { ErroBarramento, type NovoEvento } from "./tipos.ts";
import { criarVocabulario } from "./vocabulario.ts";

const VOCAB = criarVocabulario({
  fontes: ["motor", "recupera-os", "growth-os"],
  entidades: ["contact", "organization", "business_unit", "payment", "company"],
  entidadesInternas: ["organization", "business_unit", "contact"],
  somenteInternas: ["organization", "business_unit"],
  tipos: [
    { tipo: "payment.overdue", entidades: ["payment"], descricao: "t" },
    { tipo: "lead.updated", entidades: ["contact"], descricao: "t" },
    { tipo: "company.created", entidades: ["organization", "company"], descricao: "t" },
  ],
});
const FONTES = VOCAB.fontes;
const ok: NovoEvento = { type: "payment.overdue", entityType: "payment", entityExternalId: "parcela-1" };
const UUID = "4d0f6b9e-9a0b-4f8e-9d1e-1a2b3c4d5e6f";

describe("formato de tipo e filtro", () => {
  it("aceita os tipos da missão e os do conector do Motor", () => {
    for (const t of ["lead.created", "lead.no_response", "company.diagnostic.completed", "roi.target_reached", "lead_created", "followup_sent"]) assert.equal(REGEX_TIPO.test(t), true, t);
    for (const t of ["Lead.created", "lead.", ".lead", "lead..x", "lead-created", "lead.*"]) assert.equal(REGEX_TIPO.test(t), false, t);
  });

  it("filtro aceita '*', tipo exato e prefixo", () => {
    for (const p of ["*", "lead.created", "lead.*", "company.diagnostic.*"]) assert.equal(REGEX_PADRAO.test(p), true, p);
    for (const p of ["lead*", "*.created", "lead.*.x", ""]) assert.equal(REGEX_PADRAO.test(p), false, p);
  });

  it("casa por exato, prefixo e curinga, sem pegar vizinho", () => {
    assert.equal(casa(["lead.*"], "lead.no_response"), true);
    assert.equal(casa(["lead.*"], "leads.created"), false);
    assert.equal(casa(["lead.*"], "lead"), false);
    assert.equal(casa(["company.diagnostic.*"], "company.diagnostic.completed"), true);
    assert.equal(casa(["company.diagnostic.*"], "company.created"), false);
    assert.equal(casa(["payment.received"], "payment.overdue"), false);
    assert.equal(casa(["*"], "qualquer.coisa"), true);
  });
});

describe("espera entre tentativas", () => {
  it("dobra a cada tentativa e para em 6 horas", () => {
    assert.deepEqual([1, 2, 3, 4].map((n) => esperaAntesDaProxima(n, 30)), [30, 60, 120, 240]);
    assert.equal(esperaAntesDaProxima(30, 30), ESPERA_MAXIMA_S);
  });
});

describe("validarEvento", () => {
  const recusa = (e: Partial<NovoEvento>, re: RegExp | typeof ErroBarramento) => assert.throws(() => validarEvento({ ...ok, ...e } as NovoEvento, VOCAB), re);

  it("aceita o evento mínimo", () => assert.doesNotThrow(() => validarEvento(ok, VOCAB)));

  it("recusa tipo, entidade e prioridade fora da regra", () => {
    recusa({ type: "Payment.Overdue" }, ErroBarramento);
    recusa({ entityType: "boleto" }, /vocabulário/);
    recusa({ priority: 10 }, /0 a 9/);
  });

  it("exige exatamente um identificador de entidade", () => {
    recusa({ entityExternalId: undefined }, /exatamente um/);
    recusa({ entityId: UUID }, /exatamente um/);
  });

  it("id interno só para entidade com tabela aqui", () => {
    recusa({ entityExternalId: undefined, entityId: UUID }, /não tem tabela/);
    assert.doesNotThrow(() => validarEvento({ type: "lead.updated", entityType: "contact", entityId: UUID }, VOCAB));
    assert.throws(() => validarEvento({ type: "company.created", entityType: "organization", entityExternalId: "x" }, VOCAB), /só aceita entity_id/);
  });

  it("recusa dado pessoal no payload, inclusive aninhado", () => {
    recusa({ payload: { aluno: { Telefone: "21999" } } }, /dado pessoal \(aluno.Telefone\)/);
    recusa({ metadata: { contatos: [{ email: "a@b" }] } }, /contatos\[0\].email/);
    assert.equal(chavePessoal({ valor: 120, dias_atraso: 8 }), null);
  });

  it("recusa dado pessoal pelo VALOR, sob chave neutra (o buraco do valor_depois)", () => {
    recusa({ metadata: { valor_depois: "21999998888" } }, /valor_depois: parece telefone/);
    recusa({ metadata: { valor_depois: "(21) 99999-8888" } }, /parece telefone/);
    recusa({ payload: { obs: "escrever para ana@exemplo.com.br" } }, /obs: parece e-mail/);
    recusa({ payload: { lista: ["ok", "123.456.789-09"] } }, /lista\[1\]: parece cpf/);
  });

  it("a recusa cita o caminho, nunca o valor", () => {
    assert.throws(
      () => validarEvento({ ...ok, metadata: { valor_depois: "21999998888" } }, VOCAB),
      (e: unknown) => e instanceof Error && !e.message.includes("21999998888"),
    );
  });

  it("não confunde dado pessoal com o que o barramento carrega de verdade", () => {
    const neutros = {
      quando: "2026-10-04T05:50:22.000Z", data: "2026-10-04", id: UUID,
      mascarado: "***88", status: "QUENTE", valor: 1200.5, dias_atraso: 8, ms: 1759555822000, parcela: "parcela-12",
      anuncio: "120212345678901234", versao: "v1.2.3", hora: "05:50", cursor: "MjAyNi0xMC0wNFQwNTo1MDoyMnxhYmM",
    };
    assert.equal(valorPessoal(neutros), null);
  });

  it("UUID e hash não são telefone, mas telefone ao lado de um id continua sendo", () => {
    assert.equal(valorPessoal({ agent_id: "67c03b46-b40a-48d1-b1a6-e6251096243c", artefato_id: "8f6c3a3e-0d6e-4a55-9a4a-a12345678901" }), null);
    assert.equal(valorPessoal({ hash: "97647440161c15e669f3aa81b501656fda72cc0969da41b97cf883bb3cc1b057" }), null);
    assert.match(valorPessoal({ obs: "lead 67c03b46-b40a-48d1-b1a6-e6251096243c ligar 21999998888" }) ?? "", /parece telefone/);
  });

  it("id de anúncio (10 a 12 dígitos) sob a chave de anúncio não é telefone; em outra chave, ou com máscara, continua sendo", () => {
    assert.equal(valorPessoal({ anuncio_plataforma: "google", campanha_id: "21999998888", conjunto_id: "123456789012", anuncio_id: "634567890123" }), null);
    assert.match(valorPessoal({ campanha_id: "(21) 99999-8888" }) ?? "", /campanha_id: parece telefone/);
    assert.match(valorPessoal({ campanha_id: "+5521999998888" }) ?? "", /parece telefone/);
    assert.match(valorPessoal({ obs: "21999998888", campanha_id: "1" }) ?? "", /obs: parece telefone/);
  });

  it("recusa payload grande demais", () => recusa({ payload: { x: "a".repeat(40_000) } }, /maior que/));

  it("fonte que não pode publicar o tipo é recusada", () => {
    const v = criarVocabulario({ fontes: ["a", "b"], entidades: ["x"], entidadesInternas: [], tipos: [{ tipo: "x.feito", entidades: ["x"], fontes: ["a"], descricao: "t" }] });
    const e = { type: "x.feito", entityType: "x", entityExternalId: "1" };
    assert.doesNotThrow(() => validarEvento(e, v, 0, "a"));
    assert.throws(() => validarEvento(e, v, 0, "b"), /a fonte "b" não pode publicar/);
  });
});

describe("produtores (token → organização e fonte)", () => {
  const token = "segredo-do-recupera";
  const env = `${hashDoToken(token)}:escola-a:recupera-os, ${"0".repeat(64)}:outra:motor, malformado, ${"f".repeat(64)}:escola-a:fonte-inventada`;

  it("lê só as entradas válidas", () => {
    assert.deepEqual(lerProdutores(env, FONTES).map((p) => `${p.orgSlug}/${p.source}`), ["escola-a/recupera-os", "outra/motor"]);
  });

  it("identifica pelo token e recusa o resto", () => {
    assert.deepEqual(identificarProdutor(`Bearer ${token}`, env, FONTES), { orgSlug: "escola-a", source: "recupera-os" });
    assert.equal(identificarProdutor("Bearer outro", env, FONTES), null);
    assert.equal(identificarProdutor(token, env, FONTES), null);
    assert.equal(identificarProdutor(null, env, FONTES), null);
    assert.equal(identificarProdutor(`Bearer ${token}`, undefined, FONTES), null);
  });
});
