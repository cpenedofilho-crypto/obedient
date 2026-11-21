// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Missões e a identificação das mensagens sobre Postgres (Arts. 5º e 7º), na transação da sessão.

import { type Clock, ObedientError, systemClock } from "@obedient/core";
import type { EthicsEngine } from "@obedient/ethics-engine";
import { type Ambiente, type Criterio, type EstadoMissao, type Evidencia, type Missao, type MissionStore, Missoes, type PlanoDaMissao, type TipoDesfecho } from "@obedient/missions";
import type { Executor } from "./db.ts";

interface LinhaMissao {
  id: string;
  user_id: string;
  agente: string;
  objetivo: string;
  criterios: Criterio[] | null;
  mandato_ferramentas: string[] | null;
  prazo_final_em: unknown;
  estado: EstadoMissao;
  impedimento: string | null;
  desfecho_tipo: TipoDesfecho | null;
  desfecho_explicacao: string | null;
  tentativas: number;
  max_tentativas: number;
  proxima_tentativa_em: unknown;
  reservada_ate: unknown;
  cerca: number | string;
  reservada_por: string | null;
  planejar: boolean;
  mandato_ambientes: Ambiente[] | null;
  plano_versao: number;
  plano_hash: string | null;
  plano_aprovado_em: unknown;
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
  criterios: Array.isArray(r.criterios) ? r.criterios : [],
  mandato: { ferramentas: Array.isArray(r.mandato_ferramentas) ? r.mandato_ferramentas : null, prazoFinalEm: data(r.prazo_final_em), ambientes: Array.isArray(r.mandato_ambientes) ? r.mandato_ambientes : null },
  planejar: r.planejar === true,
  planoVersao: Number(r.plano_versao ?? 0),
  // As tarefas entram depois (comPlano), numa consulta à parte.
  plano: r.plano_hash ? { versao: Number(r.plano_versao), hash: r.plano_hash, aprovadoEm: data(r.plano_aprovado_em), tarefas: [] } : null,
  estado: r.estado,
  impedimento: r.impedimento,
  desfecho: r.desfecho_tipo ? { tipo: r.desfecho_tipo, explicacao: r.desfecho_explicacao ?? "" } : null,
  tentativas: r.tentativas,
  maxTentativas: r.max_tentativas,
  proximaTentativaEm: data(r.proxima_tentativa_em),
  reservadaAte: data(r.reservada_ate),
  cerca: Number(r.cerca ?? 0),
  reservadaPor: r.reservada_por ?? null,
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
         proxima_tentativa_em, custo_centavos, teto_custo_centavos, proposta_id, rodada, criada_em, atualizada_em, versao, reservada_ate, criterios, mandato_ferramentas, prazo_final_em, planejar, mandato_ambientes)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18,$19,$20::jsonb,$21::jsonb,$22,$23,$24::jsonb)`,
      [m.id, m.userId, m.agente, m.objetivo, m.estado, m.impedimento, m.desfecho?.tipo ?? null, m.desfecho?.explicacao ?? null, m.tentativas, m.maxTentativas,
        m.proximaTentativaEm, m.custoCentavos, m.tetoCustoCentavos, m.propostaId, json(m.rodada), m.criadaEm, m.atualizadaEm, m.versao, m.reservadaAte, JSON.stringify(m.criterios ?? []),
        m.mandato?.ferramentas ? JSON.stringify(m.mandato.ferramentas) : null, m.mandato?.prazoFinalEm ?? null, m.planejar === true, m.mandato?.ambientes ? JSON.stringify(m.mandato.ambientes) : null],
    );
  }
  async get(id: string): Promise<Missao | undefined> {
    const { rows } = await this.tx.query<LinhaMissao>("select * from obedient.missions where id = $1", [id]);
    return rows[0] ? this.comPlano(paraMissao(rows[0])) : undefined;
  }
  async listByUser(userId: string): Promise<Missao[]> {
    const { rows } = await this.tx.query<LinhaMissao>("select * from obedient.missions where user_id = $1 order by criada_em, id", [userId]);
    const out: Missao[] = [];
    for (const r of rows) out.push(await this.comPlano(paraMissao(r)));
    return out;
  }
  /** Carrega as tarefas e dependências do plano em vigor, na ordem do plano. */
  private async comPlano(m: Missao): Promise<Missao> {
    if (!m.plano) return m;
    const t = await this.tx.query<{ chave: string; titulo: string }>("select chave, titulo from obedient.mission_tasks where mission_id = $1 and versao = $2 order by ordem", [m.id, m.plano.versao]);
    const d = await this.tx.query<{ chave: string; depende_de: string }>("select chave, depende_de from obedient.mission_task_deps where mission_id = $1 and versao = $2 order by chave, depende_de", [m.id, m.plano.versao]);
    m.plano.tarefas = t.rows.map((x) => ({ chave: x.chave, titulo: x.titulo, dependeDe: d.rows.filter((y) => y.chave === x.chave).map((y) => y.depende_de) }));
    return m;
  }
  async gravarPlano(m: Missao, plano: PlanoDaMissao): Promise<void> {
    for (const [i, t] of plano.tarefas.entries())
      await this.tx.query("insert into obedient.mission_tasks (mission_id, user_id, versao, chave, ordem, titulo, criado_em) values ($1, $2, $3, $4, $5, $6, $7)", [m.id, m.userId, plano.versao, t.chave, i, t.titulo, m.atualizadaEm]);
    for (const t of plano.tarefas)
      for (const dep of new Set(t.dependeDe))
        await this.tx.query("insert into obedient.mission_task_deps (mission_id, user_id, versao, chave, depende_de) values ($1, $2, $3, $4, $5)", [m.id, m.userId, plano.versao, t.chave, dep]);
  }
  async tarefasFeitas(missionId: string, versao: number): Promise<string[]> {
    const { rows } = await this.tx.query<{ chave: string }>("select chave from obedient.mission_tasks where mission_id = $1 and versao = $2 and estado = 'feita' order by ordem", [missionId, versao]);
    return rows.map((r) => r.chave);
  }
  async marcarTarefaFeita(m: Missao, versao: number, chave: string, em: Date): Promise<boolean> {
    const { rows } = await this.tx.query(
      "update obedient.mission_tasks set estado = 'feita', feita_em = $4, feita_tentativa = $5 where mission_id = $1 and versao = $2 and chave = $3 and estado = 'pendente' returning chave",
      [m.id, versao, chave, em, m.tentativas],
    );
    return rows.length > 0;
  }
  /** Um único UPDATE com a versão lida: com duas transações ao mesmo tempo, só uma acha a versão. */
  async update(m: Missao, versaoLida: number): Promise<boolean> {
    const { rows } = await this.tx.query(
      `update obedient.missions set estado = $3, impedimento = $4, desfecho_tipo = $5, desfecho_explicacao = $6, tentativas = $7,
         proxima_tentativa_em = $8, custo_centavos = $9, teto_custo_centavos = $10, proposta_id = $11, atualizada_em = $12, versao = $13,
         rodada = $14::jsonb, reservada_ate = $15, cerca = $16, reservada_por = $17,
         plano_versao = $18, plano_hash = $19, plano_aprovado_em = $20
       where id = $1 and versao = $2 returning id`,
      [m.id, versaoLida, m.estado, m.impedimento, m.desfecho?.tipo ?? null, m.desfecho?.explicacao ?? null, m.tentativas,
        m.proximaTentativaEm, m.custoCentavos, m.tetoCustoCentavos, m.propostaId, m.atualizadaEm, m.versao, json(m.rodada), m.reservadaAte, m.cerca, m.reservadaPor,
        m.planoVersao, m.plano?.hash ?? null, m.plano?.aprovadoEm ?? null],
    );
    return rows.length > 0;
  }
  /** Só inserção; numeradas por missão, na ordem em que o verificador as produziu. */
  async gravarEvidencias(m: Missao, evidencias: readonly Evidencia[]): Promise<void> {
    for (const ev of evidencias) {
      await this.tx.query(
        `insert into obedient.mission_evidence (mission_id, user_id, tentativa, seq, criterio, tipo, ok, referencia, detalhe, criado_em)
         select $1, $2, $3, coalesce(max(seq), 0) + 1, $4, $5, $6, $7, $8, $9 from obedient.mission_evidence where mission_id = $1`,
        [m.id, m.userId, m.tentativas, ev.criterio, ev.tipo, ev.ok, ev.referencia?.slice(0, 400) ?? null, ev.detalhe.slice(0, 500), m.atualizadaEm],
      );
    }
  }
  async registrarGasto(m: Missao, centavos: number, em: Date): Promise<void> {
    await this.tx.query("insert into obedient.mission_spend (user_id, mission_id, tentativa, centavos, em) values ($1, $2, $3, $4, $5)", [m.userId, m.id, m.tentativas, Math.ceil(centavos), em]);
  }
  async gastoDesde(userId: string, desde: Date): Promise<number> {
    const { rows } = await this.tx.query<{ total: string | number | null }>("select coalesce(sum(centavos), 0) as total from obedient.mission_spend where user_id = $1 and em >= $2", [userId, desde]);
    return Number(rows[0]?.total ?? 0);
  }
  async evidencias(missionId: string): Promise<(Evidencia & { tentativa: number })[]> {
    const { rows } = await this.tx.query<{ tentativa: number; criterio: number | null; tipo: Evidencia["tipo"]; ok: boolean; referencia: string | null; detalhe: string }>(
      "select tentativa, criterio, tipo, ok, referencia, detalhe from obedient.mission_evidence where mission_id = $1 order by seq",
      [missionId],
    );
    return rows.map((r) => ({ tentativa: r.tentativa, criterio: r.criterio, tipo: r.tipo, ok: r.ok, referencia: r.referencia, detalhe: r.detalhe }));
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
