// SPDX-License-Identifier: AGPL-3.0-only
//
// Parada geral pelo operador (Art. 9º): ligada, nenhuma ferramenta é autorizada para ninguém e o
// medidor acende; ligar de novo mantém a primeira; a pessoa não libera; liberada, tudo volta.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { ManualClock } from "@obedient/core";
import { comoOperador, comoUsuario, lerMetricas, motorNaTransacao } from "@obedient/store-postgres";
import { bancoDeTeste, type BancoDeTeste } from "../../store-postgres/src/banco-de-teste.ts";
import { liberarParadaGeral, ligarParadaGeral, verParadaGeral } from "./parada.ts";

const T0 = new Date("2026-11-21T12:00:00Z");
let banco: BancoDeTeste;
before(async () => { banco = await bancoDeTeste(); });
after(() => banco.fechar());

describe("parada geral pela linha de comando", () => {
  it("liga com motivo, barra todo mundo, acende o medidor, só o operador libera", async () => {
    const clock = new ManualClock(T0);
    const u = "ana-parada";
    const motor = <T>(fn: (m: ReturnType<typeof motorNaTransacao>) => Promise<T>) => comoUsuario(banco.db, u, (tx) => fn(motorNaTransacao(tx, { clock })));
    await motor((m) => m.grants.grant({ userId: u, agentId: "obedient", systemId: "mail", capability: "mail.*", purpose: "ler e-mail", limits: { maxRisk: "LOW", autonomousUpTo: "LOW", maxAmount: null, amountField: null }, expiresAt: new Date(T0.getTime() + 3600_000) }, u));
    const ler = () => motor((m) => m.authorize({ userId: u, agentId: "obedient", systemId: "mail", tool: "mail.list", risk: "LOW", category: "READ", args: {} }));
    assert.equal((await ler()).outcome, "allowed");
    assert.deepEqual(await verParadaGeral(banco.db, clock), { ativa: false });

    await assert.rejects(ligarParadaGeral(banco.db, clock, "operador:cli", "x"), /motivo/);
    const ligada = await ligarParadaGeral(banco.db, clock, "operador:cli", "incidente em investigação");
    assert.deepEqual(ligada, { ativa: true, desde: T0.toISOString(), por: "operador:cli", motivo: "incidente em investigação" });
    assert.equal((await ler()).outcome, "denied");
    assert.equal((await comoOperador(banco.db, (tx) => lerMetricas(tx, clock.now()))).paradaGeral, true);

    clock.advance(60_000);
    const deNovo = await ligarParadaGeral(banco.db, clock, "operador:outro", "segunda vez");
    assert.deepEqual([deNovo.desde, deNovo.por], [T0.toISOString(), "operador:cli"], "a primeira parada não é sobrescrita");

    await assert.rejects(motor((m) => m.stop.release({ kind: "global" }, u, "user")), /operador/);
    assert.equal((await ler()).outcome, "denied");

    assert.deepEqual(await liberarParadaGeral(banco.db, clock, "operador:cli"), { ativa: false });
    assert.equal((await ler()).outcome, "allowed");
    assert.equal((await comoOperador(banco.db, (tx) => lerMetricas(tx, clock.now()))).paradaGeral, false);
  });
});
