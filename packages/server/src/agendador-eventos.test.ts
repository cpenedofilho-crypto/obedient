// SPDX-License-Identifier: AGPL-3.0-only
//
// O agendador despacha o barramento (D20, M7): a mudança da missão vira evento na mesma transação e a
// volta seguinte entrega ao consumidor da pessoa, uma vez só.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { ManualClock } from "@obedient/core";
import { RegistroDeConsumidores, VOCABULARIO_OBEDIENT } from "@obedient/event-bus";
import { BarramentoPostgres, comoUsuario, missoesNaTransacao, motorNaTransacao } from "@obedient/store-postgres";
import { bancoDeTeste, type BancoDeTeste } from "../../store-postgres/src/banco-de-teste.ts";
import { agendarMissoes } from "./agendador.ts";

let banco: BancoDeTeste;
before(async () => {
  banco = await bancoDeTeste();
});
after(() => banco.fechar());

describe("agendador e barramento (D20, M7)", () => {
  it("a volta entrega o evento da missão ao consumidor assinado, uma vez só", async () => {
    const clock = new ManualClock(new Date("2026-11-20T12:00:00Z"));
    const u = "ana-agendador-bus";
    await comoUsuario(banco.db, u, (tx) => new BarramentoPostgres(tx, VOCABULARIO_OBEDIENT, clock).assinar({ userId: u, consumer: "painel", padroes: ["mission.*"] }));
    const m = await comoUsuario(banco.db, u, (tx) => missoesNaTransacao(tx, motorNaTransacao(tx, { clock }), clock).criar(u, "obedient", "x"));
    await comoUsuario(banco.db, u, (tx) => missoesNaTransacao(tx, motorNaTransacao(tx, { clock }), clock).cancelarPelaPessoa(u, m.id));
    const vistos: string[] = [];
    const logs: Record<string, unknown>[] = [];
    const ag = agendarMissoes({
      db: banco.db, executar: async () => { throw new Error("nenhuma missão devida"); }, clock, intervaloMs: 60_000, log: (e) => logs.push(e),
      eventos: new RegistroDeConsumidores().registrar("painel", (e) => void vistos.push(`${e.type}:${e.entityId}`)),
    });
    try {
      await ag.volta();
      await ag.volta();
    } finally {
      ag.parar();
    }
    assert.deepEqual(vistos.sort(), [`mission.cancelled:${m.id}`, `mission.created:${m.id}`]);
    assert.ok(logs.some((l) => l.evento === "agendador.eventos" && l.processadas === 2));
  });
});
