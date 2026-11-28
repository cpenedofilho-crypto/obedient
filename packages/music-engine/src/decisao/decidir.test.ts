// SPDX-License-Identifier: AGPL-3.0-only
// Music Decision Engine: cada regra, os motivos e as propriedades que valem para qualquer entrada.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Contexto, EntradaDecisao, Zona } from "@obedient/music-contracts";
import { TRAVAS_LIVRES, ZONAS } from "@obedient/music-contracts";
import { CATALOGO, LICENCA_OK, faixa } from "../__teste__/catalogo.ts";
import { PREFERENCIAS_PADRAO, faixaDeEnergia } from "../preferencias/engine.ts";
import { rng } from "../sensor/simulado.ts";
import { HORIZONTE_FRASE_MS, INTERVALO_MINIMO_TROCA_MS, LIMITE_SINAL_PERDIDO_MS, decidir } from "./decidir.ts";

const ctx = (zona: Zona | null, extra: Partial<Contexto> = {}): Contexto => ({
  t: 0,
  bpmSuavizado: 140,
  zona,
  fase: "esforco",
  confianca: 1,
  sinalPerdidoDesde: null,
  ...extra,
});

const entrada = (extra: Partial<EntradaDecisao> = {}): EntradaDecisao => ({
  agora: 600_000,
  dataIso: "2026-11-22T12:00:00.000Z",
  consentimentoVigente: true,
  contexto: ctx("z3"),
  preferencias: PREFERENCIAS_PADRAO,
  travas: TRAVAS_LIVRES,
  tocando: null,
  historico: [],
  ultimaTrocaEm: null,
  catalogo: CATALOGO,
  ...extra,
});

describe("decidir: who is in charge", () => {
  it("without consent nothing happens, whatever else is true", () => {
    assert.deepEqual(decidir(entrada({ consentimentoVigente: false })), { tipo: "nenhuma", motivo: "sem_consentimento" });
  });
  it("adaptation off, pause and locked track belong to the person", () => {
    assert.equal(decidir(entrada({ preferencias: { ...PREFERENCIAS_PADRAO, modo: "desligada" } })).motivo, "adaptacao_desligada");
    assert.equal(decidir(entrada({ travas: { ...TRAVAS_LIVRES, pausado: true } })).motivo, "pausado");
    assert.deepEqual(decidir(entrada({ travas: { ...TRAVAS_LIVRES, faixaTravada: "f01" } })), { tipo: "manter", motivo: "faixa_travada" });
  });
  it("a locked zone works even with no signal at all", () => {
    const d = decidir(entrada({ contexto: ctx(null), travas: { ...TRAVAS_LIVRES, zonaTravada: "z5" } }));
    assert.equal(d.tipo, "trocar");
    assert.ok(d.tipo === "trocar" && d.zonaAlvo === "z5");
  });
});

describe("decidir: signal", () => {
  it("no zone yet: nothing", () => {
    assert.deepEqual(decidir(entrada({ contexto: ctx(null) })), { tipo: "nenhuma", motivo: "sem_sinal" });
  });
  it("short loss keeps the music; long loss hands control back to the person", () => {
    const tocando = { faixaId: "f13", posicaoMs: 10_000, desde: 590_000 };
    const curto = decidir(entrada({ tocando, contexto: ctx("z3", { sinalPerdidoDesde: 600_000 - 10_000 }) }));
    assert.deepEqual(curto, { tipo: "manter", motivo: "sinal_instavel" });
    const longo = decidir(entrada({ tocando, contexto: ctx("z3", { sinalPerdidoDesde: 600_000 - LIMITE_SINAL_PERDIDO_MS - 1 }) }));
    assert.deepEqual(longo, { tipo: "nenhuma", motivo: "sem_sinal" });
  });
  it("low confidence never switches", () => {
    const tocando = { faixaId: "f01", posicaoMs: 0, desde: 600_000 };
    assert.deepEqual(decidir(entrada({ tocando, contexto: ctx("z5", { confianca: 0.3 }) })), { tipo: "manter", motivo: "sinal_instavel" });
  });
});

describe("decidir: choosing", () => {
  it("keeps the current track when its energy fits the zone", () => {
    const tocando = { faixaId: "f13", posicaoMs: 30_000, desde: 570_000 }; // 0,65 em z3 (0,5–0,75)
    assert.deepEqual(decidir(entrada({ tocando })), { tipo: "manter", motivo: "faixa_atual_adequada" });
  });

  it("starts with the track closest to the centre of the zone band", () => {
    const d = decidir(entrada());
    assert.equal(d.tipo, "trocar");
    if (d.tipo !== "trocar") return;
    // z3: 0,5–0,75, centro 0,625; empate entre f12 (0,60) e f13 (0,65) → menor distância é igual, desempata pelo id
    assert.equal(d.faixaId, "f12");
    assert.equal(d.motivo, "nada_tocando");
    assert.equal(d.emMs, 600_000);
  });

  it("respects the minimum interval between automatic switches", () => {
    const tocando = { faixaId: "f02", posicaoMs: 20_000, desde: 580_000 };
    const cedo = decidir(entrada({ tocando, ultimaTrocaEm: 600_000 - INTERVALO_MINIMO_TROCA_MS + 1 }));
    assert.deepEqual(cedo, { tipo: "manter", motivo: "intervalo_minimo" });
    const depois = decidir(entrada({ tocando, ultimaTrocaEm: 600_000 - INTERVALO_MINIMO_TROCA_MS }));
    assert.equal(depois.tipo, "trocar");
  });

  it("switches at the next phrase boundary, with crossfade only when both licences allow it", () => {
    const tocando = { faixaId: "f02", posicaoMs: 22_000, desde: 578_000 };
    const d = decidir(entrada({ tocando }));
    assert.ok(d.tipo === "trocar");
    assert.equal(d.emMs, 600_000 + 8_000); // fronteira em 30 s
    assert.equal(d.transicao, "crossfade");
    assert.equal(d.motivo, "zona_mudou");

    const semCross = CATALOGO.map((f) => (f.id === "f02" ? { ...f, licenca: { ...LICENCA_OK, permiteCrossfade: false } } : f));
    const d2 = decidir(entrada({ tocando, catalogo: semCross }));
    assert.ok(d2.tipo === "trocar" && d2.transicao === "corte");
  });

  it("switches right away when no boundary is within the horizon", () => {
    const longe = CATALOGO.map((f) => (f.id === "f02" ? { ...f, fronteirasMs: [170_000] } : f));
    const d = decidir(entrada({ tocando: { faixaId: "f02", posicaoMs: 10_000, desde: 590_000 }, catalogo: longe }));
    assert.ok(d.tipo === "trocar" && d.emMs === 600_000);
    assert.ok(170_000 - 10_000 > HORIZONTE_FRASE_MS);
  });

  it("replaces a track that became ineligible immediately, ignoring the interval", () => {
    const vencida = CATALOGO.map((f) => (f.id === "f13" ? { ...f, licenca: { ...LICENCA_OK, validaAte: "2026-01-01T00:00:00.000Z" } } : f));
    const d = decidir(entrada({ catalogo: vencida, tocando: { faixaId: "f13", posicaoMs: 5_000, desde: 595_000 }, ultimaTrocaEm: 599_000 }));
    assert.ok(d.tipo === "trocar");
    assert.equal(d.motivo, "faixa_atual_inelegivel");
    assert.equal(d.transicao, "corte");
    assert.equal(d.emMs, 600_000);
  });

  it("avoids repeating recent tracks, falling back to the oldest one when all fit tracks were played", () => {
    const d = decidir(entrada({ historico: ["f12"] }));
    assert.ok(d.tipo === "trocar" && d.faixaId === "f13");
    const todas = ["f10", "f11", "f12", "f13", "f14", "f15"];
    const d2 = decidir(entrada({ historico: todas }));
    assert.ok(d2.tipo === "trocar" && d2.faixaId === "f10");
  });

  it("suggest-only mode never plays on its own", () => {
    const d = decidir(entrada({ preferencias: { ...PREFERENCIAS_PADRAO, modo: "so_sugestao" } }));
    assert.equal(d.tipo, "sugerir");
  });

  it("no compatible track: keeps what is playing, or does nothing", () => {
    const so = [faixa("x", 0.05)];
    assert.deepEqual(decidir(entrada({ catalogo: so })), { tipo: "nenhuma", motivo: "sem_faixa_compativel" });
    assert.deepEqual(decidir(entrada({ catalogo: so, tocando: { faixaId: "x", posicaoMs: 0, desde: 600_000 } })), { tipo: "manter", motivo: "sem_faixa_compativel" });
  });

  it("uses the energy band the person chose for the zone", () => {
    const prefs = { ...PREFERENCIAS_PADRAO, energiaPorZona: { z3: { min: 0.9, max: 1 } } };
    const d = decidir(entrada({ preferencias: prefs }));
    assert.ok(d.tipo === "trocar" && ["f19", "f20"].includes(d.faixaId));
  });
});

describe("decidir: properties over random inputs", () => {
  const aleatorio = rng(2026);
  const ruins = [
    faixa("bloq", 0.6),
    faixa("nc", 0.62, { licenca: { ...LICENCA_OK, permiteComercial: false } }),
    faixa("venc", 0.63, { licenca: { ...LICENCA_OK, validaAte: "2025-01-01T00:00:00.000Z" } }),
    faixa("expl", 0.64, { explicita: true }),
    faixa("semprova", 0.61, { licenca: { ...LICENCA_OK, evidencia: " " } }),
  ];
  const catalogo = [...CATALOGO, ...ruins];
  const prefs = { ...PREFERENCIAS_PADRAO, bloqueadas: ["bloq"] };

  it("never picks a blocked, non-commercial, expired, unproven or explicit track; never switches inside the interval", () => {
    for (let i = 0; i < 3000; i++) {
      const zona = ZONAS[Math.floor(aleatorio() * ZONAS.length)]!;
      const ultima = aleatorio() < 0.5 ? null : 600_000 - Math.floor(aleatorio() * 120_000);
      const atual = catalogo[Math.floor(aleatorio() * CATALOGO.length)]!;
      const e = entrada({
        catalogo,
        preferencias: prefs,
        contexto: ctx(zona, { confianca: aleatorio() }),
        tocando: aleatorio() < 0.3 ? null : { faixaId: atual.id, posicaoMs: Math.floor(aleatorio() * 170_000), desde: 0 },
        ultimaTrocaEm: ultima,
      });
      const d = decidir(e);
      if (d.tipo === "trocar" || d.tipo === "sugerir") {
        assert.ok(!["bloq", "nc", "venc", "expl", "semprova"].includes(d.faixaId), d.faixaId);
        const f = catalogo.find((x) => x.id === d.faixaId)!;
        const banda = faixaDeEnergia(d.zonaAlvo, prefs);
        assert.ok(f.energia >= banda.min && f.energia <= banda.max);
        if (d.tipo === "trocar" && d.motivo === "zona_mudou" && ultima !== null) assert.ok(e.agora - ultima >= INTERVALO_MINIMO_TROCA_MS);
      }
      assert.deepEqual(decidir(e), d, "determinística");
    }
  });
});
