// SPDX-License-Identifier: AGPL-3.0-only
// Ingestão do catálogo: leitor de WAV, energia em ordem, fronteiras nas mudanças de seção, rascunho
// com licença conferida e hash do arquivo de distribuição. Todo áudio aqui é sintético, gerado no teste.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { analisar } from "./analise.ts";
import { corpoParaGrowthOs, coberturaPorFaixa, type EntradaManifesto, montarRascunho } from "./manifesto.ts";
import { ErroWav, lerWav } from "./wav.ts";

const TAXA = 22_050;

/** Seção sintética: batidas por segundo, frequência do tom e volume. */
interface Secao { s: number; batidasPorS: number; hz: number; volume: number }

function sinal(secoes: Secao[]): Float32Array {
  const total = secoes.reduce((n, x) => n + x.s * TAXA, 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const sec of secoes) {
    const periodo = Math.max(1, Math.round(TAXA / Math.max(sec.batidasPorS, 0.01)));
    for (let i = 0; i < sec.s * TAXA; i++, o++) {
      const fase = (i % periodo) / TAXA;
      const batida = sec.batidasPorS > 0 && fase < 0.03 ? Math.sin(2 * Math.PI * 3000 * fase) * Math.exp(-fase * 120) : 0;
      out[o] = sec.volume * (0.6 * batida + 0.4 * Math.sin((2 * Math.PI * sec.hz * i) / TAXA));
    }
  }
  return out;
}

function wav(amostras: Float32Array, opts: { bits?: 16 | 24 | 32; canais?: 1 | 2; extensivel?: boolean } = {}): Uint8Array {
  const bits = opts.bits ?? 16, canais = opts.canais ?? 1;
  const bpa = bits / 8;
  const dados = amostras.length * bpa * canais;
  const fmtTam = opts.extensivel ? 40 : 16;
  const buf = new ArrayBuffer(12 + 8 + fmtTam + 8 + dados);
  const v = new DataView(buf);
  const s = (o: number, t: string) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  s(0, "RIFF"); v.setUint32(4, buf.byteLength - 8, true); s(8, "WAVE");
  s(12, "fmt "); v.setUint32(16, fmtTam, true);
  const fmt = bits === 32 ? 3 : 1;
  v.setUint16(20, opts.extensivel ? 0xfffe : fmt, true); v.setUint16(22, canais, true); v.setUint32(24, TAXA, true);
  v.setUint32(28, TAXA * bpa * canais, true); v.setUint16(32, bpa * canais, true); v.setUint16(34, bits, true);
  if (opts.extensivel) { v.setUint16(36, 22, true); v.setUint16(38, bits, true); v.setUint32(40, 0, true); v.setUint16(44, fmt, true); }
  const d = 20 + fmtTam;
  s(d, "data"); v.setUint32(d + 4, dados, true);
  let o = d + 8;
  for (const x of amostras)
    for (let c = 0; c < canais; c++, o += bpa) {
      if (bits === 32) v.setFloat32(o, x, true);
      else if (bits === 16) v.setInt16(o, Math.round(x * 32767), true);
      else { const n = Math.round(x * 8388607); v.setUint8(o, n & 0xff); v.setUint8(o + 1, (n >> 8) & 0xff); v.setUint8(o + 2, (n >> 16) & 0xff); }
    }
  return new Uint8Array(buf);
}

describe("lerWav", () => {
  const x = Float32Array.from([0, 0.5, -0.5, 0.25]);
  it("reads 16- and 24-bit PCM, 32-bit float and WAVE_FORMAT_EXTENSIBLE, mixing stereo to mono", () => {
    for (const opts of [{ bits: 16 as const }, { bits: 24 as const }, { bits: 32 as const }, { bits: 24 as const, canais: 2 as const, extensivel: true }]) {
      const a = lerWav(wav(x, opts));
      assert.equal(a.taxa, TAXA);
      [...a.amostras].forEach((y, i) => assert.ok(Math.abs(y - x[i]!) < 1e-3, `${JSON.stringify(opts)} ${i}: ${y}`));
    }
  });
  it("refuses what is not WAV or not a supported encoding", () => {
    assert.throws(() => lerWav(Uint8Array.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 0, 0])), (e: unknown) => e instanceof ErroWav && e.codigo === "nao_e_wav");
    const w = wav(x);
    new DataView(w.buffer).setUint16(34, 8, true); // 8 bits
    assert.throws(() => lerWav(w), (e: unknown) => e instanceof ErroWav && e.codigo === "formato_nao_suportado");
  });
});

describe("analisar", () => {
  it("energy follows loudness, attack density and brightness, in order", () => {
    const niveis: Secao[] = [
      { s: 20, batidasPorS: 0.5, hz: 110, volume: 0.05 },
      { s: 20, batidasPorS: 1, hz: 220, volume: 0.12 },
      { s: 20, batidasPorS: 2, hz: 330, volume: 0.25 },
      { s: 20, batidasPorS: 3, hz: 550, volume: 0.5 },
      { s: 20, batidasPorS: 5, hz: 880, volume: 0.9 },
    ];
    const energias = niveis.map((n) => analisar({ taxa: TAXA, amostras: sinal([n]) }).energia);
    for (let i = 1; i < energias.length; i++) assert.ok(energias[i]! > energias[i - 1]!, energias.join(" "));
    // Sinal sintético não chega ao volume nem ao brilho de um mestre masterizado; a calibração com faixas
    // reais é passo da revisão do catálogo (docs/governance/music-catalogo-f4.md). Aqui vale a ordem e a faixa usada.
    assert.ok(energias[0]! < 0.1 && energias.at(-1)! - energias[0]! > 0.5, energias.join(" "));
  });

  it("silence has energy zero and no invented boundaries", () => {
    const a = analisar({ taxa: TAXA, amostras: new Float32Array(TAXA * 20) });
    assert.equal(a.energia, 0);
    assert.equal(a.medidas.ataquesPorS, 0);
  });

  it("phrase boundaries land on section changes", () => {
    const a = analisar({
      taxa: TAXA,
      amostras: sinal([
        { s: 20, batidasPorS: 1, hz: 150, volume: 0.1 },
        { s: 20, batidasPorS: 4, hz: 700, volume: 0.8 },
        { s: 20, batidasPorS: 2, hz: 300, volume: 0.3 },
      ]),
    });
    for (const alvo of [20_000, 40_000]) assert.ok(a.fronteirasMs.some((b) => Math.abs(b - alvo) <= 1500), `${alvo} em ${a.fronteirasMs.join(",")}`);
    for (let i = 1; i < a.fronteirasMs.length; i++) assert.ok(a.fronteirasMs[i]! - a.fronteirasMs[i - 1]! >= 6000);
  });

  it("a long uniform track still gets a boundary in every 30 s stretch, away from the edges", () => {
    const a = analisar({ taxa: TAXA, amostras: sinal([{ s: 95, batidasPorS: 2, hz: 300, volume: 0.4 }]) });
    for (let ini = 0; ini + 30_000 <= 90_000; ini += 30_000) assert.ok(a.fronteirasMs.some((b) => b >= ini && b < ini + 30_000), `${ini}: ${a.fronteirasMs}`);
    assert.ok(a.fronteirasMs.every((b) => b >= 3000 && b <= a.medidas.duracaoMs - 3000));
  });

  it("is deterministic", () => {
    const x = sinal([{ s: 15, batidasPorS: 3, hz: 440, volume: 0.5 }]);
    assert.deepEqual(analisar({ taxa: TAXA, amostras: x }), analisar({ taxa: TAXA, amostras: x }));
  });
});

describe("montarRascunho", () => {
  const mestre = wav(sinal([{ s: 30, batidasPorS: 3, hz: 440, volume: 0.5 }]));
  const distribuicao = Uint8Array.from([1, 2, 3, 4, 5]);
  const arquivos = { ler: (c: string) => (c === "mestre.wav" ? mestre : c === "dist.m4a" ? distribuicao : new Uint8Array()) };
  const entrada: EntradaManifesto = {
    trackRef: "sprint-01", titulo: "Sprint", origem: "proprio", genero: "eletronica", explicita: false,
    mestre: "mestre.wav", distribuicao: { arquivo: "dist.m4a", formato: "audio/mp4" },
    licenca: { instrumento: "contrato-encomenda-001", permiteComercial: true, permiteCrossfade: true, permiteCacheOffline: true, evidencia: "contratos/001.pdf", validaAte: null },
  };

  it("valid delivery: draft without problems, hash and size of the distribution file", () => {
    const r = montarRascunho(entrada, arquivos, "2026-11-22T00:00:00.000Z");
    assert.deepEqual(r.problemas, []);
    assert.equal(r.arquivo.sha256, createHash("sha256").update(distribuicao).digest("hex"));
    assert.equal(r.arquivo.bytes, 5);
    assert.equal(r.revisada, false);
    assert.equal(r.faixa.energia, r.energiaMedida);
    const corpo = corpoParaGrowthOs(r);
    assert.equal(corpo.trackRef, "sprint-01");
    assert.ok(!JSON.stringify(corpo).match(/bpm|tempo/i));
  });

  it("a licence without commercial use, without evidence or expired is flagged, never fixed", () => {
    const r = montarRascunho({ ...entrada, licenca: { ...entrada.licenca, permiteComercial: false, evidencia: " ", validaAte: "2026-01-01T00:00:00.000Z" } }, arquivos, "2026-11-22T00:00:00.000Z");
    assert.deepEqual([...r.problemas].sort(), ["licenca_sem_evidencia", "licenca_sem_uso_comercial", "licenca_vencida"]);
  });

  it("a reviewed energy replaces the measured one and is marked as reviewed", () => {
    const r = montarRascunho({ ...entrada, energiaRevisada: 0.9 }, arquivos, "2026-11-22T00:00:00.000Z");
    assert.equal(r.faixa.energia, 0.9);
    assert.equal(r.revisada, true);
    assert.notEqual(r.energiaMedida, 0.9);
  });

  it("bad reference, empty distribution file and coverage per energy band", () => {
    const r = montarRascunho({ ...entrada, trackRef: "Com Espaço", distribuicao: { arquivo: "nada", formato: "audio/mp4" } }, arquivos, "2026-11-22T00:00:00.000Z");
    assert.ok(r.problemas.includes("track_ref_invalido") && r.problemas.includes("distribuicao_vazia"));
    assert.deepEqual(coberturaPorFaixa([r, { ...r, faixa: { ...r.faixa, energia: 0.1 } }]), { "0.0-0.2": 1, "0.2-0.4": 0, "0.4-0.6": Number(r.faixa.energia >= 0.4 && r.faixa.energia < 0.6), "0.6-0.8": Number(r.faixa.energia >= 0.6 && r.faixa.energia < 0.8), "0.8-1.0": Number(r.faixa.energia >= 0.8) + 0 });
  });
});
