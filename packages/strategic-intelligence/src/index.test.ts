// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { test } from "node:test";
import { analisarJogo, type Jogo } from "./index.ts";

const dilema: Jogo = {
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

test("dilema: Nash diferente de eficiência de Pareto", () => {
  const r = analisarJogo(dilema);
  assert.deepEqual(r.nash, [[1, 1]]);
  assert.deepEqual(r.pareto, [[0, 0], [0, 1], [1, 0]]);
  assert.deepEqual(r.estrategiasRestantes, [[1], [1]]);
  assert.equal(r.eliminacoes.length, 2);
});

test("jogo de coordenação tem dois equilíbrios", () => {
  const jogo: Jogo = { ...dilema, resultados: [
    { perfil: [0, 0], payoffs: [3, 3] }, { perfil: [0, 1], payoffs: [0, 0] },
    { perfil: [1, 0], payoffs: [0, 0] }, { perfil: [1, 1], payoffs: [2, 2] },
  ] };
  assert.deepEqual(analisarJogo(jogo).nash, [[0, 0], [1, 1]]);
});

test("pedra-papel-tesoura não possui Nash puro", () => {
  const escolhas = ["pedra", "papel", "tesoura"];
  const jogo: Jogo = {
    jogadores: [0, 1].map((i) => ({ nome: String(i), estrategias: escolhas })),
    resultados: escolhas.flatMap((_, a) => escolhas.map((__, b) => {
      const ganho = a === b ? 0 : (a - b + 3) % 3 === 1 ? 1 : -1;
      return { perfil: [a, b], payoffs: [ganho, -ganho] };
    })),
  };
  const r = analisarJogo(jogo);
  assert.deepEqual(r.nash, []);
  assert.deepEqual(r.eliminacoes, []);
  assert.equal(r.pareto.length, 9);
});

test("rejeita matriz incompleta, duplicada ou payoffs inválidos", () => {
  assert.throws(() => analisarJogo({ ...dilema, resultados: dilema.resultados.slice(1) }), /incompleta/);
  assert.throws(() => analisarJogo({ ...dilema, resultados: [...dilema.resultados.slice(0, 3), dilema.resultados[0]!] }), /duplicado/);
  assert.throws(() => analisarJogo({ ...dilema, resultados: [...dilema.resultados.slice(0, 3), { perfil: [1, 1], payoffs: [NaN, 2] }] }), /inválido/);
});
