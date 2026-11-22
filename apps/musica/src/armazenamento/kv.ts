// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Armazenamento chave-valor do aparelho. No app é o AsyncStorage (plataforma/kv-async-storage.ts); nos
// testes, a memória. Tudo o que o app guarda fica só no aparelho, sob as chaves com o prefixo abaixo, e
// "apagar meus dados" apaga todas elas.
export const PREFIXO = "obedient.musica.";

export interface Kv {
  ler(chave: string): Promise<string | null>;
  gravar(chave: string, valor: string): Promise<void>;
  apagar(chave: string): Promise<void>;
  chaves(): Promise<string[]>;
}

export class KvMemoria implements Kv {
  readonly dados = new Map<string, string>();
  async ler(c: string) { return this.dados.get(c) ?? null; }
  async gravar(c: string, v: string) { this.dados.set(c, v); }
  async apagar(c: string) { this.dados.delete(c); }
  async chaves() { return [...this.dados.keys()]; }
}

export async function lerJson<T>(kv: Kv, chave: string, padrao: T): Promise<T> {
  const t = await kv.ler(PREFIXO + chave);
  if (t === null) return padrao;
  try { return JSON.parse(t) as T; } catch { return padrao; }
}

export function gravarJson(kv: Kv, chave: string, valor: unknown): Promise<void> {
  return kv.gravar(PREFIXO + chave, JSON.stringify(valor));
}

/** Apaga tudo o que o app guardou (direito do titular, no aparelho). */
export async function apagarTudo(kv: Kv): Promise<number> {
  const minhas = (await kv.chaves()).filter((c) => c.startsWith(PREFIXO));
  for (const c of minhas) await kv.apagar(c);
  return minhas.length;
}
