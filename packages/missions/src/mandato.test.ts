// SPDX-License-Identifier: AGPL-3.0-only
//
// Mandato e teto do mês (D20, M4; D21): o mandato só estreita, o prazo final encerra a missão, e o
// mês é o do Brasil.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ManualClock } from "@obedient/core";
import { AuditTrail, EthicsEngine, InMemoryAuditSink } from "@obedient/ethics-engine";
import { InMemoryMissionStore, Missoes, TETO_MENSAL_CENTAVOS, cabeNoMandato, inicioDoMes, lerMandato, problemasDoMandato } from "./index.ts";

const T0 = new Date("2026-11-19T12:00:00Z");

describe("mandato (D20, M4)", () => {
  it("validação: lista não vazia sem curinga, até 30, prazo no futuro e até 30 dias, sem campo a mais", () => {
    assert.deepEqual(problemasDoMandato(undefined, T0), []);
    assert.deepEqual(problemasDoMandato({ ferramentas: ["gmail/*", "google_agenda/google_agenda.listar_eventos"], prazoFinalEm: new Date(T0.getTime() + 3_600_000) }, T0), []);
    for (const [m, re] of [
      [{ ferramentas: [] }, /lista não vazia/],
      [{ ferramentas: ["*"] }, /3 a 200/],
      [{ ferramentas: ["gm*"] }, /3 a 200/],
      [{ ferramentas: Array.from({ length: 31 }, (_, i) => `gmail/f${i}`) }, /no máximo 30/],
      [{ prazoFinalEm: T0 }, /no futuro/],
      [{ prazoFinalEm: new Date(T0.getTime() + 31 * 24 * 3_600_000) }, /30 dias/],
      [{ prazoFinalEm: "amanhã" }, /inválido/],
      [{ autonomia: "total" }, /campo não previsto/],
      [[], /objeto/],
    ] as const)
      assert.match(problemasDoMandato(m, T0).join(" | "), re, JSON.stringify(m));
  });

  it("cabeNoMandato: nome exato ou prefixo; sem lista, tudo o que os grants deixarem", () => {
    const m = lerMandato({ ferramentas: ["google_agenda/*", "gmail/gmail.ler"] });
    assert.equal(cabeNoMandato(m, "google_agenda/google_agenda.apagar_evento"), true);
    assert.equal(cabeNoMandato(m, "gmail/gmail.ler"), true);
    assert.equal(cabeNoMandato(m, "gmail/gmail.enviar"), false);
    assert.equal(cabeNoMandato(m, "google_agendaX/x"), false, "prefixo é do texto inteiro, com a barra");
    assert.equal(cabeNoMandato(lerMandato(undefined), "qualquer/coisa"), true);
  });

  it("ambientes (M5): lista sem repetição de produção, homologação e teste; ferramenta sem ambiente é produção", () => {
    assert.deepEqual(problemasDoMandato({ ambientes: ["homologacao", "teste"] }, T0), []);
    for (const amb of [[], ["prod"], ["teste", "teste"], "teste"]) assert.match(problemasDoMandato({ ambientes: amb }, T0).join(" | "), /ambientes/, JSON.stringify(amb));
    const m = lerMandato({ ambientes: ["homologacao"] });
    assert.equal(cabeNoMandato(m, "recupera_homolog/x.ler", "homologacao"), true);
    assert.equal(cabeNoMandato(m, "google_agenda/google_agenda.listar_eventos"), false, "sem ambiente declarado = produção");
    assert.equal(cabeNoMandato(lerMandato({ ambientes: ["homologacao"], ferramentas: ["gmail/*"] }), "recupera/x", "homologacao"), false, "as duas restrições valem juntas");
    assert.deepEqual(lerMandato(undefined).ambientes, null);
  });

  it("o mês é o do Brasil (UTC−3): 1º de dezembro às 01h UTC ainda é novembro", () => {
    assert.equal(inicioDoMes(new Date("2026-12-01T01:00:00Z")).toISOString(), "2026-11-01T03:00:00.000Z");
    assert.equal(inicioDoMes(new Date("2026-12-01T03:00:00Z")).toISOString(), "2026-12-01T03:00:00.000Z");
  });
});

describe("missão com mandato e teto do mês (D20, M4; D21)", () => {
  const setup = () => {
    const clock = new ManualClock(T0);
    const store = new InMemoryMissionStore();
    return { clock, missoes: new Missoes(store, new EthicsEngine({ clock, audit: new AuditTrail(new InMemoryAuditSink(), clock) }), clock) };
  };

  it("passado o prazo final, não tenta mais: failed com 'não conseguiu'; e tentar de novo é recusado", async () => {
    const { clock, missoes } = setup();
    const m = await missoes.criar("ana", "obedient", "x", { mandato: { prazoFinalEm: new Date(T0.getTime() + 60_000) }, maxTentativas: 1 });
    const parada = await missoes.avancar(m.id, async () => ({ tipo: "falha_temporaria", erro: "fora do ar", custoCentavos: 1 }));
    assert.equal(parada.estado, "blocked");
    clock.advance(61_000);
    await assert.rejects(missoes.tentarDeNovo("ana", m.id), /prazo/);
    const outra = await missoes.criar("ana", "obedient", "y", { mandato: { prazoFinalEm: new Date(clock.now().getTime() + 60_000) } });
    clock.advance(61_000);
    let chamou = false;
    const fim = await missoes.avancar(outra.id, async () => ((chamou = true), { tipo: "feito", explicacao: "ok", custoCentavos: 1 }));
    assert.deepEqual([fim.estado, fim.desfecho?.tipo, chamou], ["failed", "nao_consegui", false]);
  });

  it("o gasto de cada tentativa soma no mês, e no teto a próxima missão para antes de tentar", async () => {
    const { missoes } = setup();
    const a = await missoes.criar("ana", "obedient", "a", { tetoCustoCentavos: 10_000 });
    await missoes.avancar(a.id, async () => ({ tipo: "nao_consegui", explicacao: "não", custoCentavos: TETO_MENSAL_CENTAVOS }));
    assert.equal(await missoes.gastoDoMes("ana"), TETO_MENSAL_CENTAVOS);
    assert.equal(await missoes.gastoDoMes("bia"), 0, "por pessoa");
    const b = await missoes.criar("ana", "obedient", "b");
    let chamou = false;
    const fim = await missoes.avancar(b.id, async () => ((chamou = true), { tipo: "feito", explicacao: "ok", custoCentavos: 1 }));
    assert.deepEqual([fim.estado, chamou], ["blocked", false]);
    assert.match(fim.impedimento!, /teto do mês/);
  });
});
