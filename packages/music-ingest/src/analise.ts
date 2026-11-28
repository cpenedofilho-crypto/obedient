// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Análise de uma faixa do catálogo próprio, para o RASCUNHO que uma pessoa revisa antes de publicar:
//   - energia (0 a 1): combinação fixa e explicável de três medidas;
//   - fronteiras de frase: instantes em que o som muda de seção (onde trocar de música soa natural).
//
// O que NÃO se mede, de propósito (D31; docs/governance/music-engine-f0.md): andamento ou BPM. O motor
// não casa música com batimento nem com passada, então o catálogo não precisa disso, e não medir afasta
// as famílias de patente de seleção por tempo. A guarda de desenho do motor vale também para este pacote.
//
// Medidas, em quadros de 2048 amostras com salto de 1024 (mono):
//   intensidade  = média em dB do RMS dos quadros acima da mediana (ignora silêncio e fade);
//   ataques/s    = picos do fluxo espectral acima de um limiar adaptativo, por segundo;
//   brilho (Hz)  = centroide espectral médio.
// energia = 0,5·n(intensidade, −30..−8 dB) + 0,3·n(ataques, 0,5..6/s) + 0,2·n(brilho, 500..4000 Hz),
// com n() linear e limitado a 0..1, arredondada para 0,01.

import type { Audio } from "./wav.ts";

export const QUADRO = 2048;
export const SALTO = 1024;

export interface Medidas {
  readonly duracaoMs: number;
  readonly intensidadeDb: number;
  readonly ataquesPorS: number;
  readonly brilhoHz: number;
}

export interface Analise {
  readonly medidas: Medidas;
  readonly energia: number;
  readonly fronteirasMs: number[];
}

/** FFT radix-2 in-place (re, im de tamanho potência de 2). */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j]!, re[i]!]; [im[i], im[j]] = [im[j]!, im[i]!]; }
  }
  for (let tam = 2; tam <= n; tam <<= 1) {
    const ang = (-2 * Math.PI) / tam;
    for (let i = 0; i < n; i += tam)
      for (let k = 0; k < tam / 2; k++) {
        const cr = Math.cos(ang * k), ci = Math.sin(ang * k);
        const a = i + k, b = i + k + tam / 2;
        const tr = re[b]! * cr - im[b]! * ci, ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr; im[b] = im[a]! - ti;
        re[a] = re[a]! + tr; im[a] = im[a]! + ti;
      }
  }
}

const n01 = (x: number, a: number, b: number) => Math.max(0, Math.min(1, (x - a) / (b - a)));
const media = (xs: ArrayLike<number>) => { let s = 0; for (let i = 0; i < xs.length; i++) s += xs[i]!; return xs.length ? s / xs.length : 0; };
const mediana = (xs: number[]) => { const v = [...xs].sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)]! : 0; };

export function analisar(a: Audio): Analise {
  const { taxa, amostras } = a;
  const duracaoMs = Math.round((amostras.length / taxa) * 1000);
  const janela = new Float64Array(QUADRO).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (QUADRO - 1)));
  const rmsDb: number[] = [];
  const centroides: number[] = [];
  const fluxo: number[] = [];
  let anterior: Float64Array | null = null;
  const re = new Float64Array(QUADRO), im = new Float64Array(QUADRO);

  for (let ini = 0; ini + QUADRO <= amostras.length; ini += SALTO) {
    let soma = 0;
    for (let i = 0; i < QUADRO; i++) {
      const x = amostras[ini + i]!;
      soma += x * x;
      re[i] = x * janela[i]!;
      im[i] = 0;
    }
    rmsDb.push(10 * Math.log10(soma / QUADRO + 1e-12));
    fft(re, im);
    const mag = new Float64Array(QUADRO / 2);
    let num = 0, den = 0;
    for (let k = 1; k < QUADRO / 2; k++) {
      mag[k] = Math.hypot(re[k]!, im[k]!);
      num += mag[k]! * ((k * taxa) / QUADRO);
      den += mag[k]!;
    }
    centroides.push(den > 0 ? num / den : 0);
    let f = 0;
    if (anterior) for (let k = 1; k < QUADRO / 2; k++) f += Math.max(0, mag[k]! - anterior[k]!);
    fluxo.push(f);
    anterior = mag;
  }

  const quadrosPorS = taxa / SALTO;
  // Intensidade: só os quadros acima da mediana (o silêncio do começo e o fade não puxam a média).
  const corte = mediana(rmsDb);
  const intensidadeDb = media(rmsDb.filter((d) => d >= corte));
  // Ataques: picos locais do fluxo acima de média móvel + 1,5 desvio, com 100 ms entre picos.
  let ataques = 0, ultimo = -Infinity;
  const raio = Math.round(quadrosPorS); // ~1 s de cada lado
  for (let i = 1; i < fluxo.length - 1; i++) {
    const viz = fluxo.slice(Math.max(0, i - raio), i + raio + 1);
    const m = media(viz);
    const dp = Math.sqrt(media(viz.map((x) => (x - m) ** 2)));
    if (fluxo[i]! > fluxo[i - 1]! && fluxo[i]! >= fluxo[i + 1]! && fluxo[i]! > m + 1.5 * dp && (i - ultimo) / quadrosPorS >= 0.1) {
      ataques++;
      ultimo = i;
    }
  }
  const ataquesPorS = duracaoMs > 0 ? ataques / (duracaoMs / 1000) : 0;
  const pesoCentroide = centroides.filter((_, i) => rmsDb[i]! >= corte);
  const brilhoHz = media(pesoCentroide.length ? pesoCentroide : centroides);

  const energia = Math.round((0.5 * n01(intensidadeDb, -30, -8) + 0.3 * n01(ataquesPorS, 0.5, 6) + 0.2 * n01(brilhoHz, 500, 4000)) * 100) / 100;

  return {
    medidas: { duracaoMs, intensidadeDb: Math.round(intensidadeDb * 10) / 10, ataquesPorS: Math.round(ataquesPorS * 100) / 100, brilhoHz: Math.round(brilhoHz) },
    energia,
    fronteirasMs: fronteiras(rmsDb, centroides, quadrosPorS, duracaoMs),
  };
}

/**
 * Novidade entre a janela de ~2 s antes e a de ~2 s depois de cada quadro (intensidade e brilho,
 * normalizados). Picos com pelo menos 6 s entre si e longe das pontas viram fronteira. Se um trecho de
 * 30 s ficar sem fronteira, entra o ponto de maior novidade dele (o motor tem para onde trocar).
 */
export function fronteiras(rmsDb: number[], centroides: number[], quadrosPorS: number, duracaoMs: number): number[] {
  const w = Math.max(1, Math.round(2 * quadrosPorS));
  const nC = (x: number) => x / 4000;
  const nov: number[] = rmsDb.map((_, i) => {
    if (i < w || i + w > rmsDb.length) return 0;
    const antes = media(rmsDb.slice(i - w, i)), depois = media(rmsDb.slice(i, i + w));
    const ca = media(centroides.slice(i - w, i)), cd = media(centroides.slice(i, i + w));
    return Math.abs(depois - antes) / 10 + Math.abs(nC(cd) - nC(ca));
  });
  const ms = (i: number) => Math.round((i / quadrosPorS) * 1000);
  const longeDasPontas = (i: number) => ms(i) >= 3000 && ms(i) <= duracaoMs - 3000;
  const limiar = media(nov) + 2 * Math.sqrt(media(nov.map((x) => (x - media(nov)) ** 2)));
  const minimo = Math.round(6 * quadrosPorS);

  const picos = nov
    .map((v, i) => ({ v, i }))
    .filter(({ v, i }) => v > limiar && v > 0.05 && longeDasPontas(i) && v >= (nov[i - 1] ?? 0) && v >= (nov[i + 1] ?? 0))
    .sort((a, b) => b.v - a.v);
  const escolhidos: number[] = [];
  for (const p of picos) if (escolhidos.every((e) => Math.abs(e - p.i) >= minimo)) escolhidos.push(p.i);

  // Nenhum trecho de 30 s sem fronteira.
  const trecho = Math.round(30 * quadrosPorS);
  for (let ini = 0; ini < nov.length; ini += trecho) {
    const fim = Math.min(nov.length, ini + trecho);
    if (escolhidos.some((e) => e >= ini && e < fim)) continue;
    let melhor = -1;
    for (let i = ini; i < fim; i++) if (longeDasPontas(i) && (melhor < 0 || nov[i]! > nov[melhor]!)) melhor = i;
    if (melhor >= 0 && escolhidos.every((e) => Math.abs(e - melhor) >= minimo)) escolhidos.push(melhor);
  }
  return escolhidos.sort((a, b) => a - b).map(ms).slice(0, 500);
}
