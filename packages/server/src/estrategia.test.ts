// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ANALISAR_JOGO, ferramentaAnalisarJogo, executarAnaliseJogo } from "./estrategia.ts";

const dilema = {
  origem: "hipotese",
  jogadores: [
    { nome: "IGA", estrategias: ["manter", "reduzir"] },
    { nome: "Concorrente", estrategias: ["manter", "reduzir"] },
  ],
  resultados: [
    { perfil: [0, 0], payoffs: [30, 30] },
    { perfil: [0, 1], payoffs: [10, 40] },
    { perfil: [1, 0], payoffs: [40, 10] },
    { perfil: [1, 1], payoffs: [15, 15] },
  ],
};

describe("ferramenta interna de análise estratégica", () => {
  it("expõe contrato fechado e não pode executar ações", () => {
    assert.equal(ferramentaAnalisarJogo.definicao.name, ANALISAR_JOGO);
    assert.equal(ferramentaAnalisarJogo.chave, "obedient/analisar_jogo");
    assert.equal(ferramentaAnalisarJogo.definicao.input_schema.additionalProperties, false);
    assert.equal((ferramentaAnalisarJogo as { categoria?: string }).categoria, undefined);
  });

  it("retorna matemática reproduzível com aviso sobre hipóteses", () => {
    const r = executarAnaliseJogo({ ...dilema, referencias: [{ tipo: "simulacao", descricao: "Exemplo de aula", identificador: "cenario-a" }] });
    assert.equal(r.status, "succeeded");
    assert.deepEqual((r.resultado as { nash: number[][] }).nash, [[1, 1]]);
    assert.match((r.resultado as { aviso: string }).aviso, /hipotético/i);
    assert.deepEqual((r.resultado as { referencias: unknown[] }).referencias, [{ tipo: "simulacao", descricao: "Exemplo de aula", identificador: "cenario-a" }]);
    assert.equal((r.resultado as { verificacao: string }).verificacao, "referencias_declaradas_nao_verificadas");
  });

  it("confirma somente identificadores de leitura emitidos pelo executor, sem validar payoffs", () => {
    const referencias = [
      { tipo: "integracao", descricao: "Consulta autorizada", identificador: "leitura:real" },
      { tipo: "integracao", descricao: "Consulta inventada", identificador: "leitura:inventada" },
      { tipo: "usuario", descricao: "Texto do usuário", identificador: "leitura:real" },
    ];
    const r = executarAnaliseJogo({ ...dilema, origem: "dados_fornecidos", referencias }, [
      { identificador: "leitura:real", ferramenta: "google/consultar" },
    ]);
    assert.equal(r.status, "succeeded");
    const resultado = r.resultado as { verificacao: string; referencias_conferidas: unknown[]; aviso: string };
    assert.equal(resultado.verificacao, "execucao_de_leitura_confirmada_conteudo_nao_validado");
    assert.deepEqual(resultado.referencias_conferidas, [{ identificador: "leitura:real", ferramenta: "google/consultar", status: "execucao_de_leitura_confirmada" }]);
    assert.match(resultado.aviso, /exatidão não foi verificada/);
    const semProva = executarAnaliseJogo({ ...dilema, referencias });
    assert.equal((semProva.resultado as { verificacao: string }).verificacao, "referencias_declaradas_nao_verificadas");
  });

  it("falha fechado quando faltam dados, aparecem campos inesperados ou origem incorreta", () => {
    assert.equal(executarAnaliseJogo({ ...dilema, origem: "certeza" }).status, "tool_error");
    assert.equal(executarAnaliseJogo({ ...dilema, executar: true }).status, "tool_error");
    assert.equal(executarAnaliseJogo({ ...dilema, resultados: dilema.resultados.slice(1) }).status, "tool_error");
    assert.equal(executarAnaliseJogo({ ...dilema, jogadores: [null, null] }).status, "tool_error");
    assert.equal(executarAnaliseJogo({ ...dilema, referencias: [{ tipo: "integracao", descricao: "x", identificador: "" }] }).status, "tool_error");
    assert.equal(executarAnaliseJogo({ ...dilema, referencias: [{ tipo: "desconhecido", descricao: "x", identificador: "id" }] }).status, "tool_error");
  });
});
