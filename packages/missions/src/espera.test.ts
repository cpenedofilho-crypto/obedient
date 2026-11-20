// SPDX-License-Identifier: AGPL-3.0-only
//
// Espera por sistema externo (D20, M6): a missão dorme sem gastar tentativa, dentro de 5 min a 6 h e
// do prazo final, até MAX_ESPERAS; depois, para e pede a pessoa.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ManualClock } from "@obedient/core";
import { AuditTrail, EthicsEngine, InMemoryAuditSink } from "@obedient/ethics-engine";
import { ESPERA_MAXIMA_MS, ESPERA_MINIMA_MS, InMemoryMissionStore, MAX_ESPERAS, Missoes } from "./index.ts";

const T0 = new Date("2026-11-20T12:00:00Z");
const setup = () => {
  const clock = new ManualClock(T0);
  const sink = new InMemoryAuditSink();
  return { clock, sink, missoes: new Missoes(new InMemoryMissionStore(), new EthicsEngine({ clock, audit: new AuditTrail(sink, clock) }), clock) };
};
const esperar = (ms: number, rodada: unknown = { conversa: 1 }) => async () => ({ tipo: "aguardando_externo" as const, ate: new Date(T0.getTime() + ms), motivo: "o Growth OS espera uma pessoa", rodada, custoCentavos: 1 });

describe("espera por sistema externo (D20, M6)", () => {
  it("dorme até a hora pedida, sem gastar tentativa, guardando a conversa; antes da hora, não anda", async () => {
    const { missoes, sink, clock } = setup();
    const m = await missoes.criar("ana", "obedient", "x", { maxTentativas: 1 });
    const d = await missoes.avancar(m.id, esperar(60 * 60_000));
    assert.deepEqual([d.estado, d.tentativas, d.esperas, d.proximaTentativaEm?.getTime(), d.rodada], ["retrying", 0, 1, T0.getTime() + 3_600_000, { conversa: 1 }]);
    assert.ok((await sink.entries("ana")).some((e) => e.event === "mission.waiting_external"));
    assert.equal((await missoes.reservar(m.id)).reservada, false, "antes da hora");
    clock.advance(3_600_000);
    const r = await missoes.reservar(m.id);
    assert.ok(r.reservada, "com 1 tentativa só, a espera não a consumiu");
    assert.deepEqual([r.missao.tentativas, r.missao.rodada], [1, { conversa: 1 }]);
  });

  it("a hora pedida fica entre 5 min e 6 h, e nunca depois do prazo final", async () => {
    const { missoes } = setup();
    const a = await missoes.criar("ana", "obedient", "a");
    assert.equal((await missoes.avancar(a.id, esperar(1_000))).proximaTentativaEm!.getTime(), T0.getTime() + ESPERA_MINIMA_MS);
    const b = await missoes.criar("ana", "obedient", "b");
    assert.equal((await missoes.avancar(b.id, esperar(48 * 3_600_000))).proximaTentativaEm!.getTime(), T0.getTime() + ESPERA_MAXIMA_MS);
    const prazo = new Date(T0.getTime() + 30 * 60_000);
    const c = await missoes.criar("ana", "obedient", "c", { mandato: { prazoFinalEm: prazo } });
    assert.equal((await missoes.avancar(c.id, esperar(3_600_000))).proximaTentativaEm!.getTime(), prazo.getTime());
  });

  it("depois de MAX_ESPERAS, para e pede a pessoa; tentar de novo zera as esperas", async () => {
    const { missoes, clock } = setup();
    const m = await missoes.criar("ana", "obedient", "x");
    let fim = m;
    for (let i = 0; i <= MAX_ESPERAS; i++) {
      fim = await missoes.avancar(m.id, async () => ({ tipo: "aguardando_externo", ate: new Date(clock.now().getTime() + ESPERA_MINIMA_MS), motivo: "x", custoCentavos: 0 }));
      clock.advance(ESPERA_MINIMA_MS);
    }
    assert.equal(fim.estado, "blocked");
    assert.match(fim.impedimento!, new RegExp(`Esperou o outro sistema ${MAX_ESPERAS} vezes`));
    const de = await missoes.tentarDeNovo("ana", m.id);
    assert.equal(de.esperas, 0);
  });

  it("o planejador não espera: vira falha passageira", async () => {
    const { missoes } = setup();
    const m = await missoes.criar("ana", "obedient", "x", { planejar: true });
    const f = await missoes.avancar(m.id, esperar(3_600_000));
    assert.deepEqual([f.estado, f.esperas], ["retrying", 0]);
  });
});
