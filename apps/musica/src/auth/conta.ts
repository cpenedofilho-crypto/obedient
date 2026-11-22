// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Conta da pessoa no app: a sessão do Supabase (auth/sessao.ts) e a organização escolhida. A organização
// sai do Growth OS (GET /api/eu), nunca de digitação: só aparecem as organizações ativas em que a pessoa
// é membro e cujo papel tem "musica:usar". Com uma, ela é escolhida sozinha; com várias, a pessoa escolhe.
// É também a fonte de Credenciais do cliente do Growth OS.
import type { ClienteGrowthOs, Credenciais, OrganizacaoDaPessoa } from "../api/cliente.ts";
import { gravarJson, type Kv, lerJson } from "../armazenamento/kv.ts";
import type { SessaoSupabase, Usuario } from "./sessao.ts";

export type EstadoConta =
  | { tipo: "fora" }
  | { tipo: "sem_organizacao"; usuario: Usuario }
  | { tipo: "escolher"; usuario: Usuario; organizacoes: OrganizacaoDaPessoa[] }
  | { tipo: "dentro"; usuario: Usuario; organizacao: OrganizacaoDaPessoa }
  | { tipo: "sem_rede"; usuario: Usuario };

export class Conta implements Credenciais {
  private escolhida: string | null = null;

  constructor(
    private readonly sessao: SessaoSupabase,
    private readonly kv: Kv,
  ) {}

  token() { return this.sessao.token(); }
  async organizacao() { return this.escolhida ?? (await lerJson<string | null>(this.kv, "organizacao", null)); }

  /** Estado atual, perguntando ao Growth OS onde a pessoa entra. */
  async estado(api: ClienteGrowthOs): Promise<EstadoConta> {
    const usuario = await this.sessao.usuario();
    if (!usuario || !(await this.sessao.token())) return { tipo: "fora" };
    const eu = await api.eu();
    if (!eu.ok) return eu.status === 401 ? (await this.sessao.sair(), { tipo: "fora" }) : { tipo: "sem_rede", usuario };
    const comMusica = eu.dados.organizacoes.filter((o) => o.permissoes.includes("musica:usar"));
    if (!comMusica.length) return { tipo: "sem_organizacao", usuario };
    const guardada = await this.organizacao();
    const atual = comMusica.find((o) => o.slug === guardada) ?? (comMusica.length === 1 ? comMusica[0]! : null);
    if (!atual) return { tipo: "escolher", usuario, organizacoes: comMusica };
    await this.escolher(atual.slug);
    return { tipo: "dentro", usuario, organizacao: atual };
  }

  async escolher(slug: string): Promise<void> {
    this.escolhida = slug;
    await gravarJson(this.kv, "organizacao", slug);
  }

  async sair(): Promise<void> {
    await this.sessao.sair();
    this.escolhida = null;
    await gravarJson(this.kv, "organizacao", null);
  }
}
