// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Sessão autenticada e contexto de transação.
//
//   token (do cliente) → hash → obedient.session_resolve() → usuário e reautenticação recente
//     → transação com SET LOCAL ROLE obedient_app e obedient.user_id = usuário → stores → motor
//
// O usuário da transação vem SÓ da sessão resolvida no banco, nunca do corpo da requisição. Com
// SET LOCAL, papel e usuário valem só dentro da transação e somem no commit: a conexão volta ao
// pool sem identidade nenhuma.

import { randomBytes } from "node:crypto";
import { type Clock, ObedientError, sha256Hex, systemClock } from "@obedient/core";
import { ApprovalGateway, AuditTrail, ConsentManager, EmergencyStop, EthicsEngine, type EthicsEngineDeps, GrantRegistry } from "@obedient/ethics-engine";
import type { Database, Executor } from "./db.ts";
import { lerIdentificacao } from "./missoes.ts";
import { PgAuditSink, PgConsentStore, PgGrantStore, PgProposalStore, PgStopStore } from "./stores.ts";

/** Reautenticação (senha, passkey, biometria) vale por 5 minutos para aprovar ação CRITICAL. */
export const STRONG_AUTH_WINDOW_MS = 5 * 60 * 1000;
export const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const ID_VALIDO = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

export interface Sessao {
  userId: string;
  /** Reautenticou dentro da janela: pode aprovar ação que exige autenticação forte. */
  strongAuth: boolean;
  expiresAt: Date;
}

export const hashDoToken = (token: string) => sha256Hex(`obedient.session:${token}`);

/** Abre transação com papel e usuário fixados. É o único jeito de os stores tocarem o banco. */
export async function comoUsuario<T>(db: Database, userId: string, fn: (tx: Executor) => Promise<T>): Promise<T> {
  if (!ID_VALIDO.test(userId) || userId === "*") throw new ObedientError("INVALID_PAYLOAD", "usuário inválido");
  return db.transaction(async (tx) => {
    await tx.query("set local role obedient_app");
    await tx.query("select set_config('obedient.user_id', $1, true)", [userId]);
    return fn(tx);
  });
}

/** Operador do serviço: só a parada global e a cadeia "*" (nunca os dados de um usuário). */
export async function comoOperador<T>(db: Database, fn: (tx: Executor) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query("set local role obedient_operator");
    await tx.query("select set_config('obedient.user_id', '', true)");
    return fn(tx);
  });
}

/** Serviço de entrada: sessões, passkeys, desafios e convites, nada de dado do usuário. */
export async function comoAutenticacao<T>(db: Database, fn: (tx: Executor) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query("set local role obedient_auth");
    return fn(tx);
  });
}

export class Sessoes {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock = systemClock,
  ) {}

  /**
   * Emite a sessão DEPOIS que o provedor de identidade confirmou a pessoa (fora deste pacote).
   * Devolve o token uma vez só; o banco guarda apenas o hash.
   */
  async emitir(userId: string, opts: { ttlMs?: number; strongAuth?: boolean } = {}): Promise<{ token: string; expiresAt: Date }> {
    if (!ID_VALIDO.test(userId) || userId === "*") throw new ObedientError("INVALID_PAYLOAD", "usuário inválido");
    const token = randomBytes(32).toString("base64url");
    const agora = this.clock.now();
    const expiresAt = new Date(agora.getTime() + (opts.ttlMs ?? DEFAULT_SESSION_TTL_MS));
    await comoAutenticacao(this.db, (tx) => tx.query("select obedient.session_issue($1, $2, $3, $4, $5)", [hashDoToken(token), userId, agora, expiresAt, opts.strongAuth ?? false]));
    return { token, expiresAt };
  }

  /** null = token desconhecido, vencido ou encerrado. */
  async resolver(token: string): Promise<Sessao | null> {
    if (typeof token !== "string" || token.length < 20 || token.length > 200) return null;
    const agora = this.clock.now();
    const { rows } = await comoAutenticacao(this.db, (tx) =>
      tx.query<{ user_id: string; strong_auth_at: unknown; expires_at: unknown }>("select * from obedient.session_resolve($1, $2)", [hashDoToken(token), agora]),
    );
    const r = rows[0];
    if (!r) return null;
    const forte = r.strong_auth_at ? new Date(r.strong_auth_at as string | Date) : null;
    return {
      userId: r.user_id,
      strongAuth: !!forte && agora.getTime() - forte.getTime() <= STRONG_AUTH_WINDOW_MS,
      expiresAt: new Date(r.expires_at as string | Date),
    };
  }

  /** Marca a reautenticação (o provedor de identidade acabou de confirmar a pessoa de novo). */
  async elevar(token: string): Promise<boolean> {
    const { rows } = await comoAutenticacao(this.db, (tx) => tx.query<{ ok: boolean }>("select obedient.session_elevate($1, $2) as ok", [hashDoToken(token), this.clock.now()]));
    return rows[0]?.ok === true;
  }

  async encerrar(token: string): Promise<boolean> {
    const { rows } = await comoAutenticacao(this.db, (tx) => tx.query<{ ok: boolean }>("select obedient.session_revoke($1, $2) as ok", [hashDoToken(token), this.clock.now()]));
    return rows[0]?.ok === true;
  }

  /**
   * O caminho de toda requisição autenticada: resolve o token e abre a transação do usuário. Sem
   * sessão válida, nada toca o banco do usuário.
   */
  async comSessao<T>(token: string, fn: (s: Sessao, tx: Executor) => Promise<T>): Promise<T> {
    const s = await this.resolver(token);
    if (!s) throw new ObedientError("UNAUTHENTICATED", "sessão inválida, vencida ou encerrada");
    return comoUsuario(this.db, s.userId, (tx) => fn(s, tx));
  }
}

export interface OpcoesMotor extends Pick<EthicsEngineDeps, "policiesFor" | "defaultsFor"> {
  /**
   * Art. 5º: exigir que mensagem em nome da pessoa leve a identificação que ela configurou
   * (obedient.preferences). O servidor liga; o motor fora do servidor não precisa.
   */
  exigirIdentificacao?: boolean;
  clock?: Clock;
  /** Ids dos operadores do serviço (liberam a parada global). */
  operators?: ReadonlySet<string>;
}

/**
 * Um Ethics Engine cujos stores escrevem nesta transação. Criado por requisição: o que o motor faz
 * (inclusive os ouvintes da parada) entra no mesmo commit ou some no mesmo rollback.
 */
export function motorNaTransacao(tx: Executor, o: OpcoesMotor = {}): EthicsEngine {
  const clock = o.clock ?? systemClock;
  return new EthicsEngine({
    clock,
    grants: new GrantRegistry(new PgGrantStore(tx), clock),
    consent: new ConsentManager(clock, new PgConsentStore(tx)),
    approvals: new ApprovalGateway(clock, undefined, new PgProposalStore(tx)),
    stop: new EmergencyStop(clock, o.operators ?? new Set(), new PgStopStore(tx)),
    audit: new AuditTrail(new PgAuditSink(tx), clock),
    ...(o.policiesFor ? { policiesFor: o.policiesFor } : {}),
    ...(o.defaultsFor ? { defaultsFor: o.defaultsFor } : {}),
    ...(o.exigirIdentificacao ? { identificacaoDe: (userId: string) => lerIdentificacao(tx, userId) } : {}),
  });
}
