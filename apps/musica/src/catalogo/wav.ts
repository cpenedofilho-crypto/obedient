// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Gera WAV (PCM 16 bits, mono) de um padrão rítmico simples: uma batida curta por tempo, sobre um tom
// grave. Serve SÓ para o catálogo de demonstração: som feito aqui, sem obra de terceiros, para testar o
// app de ponta a ponta antes do catálogo de verdade (F4). A "energia" muda o andamento e o brilho.
export interface PadraoDemo {
  readonly batidasPorMinuto: number;
  readonly frequenciaHz: number;
  readonly duracaoS: number;
  readonly taxa?: number;
}

export function gerarWav(p: PadraoDemo): Uint8Array {
  const taxa = p.taxa ?? 11_025;
  const n = Math.round(taxa * p.duracaoS);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const escrever = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  escrever(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); escrever(8, "WAVE");
  escrever(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, taxa, true); v.setUint32(28, taxa * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  escrever(36, "data"); v.setUint32(40, n * 2, true);
  const periodo = (60 / p.batidasPorMinuto) * taxa;
  for (let i = 0; i < n; i++) {
    const fase = (i % periodo) / taxa; // segundos desde a última batida
    const batida = fase < 0.05 ? Math.sin(2 * Math.PI * 1000 * fase) * Math.exp(-fase * 60) : 0;
    const tom = 0.25 * Math.sin((2 * Math.PI * p.frequenciaHz * i) / taxa);
    const amostra = Math.max(-1, Math.min(1, 0.6 * batida + tom));
    v.setInt16(44 + i * 2, Math.round(amostra * 32767 * 0.8), true);
  }
  return new Uint8Array(buf);
}
