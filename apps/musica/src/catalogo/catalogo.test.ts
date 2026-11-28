// SPDX-License-Identifier: AGPL-3.0-only
// WAV gerado e catálogo de demonstração.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validarFaixa } from "@obedient/music-engine";
import { CATALOGO_DEMO } from "./demo.ts";
import { gerarWav } from "./wav.ts";

describe("gerarWav", () => {
  it("writes a valid 16-bit mono PCM header and the right size", () => {
    const w = gerarWav({ batidasPorMinuto: 120, frequenciaHz: 220, duracaoS: 1, taxa: 8000 });
    const v = new DataView(w.buffer);
    const txt = (o: number, n: number) => String.fromCharCode(...w.slice(o, o + n));
    assert.equal(txt(0, 4), "RIFF");
    assert.equal(txt(8, 4), "WAVE");
    assert.equal(v.getUint16(22, true), 1);
    assert.equal(v.getUint32(24, true), 8000);
    assert.equal(v.getUint16(34, true), 16);
    assert.equal(v.getUint32(40, true), 16000);
    assert.equal(w.length, 44 + 16000);
  });
});

describe("demo catalog", () => {
  it("every demo track passes the engine's licence check and covers the energy range", () => {
    for (const { faixa } of CATALOGO_DEMO) assert.deepEqual(validarFaixa(faixa, "2026-11-22T00:00:00.000Z"), [], faixa.id);
    assert.equal(CATALOGO_DEMO.length, 10);
    assert.equal(CATALOGO_DEMO[0]!.faixa.energia, 0.1);
    assert.equal(CATALOGO_DEMO.at(-1)!.faixa.energia, 1);
  });
});
