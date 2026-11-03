// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Cofre das credenciais de integração (tokens OAuth). AES-256-GCM com chave fora do banco
// (variável de ambiente), e o usuário e a integração entram como dado autenticado (AAD): uma cifra
// copiada para a linha de outra pessoa, ou de outra integração, não decifra. O banco só vê bytes.
//
// Rotação: cada cifra leva o id da chave. Chaves antigas continuam decifrando até serem retiradas.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { ObedientError } from "@obedient/core";

export interface ChaveDoCofre {
  id: string;
  /** 32 bytes. */
  bytes: Buffer;
}

export interface Cifra {
  chaveId: string;
  /** iv (12) + tag (16) + texto cifrado. */
  dados: Buffer;
}

/** "id:base64" separadas por vírgula; a primeira é a que cifra. Ex.: OBEDIENT_CHAVES_COFRE="k2:...,k1:...". */
export function lerChaves(texto: string | undefined): ChaveDoCofre[] {
  const chaves = (texto ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((par) => {
      const [id, b64] = par.split(":");
      const bytes = Buffer.from(b64 ?? "", "base64");
      if (!id || !/^[A-Za-z0-9_-]{1,32}$/.test(id) || bytes.length !== 32) throw new Error("OBEDIENT_CHAVES_COFRE: cada chave é id:base64 de 32 bytes");
      return { id, bytes };
    });
  if (new Set(chaves.map((c) => c.id)).size !== chaves.length) throw new Error("OBEDIENT_CHAVES_COFRE: id de chave repetido");
  return chaves;
}

export class Cofre {
  constructor(private readonly chaves: readonly ChaveDoCofre[]) {
    if (!chaves.length) throw new Error("cofre sem chave: defina OBEDIENT_CHAVES_COFRE");
  }

  static novaChave(): string {
    return randomBytes(32).toString("base64");
  }

  cifrar(texto: string, userId: string, integracao: string): Cifra {
    const k = this.chaves[0]!;
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", k.bytes, iv);
    c.setAAD(Buffer.from(`obedient:${userId}:${integracao}`, "utf8"));
    const corpo = Buffer.concat([c.update(texto, "utf8"), c.final()]);
    return { chaveId: k.id, dados: Buffer.concat([iv, c.getAuthTag(), corpo]) };
  }

  decifrar(cifra: Cifra, userId: string, integracao: string): string {
    const k = this.chaves.find((x) => x.id === cifra.chaveId);
    if (!k) throw new ObedientError("UNAUTHENTICATED", "credencial cifrada com chave que não existe mais: reconecte a integração");
    try {
      const d = createDecipheriv("aes-256-gcm", k.bytes, cifra.dados.subarray(0, 12));
      d.setAAD(Buffer.from(`obedient:${userId}:${integracao}`, "utf8"));
      d.setAuthTag(cifra.dados.subarray(12, 28));
      return Buffer.concat([d.update(cifra.dados.subarray(28)), d.final()]).toString("utf8");
    } catch {
      throw new ObedientError("UNAUTHENTICATED", "credencial adulterada ou de outra pessoa");
    }
  }
}
