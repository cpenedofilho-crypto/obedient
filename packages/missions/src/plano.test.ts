// SPDX-License-Identifier: AGPL-3.0-only
//
// O plano da missão (D20, M5): o plano confere (DAG), a pessoa aprova pelo hash, as tarefas seguem as
// dependências, e "feito" só com todas as tarefas feitas.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ManualClock } from "@obedient/core";
import { AuditTrail, EthicsEngine, InMemoryAuditSink } from "@obedient/ethics-engine";
import { InMemoryMissionStore, Missoes, hashDoPlano, lerTarefas, tarefasProntas } from "./index.ts";

const T = (chave: string, ...dependeDe: string[]) => ({ chave, titulo: `Fazer ${chave}`, depende_de: dependeDe });
const PLANO = [T("ler"), T("resumir", "ler"), T("avisar", "resumir")];
/** As tarefas já conferidas (o teste quebra se não conferirem). */
const tarefas = (v: unknown) => {
  const l = lerTarefas(v);
  if (!("tarefas" in l)) throw new Error(l.problemas.join("; "));
  return l.tarefas;
};

describe("plano: conferência (D20, M5)", () => {
  it("aceita um DAG e devolve as tarefas; recusa ciclo, dependência desconhecida, chave ruim, título curto, campo a mais e plano grande", () => {
    const ok = lerTarefas(PLANO);
    assert.ok("tarefas" in ok);
    assert.deepEqual(ok.tarefas.map((t) => t.dependeDe), [[], ["ler"], ["resumir"]]);
    for (const [plano, re] of [
      [[T("a", "b"), T("b", "a")], /ciclo/],
      [[T("a", "z")], /não está no plano/],
      [[T("a", "a")], /si mesma/],
      [[T("A")], /chave/],
      [[{ chave: "a", titulo: "x", depende_de: [] }], /título/],
      [[{ ...T("a"), prioridade: 1 }], /campo não previsto/],
      [Array.from({ length: 31 }, (_, i) => T(`t${i}`)), /no máximo 30/],
      [[], /ao menos uma/],
      ["não é lista", /lista/],
      [[T("a"), T("a")], /mais de uma vez/],
    ] as const)
      assert.match(JSON.stringify(lerTarefas(plano)), re, JSON.stringify(plano).slice(0, 60));
  });

  it("tarefas prontas: as não feitas com todas as dependências feitas", () => {
    const l = lerTarefas(PLANO);
    assert.ok("tarefas" in l);
    const plano = { versao: 1, hash: hashDoPlano(l.tarefas), aprovadoEm: new Date(), tarefas: l.tarefas };
    assert.deepEqual(tarefasProntas(plano, new Set()).map((t) => t.chave), ["ler"]);
    assert.deepEqual(tarefasProntas(plano, new Set(["ler"])).map((t) => t.chave), ["resumir"]);
  });
});

describe("missão com plano (D20, M5)", () => {
  const setup = () => {
    const clock = new ManualClock(new Date("2026-11-19T12:00:00Z"));
    const sink = new InMemoryAuditSink();
    const missoes = new Missoes(new InMemoryMissionStore(), new EthicsEngine({ clock, audit: new AuditTrail(sink, clock) }), clock);
    return { clock, sink, missoes };
  };
  const planejada = async (missoes: Missoes) => {
    const m = await missoes.criar("ana", "obedient", "Resumir os e-mails e me avisar", { planejar: true });
    let estadoNaTentativa = "";
    const fim = await missoes.avancar(m.id, async (x) => ((estadoNaTentativa = x.estado), { tipo: "plano", tarefas: tarefas(PLANO), custoCentavos: 2 } as never));
    return { m, fim, estadoNaTentativa };
  };

  it("sem 'planejar', nada muda: a primeira tentativa já executa", async () => {
    const { missoes } = setup();
    const m = await missoes.criar("ana", "obedient", "x");
    let estado = "";
    await missoes.avancar(m.id, async (x) => ((estado = x.estado), { tipo: "nao_consegui", explicacao: "não", custoCentavos: 1 }));
    assert.equal(estado, "running");
  });

  it("planejar: a tentativa é do planejador (planning); o plano espera a pessoa e o agendador não anda sem ela", async () => {
    const { missoes, sink } = setup();
    const { fim, estadoNaTentativa } = await planejada(missoes);
    assert.equal(estadoNaTentativa, "planning");
    assert.equal(fim.estado, "waiting_approval");
    assert.deepEqual(fim.plano?.tarefas.map((t) => t.chave), ["ler", "resumir", "avisar"]);
    assert.equal(fim.plano?.aprovadoEm, null);
    assert.equal(fim.plano?.hash, hashDoPlano(fim.plano!.tarefas));
    assert.equal((await missoes.reservar(fim.id)).reservada, false, "sem aprovação, não anda");
    assert.ok((await sink.entries("ana")).some((e) => e.event === "mission.plan_proposed"));
  });

  it("aprovar pelo hash: hash diferente é recusado; o certo libera uma tentativa de execução", async () => {
    const { missoes } = setup();
    const { fim } = await planejada(missoes);
    await assert.rejects(missoes.aprovarPlano("ana", fim.id, "0".repeat(64)), /o plano mudou/);
    await assert.rejects(missoes.aprovarPlano("bia", fim.id, fim.plano!.hash), /inexistente/);
    await missoes.aprovarPlano("ana", fim.id, fim.plano!.hash);
    await assert.rejects(missoes.aprovarPlano("ana", fim.id, fim.plano!.hash), /não há plano esperando/, "uma vez só");
    const r = await missoes.reservar(fim.id);
    assert.ok(r.reservada);
    assert.deepEqual([r.missao.estado, r.missao.tentativas], ["running", 2]);
  });

  it("tarefas seguem as dependências; 'feito' sem todas para a missão; com todas, termina", async () => {
    const { missoes } = setup();
    const { fim } = await planejada(missoes);
    await missoes.aprovarPlano("ana", fim.id, fim.plano!.hash);
    const r = await missoes.reservar(fim.id);
    assert.ok(r.reservada);
    assert.deepEqual(await missoes.marcarTarefaFeita(r.missao, "resumir"), { ok: false, motivo: "antes desta, termine: ler" });
    assert.deepEqual(await missoes.marcarTarefaFeita(r.missao, "inventada"), { ok: false, motivo: 'não há tarefa "inventada" no plano' });
    assert.ok((await missoes.marcarTarefaFeita(r.missao, "ler")).ok);
    assert.ok((await missoes.marcarTarefaFeita(r.missao, "resumir")).ok);
    const parada = await missoes.concluir(r.missao, { tipo: "feito", explicacao: "Pronto.", evidencias: [{ criterio: null, tipo: "plano_completo", ok: true, referencia: null, detalhe: "o agente disse" }], custoCentavos: 1 });
    assert.equal(parada.estado, "blocked", "a evidência do agente não vale: a missão confere pelo que está gravado");
    assert.match(parada.impedimento!, /Faltam 1 tarefa\(s\) do plano: Fazer avisar/);
    await missoes.tentarDeNovo("ana", parada.id);
    const r2 = await missoes.reservar(parada.id);
    assert.ok(r2.reservada);
    assert.equal(r2.missao.estado, "running", "o plano aprovado continua valendo");
    assert.ok((await missoes.marcarTarefaFeita(r2.missao, "avisar")).ok);
    const ok = await missoes.concluir(r2.missao, { tipo: "feito", explicacao: "Pronto.", custoCentavos: 1 });
    assert.equal(ok.estado, "completed");
    assert.deepEqual((await missoes.evidencias(ok.id)).at(-1)!.tipo, "plano_completo");
  });

  it("recusar o plano para a missão; tentar de novo planeja outra vez, com outra versão", async () => {
    const { missoes } = setup();
    const { fim } = await planejada(missoes);
    const recusada = await missoes.recusarPlano("ana", fim.id);
    assert.deepEqual([recusada.estado, recusada.plano], ["blocked", null]);
    await missoes.tentarDeNovo("ana", fim.id);
    let estado = "";
    const de2 = await missoes.avancar(fim.id, async (x) => ((estado = x.estado), { tipo: "plano", tarefas: tarefas([T("so_uma")]), custoCentavos: 1 } as never));
    assert.equal(estado, "planning");
    assert.deepEqual([de2.plano?.versao, de2.plano?.tarefas.length], [2, 1]);
  });

  it("o planejador que não entrega plano é falha passageira; plano entregue fora de hora também", async () => {
    const { missoes } = setup();
    const m = await missoes.criar("ana", "obedient", "x", { planejar: true });
    const f = await missoes.avancar(m.id, async () => ({ tipo: "feito", explicacao: "fiz tudo", custoCentavos: 1 }));
    assert.equal(f.estado, "retrying");
    const n = await missoes.criar("ana", "obedient", "y");
    const g = await missoes.avancar(n.id, async () => ({ tipo: "plano", tarefas: tarefas(PLANO), custoCentavos: 1 } as never));
    assert.deepEqual([g.estado, g.plano], ["retrying", null]);
  });

  it("plano que não confere, mesmo vindo do executor, para a missão sem gravar plano", async () => {
    const { missoes } = setup();
    const m = await missoes.criar("ana", "obedient", "x", { planejar: true });
    const f = await missoes.avancar(m.id, async () => ({ tipo: "plano", tarefas: [{ chave: "a", titulo: "Fazer a", dependeDe: ["a"] }], custoCentavos: 1 }));
    assert.deepEqual([f.estado, f.plano], ["blocked", null]);
    assert.match(f.impedimento!, /não confere/);
  });
});
