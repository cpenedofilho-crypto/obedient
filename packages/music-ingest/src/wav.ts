// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Leitor de WAV (RIFF) para a ingestão do catálogo: PCM inteiro de 16 e 24 bits e ponto flutuante de 32
// bits, mono ou estéreo, mixado para mono. Só WAV de propósito: o mestre que o produtor entrega é WAV, e
// decodificar MP3/AAC exigiria um decodificador de terceiros (ffmpeg é LGPL/GPL). Arquivo fora disso é
// recusado com o motivo, nunca "adivinhado".

export interface Audio {
  readonly taxa: number;
  readonly amostras: Float32Array;
}

export class ErroWav extends Error {
  constructor(readonly codigo: "nao_e_wav" | "formato_nao_suportado" | "sem_dados" | "cabecalho_invalido") {
    super(codigo);
    this.name = "ErroWav";
  }
}

export function lerWav(bytes: Uint8Array): Audio {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const txt = (o: number) => String.fromCharCode(bytes[o]!, bytes[o + 1]!, bytes[o + 2]!, bytes[o + 3]!);
  if (bytes.length < 12 || txt(0) !== "RIFF" || txt(8) !== "WAVE") throw new ErroWav("nao_e_wav");

  let formato = 0, canais = 0, taxa = 0, bits = 0;
  let dados: { inicio: number; tamanho: number } | null = null;
  for (let o = 12; o + 8 <= bytes.length; ) {
    const id = txt(o);
    const tamanho = v.getUint32(o + 4, true);
    const corpo = o + 8;
    if (id === "fmt ") {
      if (tamanho < 16) throw new ErroWav("cabecalho_invalido");
      formato = v.getUint16(corpo, true);
      canais = v.getUint16(corpo + 2, true);
      taxa = v.getUint32(corpo + 4, true);
      bits = v.getUint16(corpo + 14, true);
      if (formato === 0xfffe && tamanho >= 40) formato = v.getUint16(corpo + 24, true); // WAVE_FORMAT_EXTENSIBLE
    } else if (id === "data") {
      dados = { inicio: corpo, tamanho: Math.min(tamanho, bytes.length - corpo) };
    }
    o = corpo + tamanho + (tamanho % 2);
  }
  if (!dados) throw new ErroWav("sem_dados");
  const suportado = (formato === 1 && (bits === 16 || bits === 24)) || (formato === 3 && bits === 32);
  if (!suportado || canais < 1 || canais > 2 || taxa < 8000 || taxa > 192_000) throw new ErroWav("formato_nao_suportado");

  const passo = (bits / 8) * canais;
  const n = Math.floor(dados.tamanho / passo);
  const saida = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let soma = 0;
    for (let c = 0; c < canais; c++) {
      const o = dados.inicio + i * passo + c * (bits / 8);
      if (formato === 3) soma += v.getFloat32(o, true);
      else if (bits === 16) soma += v.getInt16(o, true) / 32768;
      else {
        const x = bytes[o]! | (bytes[o + 1]! << 8) | (bytes[o + 2]! << 16);
        soma += ((x << 8) >> 8) / 8388608;
      }
    }
    saida[i] = soma / canais;
  }
  return { taxa, amostras: saida };
}
