// SPDX-License-Identifier: AGPL-3.0-only
// Portado de casa-de-ia/src/core/dado-pessoal.test.ts (commit 45ba448), de vitest para node:test.
// Nomes de pessoas e campanhas reais trocados por genéricos.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { abrirEnvelope, limpar, limparResultadoDeFerramenta, temContatoNoTexto } from "./dado-pessoal.ts";

describe("nome: de pessoa sai, de curso e de consultora fica", () => {
  it("nome debaixo de identidade, lead, contato ou aluno, e na raiz, sai", () => {
    assert.deepEqual(limpar({
      nome: "Maria", identidade: { nome: "Maria Silva" }, lead: { primeiroNome: "Maria", status: "QUENTE" },
      alunos: [{ nome: "Ana", turma: "T1" }], contato: { dados: { nome: "Bia" } },
    }, 10), {
      nome: "[omitido]", identidade: { nome: "[omitido]" }, lead: { primeiroNome: "[omitido]", status: "QUENTE" },
      alunos: [{ nome: "[omitido]", turma: "T1" }], contato: { dados: { nome: "[omitido]" } },
    });
  });

  it("nome de curso, de turma e da consultora (equipe) fica: o agente precisa dele", () => {
    const r = { cursos: [{ nome: "Confeitaria", turno: "noite" }], consultora: { nome: "Joana" }, campanha: { name: "Campanha A" } };
    assert.deepEqual(limpar(r, 10), r);
  });

  it("contato sai em qualquer lugar, até debaixo de curso", () => {
    assert.deepEqual(limpar({ cursos: [{ nome: "Confeitaria", telefone: "21999998888", obs: "falar com a@b.com" }] }, 10), { cursos: [{ nome: "Confeitaria", telefone: "[omitido]", obs: "falar com [omitido]" }] });
  });
});

describe("resultado de ferramenta", () => {
  it("abre o envelope MCP e limpa; aplicar duas vezes dá o mesmo (o reaproveitado já vem limpo)", () => {
    const envelope = { content: [{ type: "text", text: JSON.stringify({ identidade: { nome: "Maria", telefone: "5521999998888" }, score: 82 }) }] };
    const uma = limparResultadoDeFerramenta(envelope);
    assert.deepEqual(uma, { identidade: { nome: "[omitido]", telefone: "[omitido]" }, score: 82 });
    assert.deepEqual(limparResultadoDeFerramenta(uma), uma);
  });

  it("structuredContent tem preferência; texto que não é JSON é mascarado como texto", () => {
    assert.deepEqual(abrirEnvelope({ structured: { a: 1 }, content: [] }), { a: 1 });
    assert.equal(limparResultadoDeFerramenta({ content: [{ type: "text", text: "ligue 21 99999-8888" }] }), "ligue ***88");
  });
});

describe("contato no texto (recusa de memória)", () => {
  it("e-mail e número de 8+ dígitos são contato; data ISO, valor e regra não são", () => {
    for (const t of ["ligar para (21) 99999-8888", "manda pra maria@exemplo.com", "CPF 123.456.789-00", "+55 21 98888 7777"]) assert.equal(temContatoNoTexto(t), true, t);
    for (const t of ["Nunca cobrar aluno no domingo.", "Desde 2026-10-04 o prazo é 48 h.", "Parcela acima de R$ 500 pede aprovação.", "Turma 2026/2"]) assert.equal(temContatoNoTexto(t), false, t);
  });
});

describe("nome dentro de lista genérica (auditoria 05/10/2026, F-M06)", () => {
  it("itens de lista sem nome de coisa são tratados como pessoa: o nome do lead sai", () => {
    const r = { ok: true, resultado: { itens: [{ id: "L1", nome: "Maria Silva", status: "QUENTE", curso: "Confeitaria" }] } };
    assert.deepEqual(limpar(r, 10), { ok: true, resultado: { itens: [{ id: "L1", nome: "[omitido]", status: "QUENTE", curso: "Confeitaria" }] } });
    assert.deepEqual(limpar([{ nome: "Ana" }], 10), [{ nome: "[omitido]" }]);
  });

  it("lista de coisa (cursos, consultoras, campanhas) mantém o nome", () => {
    const r = { consultoras: [{ nome: "Joana" }], campanhas: [{ name: "Campanha B" }], resultado: { cursos: [{ nome: "Inglês" }] } };
    assert.deepEqual(limpar(r, 10), r);
  });
});
