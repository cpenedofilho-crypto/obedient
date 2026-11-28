// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Arquivos do catálogo real no aparelho (F4).
// - Só guarda o que a licença deixa guardar (permiteCacheOffline). O resto toca por endereço temporário,
//   pedido ao Growth OS na hora (precisa de rede).
// - Todo arquivo baixado tem o tamanho e o SHA-256 conferidos com o que o catálogo publicou; diferente,
//   é descartado.
// - Arquivo de faixa que saiu do catálogo, perdeu a permissão de guardar ou venceu é apagado.
import { createHash } from "node:crypto";
import type { ClienteGrowthOs } from "../api/cliente.ts";
import type { FaixaComArquivo } from "./remoto.ts";

export interface PastaDeArquivos {
  listar(): Promise<string[]>;
  ler(nome: string): Promise<Uint8Array | null>;
  gravar(nome: string, bytes: Uint8Array): Promise<void>;
  apagar(nome: string): Promise<void>;
  uri(nome: string): string;
}

export type Baixar = (url: string) => Promise<Uint8Array>;

const nomeDe = (trackRef: string, sha256: string) => `${trackRef}.${sha256.slice(0, 16)}`;
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

export interface Relatorio { mantidos: number; baixados: number; recusados: string[]; apagados: number; semRede: number }

export class ArquivosDoCatalogo {
  private faixas: readonly FaixaComArquivo[] = [];

  constructor(
    private readonly pasta: PastaDeArquivos,
    private readonly api: ClienteGrowthOs,
    private readonly baixar: Baixar,
  ) {}

  async atualizar(faixas: readonly FaixaComArquivo[]): Promise<Relatorio> {
    this.faixas = faixas;
    const r: Relatorio = { mantidos: 0, baixados: 0, recusados: [], apagados: 0, semRede: 0 };
    const guardaveis = new Map(faixas.filter((f) => f.faixa.licenca.permiteCacheOffline).map((f) => [nomeDe(f.faixa.id, f.arquivo.sha256), f]));
    for (const nome of await this.pasta.listar())
      if (!guardaveis.has(nome)) { await this.pasta.apagar(nome); r.apagados++; }

    for (const [nome, f] of guardaveis) {
      const local = await this.pasta.ler(nome);
      if (local && local.length === f.arquivo.bytes && sha(local) === f.arquivo.sha256) { r.mantidos++; continue; }
      if (local) await this.pasta.apagar(nome);
      const url = await this.api.urlDoArquivo(f.faixa.id);
      if (!url.ok) { r.semRede++; continue; }
      let bytes: Uint8Array;
      try { bytes = await this.baixar(url.dados.url); } catch { r.semRede++; continue; }
      if (bytes.length !== f.arquivo.bytes || sha(bytes) !== f.arquivo.sha256) { r.recusados.push(f.faixa.id); continue; }
      await this.pasta.gravar(nome, bytes);
      r.baixados++;
    }
    return r;
  }

  /** Arquivo guardado, ou endereço temporário para tocar sem guardar (precisa de rede), ou null. */
  async uriDe(trackRef: string): Promise<string | null> {
    const f = this.faixas.find((x) => x.faixa.id === trackRef);
    if (!f) return null;
    if (f.faixa.licenca.permiteCacheOffline) {
      const nome = nomeDe(f.faixa.id, f.arquivo.sha256);
      if ((await this.pasta.listar()).includes(nome)) return this.pasta.uri(nome);
    }
    const url = await this.api.urlDoArquivo(trackRef);
    return url.ok ? url.dados.url : null;
  }

  /** Apaga tudo o que foi baixado (apagar meus dados, ou sair da organização). */
  async apagarTudo(): Promise<number> {
    const nomes = await this.pasta.listar();
    for (const n of nomes) await this.pasta.apagar(n);
    return nomes.length;
  }
}
