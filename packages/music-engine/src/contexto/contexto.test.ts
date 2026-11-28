// SPDX-License-Identifier: AGPL-3.0-only
// Filtro de artefatos, zonas por reserva e Context Engine (histerese, permanência, perda de sinal).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AmostraSinal } from "@obedient/music-contracts";
import { classificar, filtrarRr } from "./filtro-artefatos.ts";
import { bpmLimiteInferior, validarParametros, zonaDe } from "./zonas.ts";
import { ErroConfigContexto, LIMIAR_SEM_SINAL_MS, MotorDeContexto } from "./engine.ts";
import { gerarSinal } from "../sensor/simulado.ts";

const P = { fcRepouso: 60, fcMaxima: 190 }; // reserva 130
const am = (t: number, bpm: number, extra: Partial<AmostraSinal> = {}): AmostraSinal => ({ t, fonte: "simulado", bpm, ...extra });

describe("zones by heart-rate reserve", () => {
  it("maps reserve fractions to the five zones", () => {
    assert.equal(zonaDe(100, P), "repouso"); // 30,8 %
    assert.equal(zonaDe(125, P), "z1"); // 50 %
    assert.equal(zonaDe(138, P), "z2"); // 60 %
    assert.equal(zonaDe(151, P), "z3"); // 70 %
    assert.equal(zonaDe(164, P), "z4"); // 80 %
    assert.equal(zonaDe(177, P), "z5"); // 90 %
    assert.equal(bpmLimiteInferior("z3", P), 151);
  });

  it("rejects parameters the person could not have meant", () => {
    assert.equal(validarParametros({ fcRepouso: 10, fcMaxima: 190 }), "repouso_fora_da_faixa");
    assert.equal(validarParametros({ fcRepouso: 60, fcMaxima: 400 }), "maxima_fora_da_faixa");
    assert.equal(validarParametros({ fcRepouso: 100, fcMaxima: 110 }), "maxima_nao_supera_repouso");
    assert.equal(validarParametros(P), null);
    assert.throws(() => new MotorDeContexto({ fcRepouso: 100, fcMaxima: 110 }), ErroConfigContexto);
    assert.throws(() => new MotorDeContexto({ ...P, alfa: 0 }), ErroConfigContexto);
  });
});

describe("artifact filter", () => {
  it("discards out-of-range, contact loss and missing bpm; marks jumps as doubtful", () => {
    assert.equal(classificar(am(0, 20), null).qualidade, "descartada");
    assert.equal(classificar(am(0, 260), null).qualidade, "descartada");
    assert.equal(classificar(am(0, 90, { contato: false }), null).qualidade, "descartada");
    assert.equal(classificar({ t: 0, fonte: "simulado" }, null).qualidade, "descartada");
    const boa = classificar(am(0, 90), null);
    assert.equal(boa.qualidade, "boa");
    assert.equal(classificar(am(1000, 150), boa).qualidade, "duvidosa");
    assert.equal(classificar(am(3000, 140), boa).qualidade, "boa"); // 50 bpm em 3 s = 16,7/s
  });

  it("drops ectopic RR intervals far from the packet median", () => {
    assert.deepEqual(filtrarRr([800, 810, 1400, 790, 100]), [800, 810, 790]);
  });
});

describe("MotorDeContexto", () => {
  it("does not flip zones while the average oscillates around a boundary (hysteresis)", () => {
    const m = new MotorDeContexto({ ...P, alfa: 1, permanenciaMinimaMs: 0 });
    m.alimentar(am(0, 145)); // z2
    const zonas = new Set<string | null>();
    for (let s = 1; s <= 120; s++) zonas.add(m.alimentar(am(s * 1000, s % 2 ? 152 : 150)).zona); // limite z3 = 151
    assert.deepEqual([...zonas], ["z2"]);
  });

  it("changes zone only after the new zone holds for the minimum time", () => {
    const m = new MotorDeContexto({ ...P, alfa: 1, permanenciaMinimaMs: 20_000 });
    m.alimentar(am(0, 140));
    let mudouEm: number | null = null;
    for (let s = 1; s <= 40; s++) {
      const c = m.alimentar(am(s * 1000, 160));
      if (c.zona === "z3" && mudouEm === null) mudouEm = s;
    }
    assert.equal(mudouEm, 21); // candidata em 1 s, vale 20 s depois
  });

  it("a short spike never becomes a zone", () => {
    const m = new MotorDeContexto({ ...P, alfa: 1 });
    m.alimentar(am(0, 140));
    for (let s = 1; s <= 10; s++) m.alimentar(am(s * 1000, 165));
    let c = m.alimentar(am(11_000, 140));
    for (let s = 12; s <= 60; s++) c = m.alimentar(am(s * 1000, 140));
    assert.equal(c.zona, "z2");
  });

  it("reports signal loss after the threshold and recovers when good samples return", () => {
    const m = new MotorDeContexto(P);
    m.alimentar(am(0, 120));
    assert.equal(m.contextoEm(LIMIAR_SEM_SINAL_MS).sinalPerdidoDesde, null);
    assert.equal(m.contextoEm(LIMIAR_SEM_SINAL_MS + 1).sinalPerdidoDesde, 0);
    assert.equal(m.alimentar(am(20_000, 121)).sinalPerdidoDesde, null);
    const vazio = new MotorDeContexto(P);
    assert.equal(vazio.alimentar(am(0, 300)).sinalPerdidoDesde, 0);
  });

  it("phases follow the session: warm-up, effort from z3, recovery after effort", () => {
    const sinal = gerarSinal({
      semente: 7,
      trechos: [
        { duracaoS: 300, bpmInicial: 90, bpmFinal: 130 },
        { duracaoS: 600, bpmInicial: 160, bpmFinal: 165 },
        { duracaoS: 300, bpmInicial: 130, bpmFinal: 100 },
      ],
    });
    const m = new MotorDeContexto(P);
    const fases = sinal.map((a) => m.alimentar(a).fase);
    assert.equal(fases[120], "aquecimento");
    assert.equal(fases[600], "esforco");
    assert.equal(fases.at(-1), "recuperacao");
  });

  it("is deterministic for the same signal", () => {
    const sinal = gerarSinal({ semente: 3, trechos: [{ duracaoS: 600, bpmInicial: 80, bpmFinal: 175 }], artefatos: 0.1 });
    const rodar = () => {
      const m = new MotorDeContexto(P);
      return sinal.map((a) => m.alimentar(a));
    };
    assert.deepEqual(rodar(), rodar());
  });

  it("confidence drops with artifacts", () => {
    const m = new MotorDeContexto(P);
    let c = m.alimentar(am(0, 120));
    for (let s = 1; s <= 10; s++) c = m.alimentar(am(s * 1000, 120, { contato: s % 2 === 0 }));
    assert.equal(c.confianca, 0.5);
  });
});
