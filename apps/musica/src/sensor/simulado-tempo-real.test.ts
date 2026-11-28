// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SensorSimuladoTempoReal, TREINO_DEMO } from "./simulado-tempo-real.ts";

describe("SensorSimuladoTempoReal", () => {
  it("stamps each generated sample with the device clock, one per interval, and stops on abort", async () => {
    let agora = 1_000_000;
    const sensor = new SensorSimuladoTempoReal(() => agora, async (ms) => { agora += ms; });
    const ctrl = new AbortController();
    const t: number[] = [];
    for await (const a of sensor.amostras(ctrl.signal)) {
      t.push(a.t);
      assert.equal(a.fonte, "simulado");
      if (t.length === 5) ctrl.abort();
    }
    assert.deepEqual(t, [1_000_000, 1_001_000, 1_002_000, 1_003_000, 1_004_000]);
  });
  it("the demo workout lasts about 17 minutes", () => {
    assert.equal(TREINO_DEMO.reduce((s, x) => s + x.duracaoS, 0), 1020);
  });
});
