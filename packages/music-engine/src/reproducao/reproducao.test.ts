// SPDX-License-Identifier: AGPL-3.0-only
// Adaptador do catálogo próprio e trilha local com retenção.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ManualClock } from "@obedient/core";
import { CATALOGO, LICENCA_OK, faixa } from "../__teste__/catalogo.ts";
import { TrilhaLocal } from "../privacidade/retencao.ts";
import { AdaptadorCatalogoProprio, PlayerFalso } from "./catalogo-proprio.ts";

const clock = new ManualClock(new Date("2026-11-22T12:00:00.000Z"));
const trocar = (faixaId: string, transicao: "corte" | "crossfade" = "crossfade") => ({ tipo: "trocar" as const, faixaId, emMs: 1000, transicao, motivo: "zona_mudou" as const, zonaAlvo: "z3" as const });

describe("AdaptadorCatalogoProprio", () => {
  it("plays a valid track and passes crossfade only when the player and the licence allow it", async () => {
    const semCross = faixa("sc", 0.5, { licenca: { ...LICENCA_OK, permiteCrossfade: false } });
    const player = new PlayerFalso(true);
    const a = new AdaptadorCatalogoProprio([...CATALOGO, semCross], player, clock);
    assert.deepEqual(await a.aplicar(trocar("f10")), { ok: true });
    assert.deepEqual(await a.aplicar(trocar("sc")), { ok: true });
    assert.deepEqual(
      player.pedidos.map((p) => p.crossfade),
      [true, false],
    );
    const semSuporte = new PlayerFalso(false);
    await new AdaptadorCatalogoProprio(CATALOGO, semSuporte, clock).aplicar(trocar("f10"));
    assert.equal(semSuporte.pedidos[0]!.crossfade, false);
  });

  it("refuses unknown tracks and licences that expired since ingestion", async () => {
    const vencida = faixa("v", 0.5, { licenca: { ...LICENCA_OK, validaAte: "2026-11-22T11:59:59.000Z" } });
    const player = new PlayerFalso();
    const a = new AdaptadorCatalogoProprio([vencida], player, clock);
    assert.deepEqual(await a.aplicar(trocar("nada")), { ok: false, codigo: "faixa_desconhecida" });
    assert.deepEqual(await a.aplicar(trocar("v")), { ok: false, codigo: "licenca_invalida" });
    assert.equal(player.pedidos.length, 0);
  });

  it("reports player errors instead of pretending it played", async () => {
    const a = new AdaptadorCatalogoProprio(CATALOGO, new PlayerFalso(true, true), clock);
    assert.deepEqual(await a.aplicar(trocar("f10")), { ok: false, codigo: "erro_player" });
  });

  it("keep and none decisions do nothing", async () => {
    const player = new PlayerFalso();
    const a = new AdaptadorCatalogoProprio(CATALOGO, player, clock);
    await a.aplicar({ tipo: "manter", motivo: "faixa_atual_adequada" });
    await a.aplicar({ tipo: "nenhuma", motivo: "pausado" });
    assert.equal(player.pedidos.length, 0);
  });
});

describe("TrilhaLocal", () => {
  it("expires entries after the retention period", () => {
    const c = new ManualClock(new Date("2026-11-22T12:00:00.000Z"));
    const t = new TrilhaLocal(60_000, c);
    t.registrar(trocar("f10"));
    c.advance(30_000);
    t.registrar({ tipo: "manter", motivo: "intervalo_minimo" });
    assert.equal(t.exportar().length, 2);
    c.advance(31_000);
    assert.deepEqual(
      t.exportar().map((r) => r.motivo),
      ["intervalo_minimo"],
    );
  });

  it("retention zero keeps nothing", () => {
    const t = new TrilhaLocal(0, clock);
    t.registrar(trocar("f10"));
    assert.equal(t.exportar().length, 0);
  });
});
