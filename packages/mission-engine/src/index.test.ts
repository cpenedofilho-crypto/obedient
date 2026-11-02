// SPDX-License-Identifier: AGPL-3.0-only
// Portado de casa-de-ia/src/equipes/equipes.test.ts e arquitetura.test.ts (commit 45ba448), de
// vitest para node:test. Mesmos casos de plano, estados, esquema, autonomia e delegação. Ficaram de
// fora os que dependem do banco do Growth OS (CHECKs das migrations) e dos contratos/modelos dele.
// Novo: a autonomia nunca é mais permissiva que o Policy Engine (conferido para todo risco × categoria).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decide } from "@obedient/policy-engine";
import {
  conferirValor,
  decidirAutonomia,
  ErroEquipe,
  nivelEfetivo,
  nivelExigido,
  nivelMaximoDoAgente,
  podeMissao,
  podeTarefa,
  problemasDoEsquema,
  recusaDeDelegacao,
  STATUS_MISSAO,
  STATUS_TAREFA,
  tetoDelegado,
  validarPlano,
  type AcaoAutonomia,
  type Capacidade,
  type NivelAutonomia,
} from "./index.ts";

const codigo = (f: () => unknown) => {
  try {
    f();
    return "ok";
  } catch (e) {
    return e instanceof ErroEquipe ? e.codigo : (e as Error).message;
  }
};
const no = (chave: string, depende_de: string[] = []) => ({ chave, depende_de });

describe("plano", () => {
  it("camadas respeitam as dependências e as independentes ficam juntas", () => {
    const p = validarPlano([
      no("briefing"), no("pesquisa", ["briefing"]), no("roteiro", ["pesquisa"]), no("direcao", ["roteiro"]),
      no("revisao", ["roteiro"]), no("producao", ["direcao", "revisao"]), no("performance", ["briefing"]),
    ]);
    assert.deepEqual(p.camadas, [["briefing"], ["pesquisa", "performance"], ["roteiro"], ["direcao", "revisao"], ["producao"]]);
    assert.ok(p.ordem.indexOf("producao") > p.ordem.indexOf("revisao"));
  });

  it("recusa ciclo, dependência de si, dependência fora do plano, chave repetida e plano vazio", () => {
    assert.equal(codigo(() => validarPlano([no("a", ["c"]), no("b", ["a"]), no("c", ["b"])])), "ciclo_no_plano");
    assert.equal(codigo(() => validarPlano([no("a", ["a"])])), "dependencia_de_si_mesma");
    assert.equal(codigo(() => validarPlano([no("a", ["x"])])), "dependencia_desconhecida");
    assert.equal(codigo(() => validarPlano([no("a"), no("a")])), "chave_duplicada");
    assert.equal(codigo(() => validarPlano([])), "plano_vazio");
  });

  it("ciclo só no fim do plano ainda é achado; dependência repetida conta uma vez", () => {
    assert.equal(codigo(() => validarPlano([no("a"), no("b", ["a", "c"]), no("c", ["b"])])), "ciclo_no_plano");
    assert.deepEqual(validarPlano([no("a"), no("b", ["a", "a"])]).camadas, [["a"], ["b"]]);
  });

  it("recusa plano grande demais", () => {
    assert.equal(codigo(() => validarPlano(Array.from({ length: 31 }, (_, i) => no(`t${i}`)))), "plano_grande_demais");
  });
});

describe("estados", () => {
  it("terminal não sai; só o plano aprovado (planning) leva a pending", () => {
    for (const s of ["completed", "failed", "cancelled"] as const) {
      assert.deepEqual(STATUS_MISSAO.filter((p) => podeMissao(s, p)), []);
      assert.deepEqual(STATUS_TAREFA.filter((p) => podeTarefa(s, p)), []);
    }
    assert.deepEqual(STATUS_MISSAO.filter((s) => podeMissao(s, "pending")), ["planning"]);
  });

  it("tarefa: pending não pula para running; blocked só volta por ready", () => {
    assert.equal(podeTarefa("pending", "running"), false);
    assert.equal(podeTarefa("pending", "completed"), false);
    assert.equal(podeTarefa("blocked", "running"), false);
    assert.equal(podeTarefa("blocked", "ready"), true);
    assert.equal(podeTarefa("waiting_approval", "completed"), true);
    assert.equal(podeMissao("waiting_approval", "completed"), true);
  });
});

describe("esquema do contrato de agente", () => {
  const esquema = {
    type: "object", additionalProperties: false, required: ["publico"],
    properties: { publico: { type: "string", maxLength: 50 }, canais: { type: "array", maxItems: 2, items: { type: "string", enum: ["reels", "stories"] } } },
  };

  it("aceita o subconjunto e recusa palavra-chave que seria ignorada em silêncio", () => {
    assert.deepEqual(problemasDoEsquema(esquema), []);
    assert.match(problemasDoEsquema({ type: "object", properties: { x: { type: "string", pattern: "^a" } } })[0] ?? "", /pattern/);
    assert.match(problemasDoEsquema({ type: "array" })[0] ?? "", /raiz/);
    assert.match(problemasDoEsquema({ type: "object", additionalProperties: true })[0] ?? "", /additionalProperties/);
  });

  it("confere valor: obrigatório, tipo, enum, tamanho, campo não previsto", () => {
    assert.deepEqual(conferirValor(esquema, { publico: "restaurantes", canais: ["reels"] }), []);
    assert.deepEqual(conferirValor(esquema, {}), ["$.publico: obrigatório"]);
    assert.deepEqual(conferirValor(esquema, { publico: 3 }), ["$.publico: esperado string"]);
    assert.deepEqual(conferirValor(esquema, { publico: "x", canais: ["tv"] }), ["$.canais[0]: fora dos valores permitidos"]);
    assert.deepEqual(conferirValor(esquema, { publico: "x".repeat(51) }), ["$.publico: mais de 50 caracteres"]);
    assert.deepEqual(conferirValor(esquema, { publico: "x", extra: 1 }), ["$.extra: campo não previsto"]);
    assert.deepEqual(conferirValor({ type: "object", properties: { n: { type: "integer" } } }, { n: 1.5 }), ["$.n: esperado integer"]);
  });
});

const ferramenta = (risco: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL", categoria: string | null = null): AcaoAutonomia => ({ tipo: "ferramenta", risco, categoria: categoria as never });

describe("níveis de autonomia", () => {
  it("o nível exigido sobe com risco e categoria", () => {
    assert.equal(nivelExigido(ferramenta("LOW", "READ")), 0);
    assert.equal(nivelExigido({ tipo: "artefato" }), 1);
    assert.equal(nivelExigido(ferramenta("LOW", "WRITE")), 2);
    assert.equal(nivelExigido(ferramenta("MEDIUM")), 2);
    assert.equal(nivelExigido(ferramenta("MEDIUM", "COMMUNICATION")), 3);
    assert.equal(nivelExigido(ferramenta("HIGH")), 3);
    assert.equal(nivelExigido(ferramenta("MEDIUM", "FINANCIAL")), 4);
    assert.equal(nivelExigido(ferramenta("LOW", "DESTRUCTIVE")), 4);
    assert.equal(nivelExigido(ferramenta("CRITICAL")), 4);
  });

  it("nível 3 e 4 nunca são autônomos; abaixo do exigido é negado sem pedir aprovação", () => {
    assert.equal(decidirAutonomia(4, ferramenta("HIGH")), "exige_aprovacao");
    assert.equal(decidirAutonomia(4, ferramenta("CRITICAL")), "exige_aprovacao_privilegiada");
    assert.equal(decidirAutonomia(2, ferramenta("HIGH")), "negado");
    assert.equal(decidirAutonomia(1, ferramenta("MEDIUM")), "negado");
    assert.equal(decidirAutonomia(1, { tipo: "artefato" }), "permitido");
    assert.equal(decidirAutonomia(0, { tipo: "artefato" }), "negado");
    assert.equal(decidirAutonomia(0, ferramenta("LOW", "READ")), "permitido");
  });

  it("efetivo é o menor teto; sem teto, observação; o risco do agente limita a autonomia", () => {
    assert.equal(nivelEfetivo(4, 2, 3), 2);
    assert.equal(nivelEfetivo(3, null, undefined), 3);
    assert.equal(nivelEfetivo(), 0);
    assert.deepEqual(["LOW", "MEDIUM", "HIGH", "CRITICAL", "x"].map(nivelMaximoDoAgente), [1, 2, 3, 4, 0]);
  });
});

describe("delegação", () => {
  const coordenador: Capacidade = { ferramentas: ["github/ler", "github/abrir_pr"], permissoes: ["mcp:github:read"], riscoMaximo: "MEDIUM", autonomia: 2 };
  const developer: Capacidade = { ferramentas: ["github/ler", "github/merge", "github/abrir_pr"], permissoes: ["mcp:github:read", "mcp:github:write"], riscoMaximo: "CRITICAL", autonomia: 4 };

  it("o convocado nunca ganha o que o coordenador não tem", () => {
    assert.deepEqual(tetoDelegado(coordenador, developer), { ferramentas: ["github/ler", "github/abrir_pr"], permissoes: ["mcp:github:read"], riscoMaximo: "MEDIUM", autonomia: 2 });
    assert.deepEqual(tetoDelegado(developer, coordenador), coordenador);
  });

  it("permissão com curinga: fica a mais estreita dos dois, nunca a mais larga", () => {
    const amplo: Capacidade = { ...coordenador, permissoes: ["mcp:github:*"] };
    assert.deepEqual(tetoDelegado(amplo, developer).permissoes, ["mcp:github:read", "mcp:github:write"]);
    assert.deepEqual(tetoDelegado(coordenador, { ...developer, permissoes: ["*"] }).permissoes, ["mcp:github:read"]);
    assert.deepEqual(tetoDelegado({ ...coordenador, permissoes: ["mcp:outro:*"] }, developer).permissoes, []);
  });

  it("delegação respeita quem pode delegar, a profundidade e o número de convocações", () => {
    const base = { profundidadeAtual: 0, maxProfundidade: 1, delegacoesUsadas: 0, maxDelegacoes: 3, podeDelegar: true };
    assert.equal(recusaDeDelegacao(base), null);
    assert.equal(recusaDeDelegacao({ ...base, podeDelegar: false }), "agente_nao_delega");
    assert.equal(recusaDeDelegacao({ ...base, profundidadeAtual: 1 }), "profundidade_maxima");
    assert.equal(recusaDeDelegacao({ ...base, delegacoesUsadas: 3 }), "delegacoes_esgotadas");
  });
});

describe("autonomia só restringe (ligação com o Policy Engine do OBEDIENT)", () => {
  // Força de cada desfecho: quanto maior, mais livre.
  const liberdadeAutonomia = { negado: 0, exige_aprovacao_privilegiada: 1, exige_aprovacao: 2, permitido: 3 } as const;
  const liberdadePolitica = { deny: 0, require_privileged_approval: 1, require_approval: 2, allow: 3 } as const;
  const RISCOS = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
  const CATEGORIAS = [null, "READ", "WRITE", "COMMUNICATION", "FINANCIAL", "LEGAL", "DESTRUCTIVE"] as const;

  it("para todo risco × categoria × nível, a autonomia nunca libera mais do que o padrão da política", () => {
    for (const risco of RISCOS)
      for (const categoria of CATEGORIAS)
        for (const nivel of [0, 1, 2, 3, 4] as NivelAutonomia[]) {
          const aut = decidirAutonomia(nivel, ferramenta(risco, categoria));
          const pol = decide({
            systemId: "s", tool: "t", risk: risco, ...(categoria ? { category: categoria } : {}),
            principal: { kind: "agent", id: "a", role: null }, args: {}, context: {},
          }, []);
          assert.ok(
            liberdadeAutonomia[aut] <= liberdadePolitica[pol.effect],
            `${risco}/${categoria}/nível ${nivel}: autonomia ${aut} × política ${pol.effect}`,
          );
        }
  });

  it("onde a política exige pessoa com autenticação forte, a autonomia nunca dispensa", () => {
    for (const categoria of ["FINANCIAL", "LEGAL", "DESTRUCTIVE"] as const)
      for (const nivel of [0, 1, 2, 3, 4] as NivelAutonomia[])
        assert.notEqual(decidirAutonomia(nivel, ferramenta("LOW", categoria)), "permitido", `${categoria}/${nivel}`);
  });
});
