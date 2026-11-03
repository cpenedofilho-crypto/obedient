// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Missões e a identificação das mensagens sobre Postgres (Arts. 5º e 7º), na transação da sessão.

import { type Clock, ObedientError, systemClock } from "@obedient/core";
import type { EthicsEngine } from "@obedient/ethics-engine";
import { type EstadoMissao, type Missao, type MissionStore, Missoes, type TipoDesfecho } from "@obedient/missions";
import type { Executor } from "./db.ts";

interface LinhaMissao {
  id: string;
  user_id: string;
  agente: string;
  objetivo: string;
  estado: EstadoMissao;
  impedimento: string | null;
  desfecho_tipo: TipoDesfecho | null;
  desfecho_explicacao: string | null;
  tentativas: number;
  max_tentativas: number;
  proxima_tentativa_em: unknown;
  custo_centavos: number;
  teto_custo_centavos: number;
  proposta_id: string | null;
  rodada: unknown;
  criada_em: unknown;
  atualizada_em: unknown;
  versao: number;
}

/** A conversa guardada vai como JSON (null = nada guardado). */
const json = (v: unknown) => (v === null || v === undefined ? null : JSON.stringify(v));
const data = (v: unknown) => (v === null || v === undefined ? null : new Date(v as string | Date));

const paraMissao = (r: LinhaMissao): Missao => ({
  id: r.id,
  userId: r.user_id,
  agente: r.agente,
  objetivo: r.objetivo,
  estado: r.estado,
  impedimento: r.impedimento,
  desfecho: r.desfecho_tipo ? { tipo: r.desfecho_tipo, explicacao: r.desfecho_explicacao ?? "" } : null,
  tentativas: r.tentativas,
  maxTentativas: r.max_tentativas,
  proximaTentativaEm: data(r.proxima_tentativa_em),
  custoCentavos: r.custo_centavos,
  tetoCustoCentavos: r.teto_custo_centavos,
  propostaId: r.proposta_id,
  rodada: r.rodada ?? null,
  criadaEm: data(r.criada_em)!,
  atualizadaEm: data(r.atualizada_em)!,
  versao: r.versao,
});

export class PgMissionStore implements MissionStore {
  constructor(private readonly tx: Executor) {}
  async insert(m: Missao): Promise<void> {
    await this.tx.query(
      `insert into obedient.missions (id, user_id, agente, objetivo, estado, impedimento, desfecho_tipo, desfecho_explicacao, tentativas, max_tentativas,
         proxima_tentativa_em, custo_centavos, teto_custo_centavos, proposta_id, rodada, criada_em, atualizada_em, versao)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18)`,
      [m.id, m.userId, m.agente, m.objetivo, m.estado, m.impedimento, m.desfecho?.tipo ?? null, m.desfecho?.explicacao ?? null, m.tentativas, m.maxTentativas,
        m.proximaTentativaEm, m.custoCentavos, m.tetoCustoCentavos, m.propostaId, json(m.rodada), m.criadaEm, m.atualizadaEm, m.versao],
    );
  }
  async get(id: string): Promise<Missao | undefined> {
    const { rows } = await this.tx.query<LinhaMissao>("select * from obedient.missions where id = $1", [id]);
    return rows[0] ? paraMissao(rows[0]) : undefined;
  }
  async listByUser(userId: string): Promise<Missao[]> {
    const { rows } = await this.tx.query<LinhaMissao>("select * from obedient.missions where user_id = $1 order by criada_em, id", [userId]);
    return rows.map(paraMissao);
  }
  /** Um único UPDATE com a versão lida: com duas transações ao mesmo tempo, só uma acha a versão. */
  async update(m: Missao, versaoLida: number): Promise<boolean> {
    const { rows } = await this.tx.query(
      `update obedient.missions set estado = $3, impedimento = $4, desfecho_tipo = $5, desfecho_explicacao = $6, tentativas = $7,
         proxima_tentativa_em = $8, custo_centavos = $9, teto_custo_centavos = $10, proposta_id = $11, atualizada_em = $12, versao = $13,
         rodada = $14::jsonb
       where id = $1 and versao = $2 returning id`,
      [m.id, versaoLida, m.estado, m.impedimento, m.desfecho?.tipo ?? null, m.desfecho?.explicacao ?? null, m.tentativas,
        m.proximaTentativaEm, m.custoCentavos, m.tetoCustoCentavos, m.propostaId, m.atualizadaEm, m.versao, json(m.rodada)],
    );
    return rows.length > 0;
  }
}

export function missoesNaTransacao(tx: Executor, motor: EthicsEngine, clock: Clock = systemClock): Missoes {
  return new Missoes(new PgMissionStore(tx), motor, clock);
}

export const MAX_IDENTIFICACAO = 200;

/** Art. 5º: a identificação das mensagens enviadas em nome da pessoa. */
export async function lerIdentificacao(tx: Executor, userId: string): Promise<string | null> {
  const { rows } = await tx.query<{ identificacao: string | null }>("select identificacao from obedient.preferences where user_id = $1", [userId]);
  return rows[0]?.identificacao ?? null;
}

export async function gravarIdentificacao(tx: Executor, userId: string, texto: string, clock: Clock = systemClock): Promise<string> {
  const t = typeof texto === "string" ? texto.replace(/\s+/g, " ").trim() : "";
  if (t.length < 3 || t.length > MAX_IDENTIFICACAO) throw new ObedientError("INVALID_PAYLOAD", `a identificação precisa ter de 3 a ${MAX_IDENTIFICACAO} caracteres`);
  await tx.query(
    `insert into obedient.preferences (user_id, identificacao, atualizada_em) values ($1, $2, $3)
     on conflict (user_id) do update set identificacao = excluded.identificacao, atualizada_em = excluded.atualizada_em`,
    [userId, t, clock.now()],
  );
  return t;
}

/**
 * Para o agendador: QUEM tem missão para andar agora (só o id da pessoa). Roda com o papel do
 * operador, que não lê missão nenhuma: a função é a única coisa que ele pode chamar aqui.
 */
export async function pessoasComMissaoDevida(tx: Executor, agora: Date, limite = 100): Promise<string[]> {
  const { rows } = await tx.query<{ u: string }>("select obedient.pessoas_com_missao_devida($1, $2) as u", [agora, limite]);
  return rows.map((r) => r.u);
}
