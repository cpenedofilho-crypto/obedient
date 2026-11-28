// SPDX-License-Identifier: AGPL-3.0-only
// Contratos do Music Intelligence Engine: as constantes que outros pacotes e a tela assumem.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BPM_MAXIMO, BPM_MINIMO, CATEGORIAS_SINAL, MOTIVOS, ORIGENS_FAIXA, RR_MAXIMO_MS, RR_MINIMO_MS, ZONAS } from "./index.ts";

describe("music-contracts", () => {
  it("RR limits are the same physiological range as the bpm limits", () => {
    assert.equal(RR_MINIMO_MS, Math.round(60000 / BPM_MAXIMO));
    assert.equal(RR_MAXIMO_MS, Math.round(60000 / BPM_MINIMO));
  });

  it("track origin is only own or licensed catalog (D31: no streaming services)", () => {
    assert.deepEqual([...ORIGENS_FAIXA], ["proprio", "licenciado"]);
  });

  it("signal consent covers both sensitive categories", () => {
    assert.deepEqual([...CATEGORIAS_SINAL], ["health", "biometric"]);
  });

  it("closed lists have no duplicates", () => {
    for (const lista of [MOTIVOS, ZONAS]) assert.equal(new Set(lista).size, lista.length);
  });
});
