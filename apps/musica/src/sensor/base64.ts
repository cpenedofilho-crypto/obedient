// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// O react-native-ble-plx entrega o valor da característica em base64. Decodificação sem depender de
// Buffer (que não existe no React Native) nem de atob (que nem todo motor JS expõe).
const ALFABETO = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const VALOR = new Map([...ALFABETO].map((c, i) => [c, i]));

export function base64ParaBytes(texto: string): Uint8Array {
  const limpo = texto.replace(/[\s=]/g, "");
  if (/[^A-Za-z0-9+/]/.test(limpo) || limpo.length % 4 === 1) throw new Error("base64 inválido");
  const saida = new Uint8Array(Math.floor((limpo.length * 3) / 4));
  let bits = 0, acumulado = 0, o = 0;
  for (const c of limpo) {
    acumulado = (acumulado << 6) | VALOR.get(c)!;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      saida[o++] = (acumulado >> bits) & 0xff;
    }
  }
  return saida;
}

export function bytesParaBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    s += ALFABETO[(n >> 18) & 63]! + ALFABETO[(n >> 12) & 63]!;
    s += i + 1 < bytes.length ? ALFABETO[(n >> 6) & 63]! : "=";
    s += i + 2 < bytes.length ? ALFABETO[n & 63]! : "=";
  }
  return s;
}
