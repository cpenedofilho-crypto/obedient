// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// O registro de passos das missões (decisão D20, marco M1), na transação da sessão (RLS por pessoa).
// Só inserção: um passo nunca é alterado; o fim de uma chamada é outra linha que aponta para o início.

import type { ToolCategory } from "@obedient/core";
import type { Executor } from "./db.ts";

export const TIPOS_PASSO = ["modelo", "inicio", "ferramenta", "recusada", "retomada", "incerto"] as const;
export type TipoPasso = (typeof TIPOS_PASSO)[number];

export interface NovoPasso {
  missionId: string;
  userId: string;
  tentativa: number;
  tipo: TipoPasso;
  status: string;
  decisao?: string | null;
  ferramenta?: string | null;
  categoria?: ToolCategory | null;
  hashArgumentos?: string | null;
  /** Chave de idempotência. Num 'inicio' sem chave, o banco gera "missão:tentativa:passo". */
  chave?: string | null;
  aprovacaoId?: string | null;
  /** O passo que esta linha fecha (um 'inicio'). */
  fecha?: { tentativa: number; seq: number } | null;
  tokensEntrada?: number | null;
  tokensSaida?: number | null;
  /** Cerca da reserva em que o passo é gravado (M5); o banco recusa a que não for a atual. */
  cerca?: number | null;
  criadoEm: Date;
}

export interface PassoGravado extends Required<Omit<NovoPasso, "fecha" | "criadoEm">> {
  seq: number;
  fecha: { tentativa: number; seq: number } | null;
  criadoEm: Date;
}

interface Linha {
  mission_id: string;
  user_id: string;
  tentativa: number;
  seq: number;
  tipo: TipoPasso;
  status: string;
  decisao: string | null;
  ferramenta: string | null;
  categoria: ToolCategory | null;
  hash_argumentos: string | null;
  chave: string | null;
  aprovacao_id: string | null;
  fecha_tentativa: number | null;
  fecha_seq: number | null;
  tokens_entrada: number | null;
  tokens_saida: number | null;
  cerca: number | string | null;
  criado_em: unknown;
}

const paraPasso = (r: Linha): PassoGravado => ({
  missionId: r.mission_id,
  userId: r.user_id,
  tentativa: r.tentativa,
  seq: r.seq,
  tipo: r.tipo,
  status: r.status,
  decisao: r.decisao,
  ferramenta: r.ferramenta,
  categoria: r.categoria,
  hashArgumentos: r.hash_argumentos,
  chave: r.chave,
  aprovacaoId: r.aprovacao_id,
  fecha: r.fecha_seq === null || r.fecha_tentativa === null ? null : { tentativa: r.fecha_tentativa, seq: r.fecha_seq },
  tokensEntrada: r.tokens_entrada,
  tokensSaida: r.tokens_saida,
  cerca: r.cerca === null || r.cerca === undefined ? null : Number(r.cerca),
  criadoEm: new Date(r.criado_em as string | Date),
});

const corta = (v: string | null | undefined, n: number) => (v === null || v === undefined ? null : v.slice(0, n));

export interface Passos {
  /** Grava o passo com o próximo número da tentativa; devolve o número e a chave gravada. */
  registrar(p: NovoPasso): Promise<{ seq: number; chave: string | null }>;
  /** Todos os passos da missão, em ordem. */
  daMissao(missionId: string): Promise<PassoGravado[]>;
  /** Inícios de chamada sem fim gravado: a chamada pode ter acontecido ou não. */
  abertos(missionId: string): Promise<PassoGravado[]>;
}

export function passosNaTransacao(tx: Executor): Passos {
  return {
    async registrar(p) {
      const r = await tx.query<{ seq: number; chave: string | null }>(
        `insert into obedient.mission_steps
           (mission_id, user_id, tentativa, seq, tipo, status, decisao, ferramenta, categoria, hash_argumentos, chave,
            aprovacao_id, fecha_tentativa, fecha_seq, tokens_entrada, tokens_saida, criado_em, cerca)
         select $1, $2, $3::integer, n.seq, $4, $5, $6, $7, $8, $9,
                coalesce($10::text, case when $4 = 'inicio' then $1 || ':' || $3::integer || ':' || n.seq end),
                $11, $12, $13, $14, $15, $16, $17
           from (select coalesce(max(seq), 0) + 1 as seq from obedient.mission_steps where mission_id = $1 and tentativa = $3::integer) n
         returning seq, chave`,
        [
          p.missionId, p.userId, p.tentativa, p.tipo, corta(p.status, 60) || "?", corta(p.decisao, 200), corta(p.ferramenta, 200),
          p.categoria ?? null, p.hashArgumentos ?? null, corta(p.chave, 200), p.aprovacaoId ?? null,
          p.fecha?.tentativa ?? null, p.fecha?.seq ?? null, p.tokensEntrada ?? null, p.tokensSaida ?? null, p.criadoEm, p.cerca ?? null,
        ],
      );
      return { seq: r.rows[0]!.seq, chave: r.rows[0]!.chave };
    },
    async daMissao(missionId) {
      const r = await tx.query<Linha>("select * from obedient.mission_steps where mission_id = $1 order by tentativa, seq", [missionId]);
      return r.rows.map(paraPasso);
    },
    async abertos(missionId) {
      const r = await tx.query<Linha>(
        `select i.* from obedient.mission_steps i
          where i.mission_id = $1 and i.tipo = 'inicio'
            and not exists (select 1 from obedient.mission_steps f
                             where f.mission_id = i.mission_id and f.fecha_tentativa = i.tentativa and f.fecha_seq = i.seq)
          order by i.tentativa, i.seq`,
        [missionId],
      );
      return r.rows.map(paraPasso);
    },
  };
}
