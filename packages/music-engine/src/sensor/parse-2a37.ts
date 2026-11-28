// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Leitura da característica Heart Rate Measurement (0x2A37) do Heart Rate Service (0x180D) do
// Bluetooth LE. É o formato que cintas, relógios em "broadcast", WHOOP e Polar usam, então um parser
// só cobre todos. Função pura: o app recebe os bytes do BLE nativo e chama isto.
//
// Layout (byte 0 = flags):
//   bit 0   : 0 = bpm em uint8; 1 = bpm em uint16 little-endian
//   bits 1-2: contato com a pele (bit 2 = suportado; bit 1 = detectado)
//   bit 3   : energia gasta (uint16, kJ) presente
//   bit 4   : intervalos RR presentes (uint16 cada, unidade de 1/1024 s), até o fim do pacote
// Fonte: especificação da Bluetooth SIG (não lida nesta sessão; bluetooth.com bloqueado) conferida
// em fontes secundárias. Pendência registrada em docs/governance/music-engine-f0.md.

export interface MedicaoFc {
  readonly bpm: number;
  /** undefined quando o sensor não informa contato. */
  readonly contato: boolean | undefined;
  readonly energiaKj: number | undefined;
  readonly rrMs: readonly number[];
}

export type ResultadoParse = { readonly ok: true; readonly medicao: MedicaoFc } | { readonly ok: false; readonly codigo: "pacote_curto" | "rr_impar" };

export function lerMedicaoFc(bytes: Uint8Array): ResultadoParse {
  if (bytes.length < 2) return { ok: false, codigo: "pacote_curto" };
  const flags = bytes[0]!;
  const bpm16 = (flags & 0x01) !== 0;
  const contatoSuportado = (flags & 0x04) !== 0;
  const contatoDetectado = (flags & 0x02) !== 0;
  const temEnergia = (flags & 0x08) !== 0;
  const temRr = (flags & 0x10) !== 0;

  let i = 1;
  const u16 = (): number => {
    const v = bytes[i]! | (bytes[i + 1]! << 8);
    i += 2;
    return v;
  };

  const minimo = 1 + (bpm16 ? 2 : 1) + (temEnergia ? 2 : 0);
  if (bytes.length < minimo) return { ok: false, codigo: "pacote_curto" };

  let bpm: number;
  if (bpm16) bpm = u16();
  else bpm = bytes[i++]!;

  const energiaKj = temEnergia ? u16() : undefined;

  const rrMs: number[] = [];
  if (temRr) {
    const resto = bytes.length - i;
    if (resto % 2 !== 0) return { ok: false, codigo: "rr_impar" };
    while (i < bytes.length) rrMs.push(Math.round((u16() * 1000) / 1024));
  }

  return { ok: true, medicao: { bpm, contato: contatoSuportado ? contatoDetectado : undefined, energiaKj, rrMs } };
}
