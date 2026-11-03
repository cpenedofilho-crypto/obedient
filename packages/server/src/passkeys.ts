// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Entrada sem senha, por passkey (WebAuthn). Três fluxos:
//
//   convite      → código de uso único (linha de comando do dono) cadastra a primeira passkey
//   entrar       → a passkey do aparelho prova quem é; sai uma sessão
//   reautenticar → a mesma passkey, de novo, marca a sessão como "forte" por 5 minutos
//                  (é o que libera aprovar ação CRITICAL, Art. 1º)
//
// A verificação criptográfica é da @simplewebauthn/server. Aqui fica o que é nosso: cada desafio
// serve uma vez, para um propósito e (quando houver) para um usuário; vence em 5 minutos; a
// verificação do usuário no aparelho (biometria ou PIN do aparelho) é obrigatória; o contador da
// passkey não pode voltar atrás (passkey clonada).

import { randomBytes } from "node:crypto";
import { type Clock, ObedientError, sha256Hex, systemClock } from "@obedient/core";
import { type Database, type Executor, Sessoes, comoAutenticacao } from "@obedient/store-postgres";
import {
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";

export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const INVITE_TTL_MS = 24 * 60 * 60 * 1000;

export interface ConfigPasskey {
  /** Nome que o aparelho mostra ao cadastrar a passkey. */
  rpName: string;
  /** Domínio do app, sem esquema nem porta (ex.: obedient.exemplo.org; em desenvolvimento, localhost). */
  rpId: string;
  /** Origem exata do app (ex.: https://obedient.exemplo.org). */
  origin: string;
}

export const hashDoConvite = (codigo: string) => sha256Hex(`obedient.invite:${codigo.trim().toUpperCase()}`);

type Proposito = "enroll" | "login" | "reauth";

/** O desafio que o aparelho assinou, lido do clientDataJSON (sem confiar nele: só serve para achar a linha). */
function desafioDaResposta(r: { response?: { clientDataJSON?: unknown } }): string | null {
  try {
    const raw = r.response?.clientDataJSON;
    if (typeof raw !== "string" || raw.length > 4096) return null;
    const c = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { challenge?: unknown };
    return typeof c.challenge === "string" && c.challenge.length <= 200 ? c.challenge : null;
  } catch {
    return null;
  }
}

const recusa = (m: string): never => {
  throw new ObedientError("UNAUTHENTICATED", m);
};

export class Passkeys {
  private readonly sessoes: Sessoes;

  constructor(
    private readonly db: Database,
    private readonly cfg: ConfigPasskey,
    private readonly clock: Clock = systemClock,
  ) {
    this.sessoes = new Sessoes(db, clock);
  }

  /** Linha de comando do dono do servidor (conexão do dono do schema). Devolve o código uma vez só. */
  static async criarConvite(db: Database, userId: string, clock: Clock = systemClock): Promise<{ codigo: string; venceEm: Date }> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(userId)) throw new ObedientError("INVALID_PAYLOAD", "usuário inválido");
    // 10 caracteres sem 0/O/1/I: dá para ditar ou copiar à mão. 50 bits de entropia, uso único, 24 h.
    const alfabeto = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
    const codigo = [...randomBytes(10)].map((b) => alfabeto[b % alfabeto.length]).join("");
    const agora = clock.now();
    const venceEm = new Date(agora.getTime() + INVITE_TTL_MS);
    await db.query("insert into obedient.invites (code_hash, user_id, created_at, expires_at) values ($1, $2, $3, $4)", [hashDoConvite(codigo), userId, agora, venceEm]);
    return { codigo, venceEm };
  }

  // ------------------------------------------------------------------------------------- convite

  async opcoesDoConvite(codigo: string) {
    return comoAutenticacao(this.db, async (tx) => {
      const userId = await this.conviteValido(tx, codigo);
      const { rows } = await tx.query<{ id: string; transports: string[] }>("select id, transports from obedient.credentials where user_id = $1", [userId]);
      const opcoes = await generateRegistrationOptions({
        rpName: this.cfg.rpName,
        rpID: this.cfg.rpId,
        userName: userId,
        userID: new TextEncoder().encode(userId),
        attestationType: "none",
        excludeCredentials: rows.map((r) => ({ id: r.id, transports: r.transports })),
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        timeout: CHALLENGE_TTL_MS,
      });
      await this.guardarDesafio(tx, opcoes.challenge, "enroll", userId);
      return opcoes;
    });
  }

  async concluirConvite(codigo: string, resposta: RegistrationResponseJSON): Promise<{ token: string; userId: string }> {
    const userId = await comoAutenticacao(this.db, async (tx) => {
      const userId = await this.conviteValido(tx, codigo);
      const desafio = await this.usarDesafio(tx, desafioDaResposta(resposta), "enroll", userId);
      const v = await verifyRegistrationResponse({
        response: resposta,
        expectedChallenge: desafio,
        expectedOrigin: this.cfg.origin,
        expectedRPID: this.cfg.rpId,
        requireUserVerification: true,
      }).catch(() => recusa("passkey não confere"));
      if (!v.verified) recusa("passkey não confere");
      const c = v.registrationInfo!.credential;
      // O convite só se gasta junto com a passkey cadastrada (na mesma transação).
      const usado = await tx.query("update obedient.invites set used_at = $2 where code_hash = $1 and used_at is null returning user_id", [hashDoConvite(codigo), this.clock.now()]);
      if (!usado.rows.length) recusa("convite já usado");
      await tx.query("insert into obedient.credentials (id, user_id, public_key, counter, transports, created_at) values ($1, $2, $3, $4, $5, $6)", [
        c.id,
        userId,
        Buffer.from(c.publicKey),
        c.counter,
        c.transports ?? [],
        this.clock.now(),
      ]);
      return userId;
    });
    // Acabou de provar presença e verificação no aparelho: a sessão já nasce forte.
    const { token } = await this.sessoes.emitir(userId, { strongAuth: true });
    return { token, userId };
  }

  // -------------------------------------------------------------------------------------- entrar

  async opcoesDeEntrada() {
    return comoAutenticacao(this.db, async (tx) => {
      // Sem allowCredentials: a passkey é "descoberta" pelo aparelho, e o servidor não revela quem existe.
      const opcoes = await generateAuthenticationOptions({ rpID: this.cfg.rpId, userVerification: "required", timeout: CHALLENGE_TTL_MS });
      await this.guardarDesafio(tx, opcoes.challenge, "login", null);
      return opcoes;
    });
  }

  async entrar(resposta: AuthenticationResponseJSON): Promise<{ token: string; userId: string }> {
    const userId = await comoAutenticacao(this.db, async (tx) => {
      const desafio = await this.usarDesafio(tx, desafioDaResposta(resposta), "login", null);
      return this.conferirAssinatura(tx, resposta, desafio, null);
    });
    const { token } = await this.sessoes.emitir(userId, { strongAuth: true });
    return { token, userId };
  }

  // -------------------------------------------------------------------------------- reautenticar

  async opcoesDeReautenticacao(userId: string) {
    return comoAutenticacao(this.db, async (tx) => {
      const { rows } = await tx.query<{ id: string; transports: string[] }>("select id, transports from obedient.credentials where user_id = $1", [userId]);
      if (!rows.length) recusa("nenhuma passkey cadastrada");
      const opcoes = await generateAuthenticationOptions({
        rpID: this.cfg.rpId,
        userVerification: "required",
        timeout: CHALLENGE_TTL_MS,
        allowCredentials: rows.map((r) => ({ id: r.id, transports: r.transports })),
      });
      await this.guardarDesafio(tx, opcoes.challenge, "reauth", userId);
      return opcoes;
    });
  }

  /** Reautenticação da sessão `token`, que precisa ser do mesmo usuário da passkey. */
  async reautenticar(token: string, userId: string, resposta: AuthenticationResponseJSON): Promise<void> {
    await comoAutenticacao(this.db, async (tx) => {
      const desafio = await this.usarDesafio(tx, desafioDaResposta(resposta), "reauth", userId);
      await this.conferirAssinatura(tx, resposta, desafio, userId);
    });
    if (!(await this.sessoes.elevar(token))) recusa("sessão encerrada");
  }

  // ------------------------------------------------------------------------------------- interno

  private async conviteValido(tx: Executor, codigo: string): Promise<string> {
    if (typeof codigo !== "string" || codigo.trim().length < 8 || codigo.length > 64) recusa("convite inválido");
    const { rows } = await tx.query<{ user_id: string }>("select user_id from obedient.invites where code_hash = $1 and used_at is null and expires_at > $2", [hashDoConvite(codigo), this.clock.now()]);
    return rows[0]?.user_id ?? recusa("convite inválido, vencido ou já usado");
  }

  private async guardarDesafio(tx: Executor, challenge: string, purpose: Proposito, userId: string | null): Promise<void> {
    const agora = this.clock.now();
    await tx.query("insert into obedient.auth_challenges (challenge, user_id, purpose, created_at, expires_at) values ($1, $2, $3, $4, $5)", [
      challenge,
      userId,
      purpose,
      agora,
      new Date(agora.getTime() + CHALLENGE_TTL_MS),
    ]);
  }

  /** Marca o desafio como usado (uma vez só) e devolve-o. Propósito e usuário têm de bater. */
  private async usarDesafio(tx: Executor, challenge: string | null, purpose: Proposito, userId: string | null): Promise<string> {
    if (!challenge) recusa("resposta sem desafio");
    const { rows } = await tx.query<{ challenge: string }>(
      `update obedient.auth_challenges set used_at = $4
        where challenge = $1 and purpose = $2 and used_at is null and expires_at > $4
          and (user_id is not distinct from $3)
        returning challenge`,
      [challenge, purpose, userId, this.clock.now()],
    );
    return rows[0]?.challenge ?? recusa("desafio desconhecido, vencido ou já usado");
  }

  private async conferirAssinatura(tx: Executor, resposta: AuthenticationResponseJSON, desafio: string, esperado: string | null): Promise<string> {
    if (typeof resposta?.id !== "string" || resposta.id.length > 1024) recusa("passkey inválida");
    const { rows } = await tx.query<{ id: string; user_id: string; public_key: Uint8Array; counter: string | number; transports: string[] }>(
      "select id, user_id, public_key, counter, transports from obedient.credentials where id = $1",
      [resposta.id],
    );
    const c = rows[0] ?? recusa("passkey desconhecida");
    if (esperado !== null && c.user_id !== esperado) recusa("passkey de outro usuário");
    const contador = Number(c.counter);
    const v = await verifyAuthenticationResponse({
      response: resposta,
      expectedChallenge: desafio,
      expectedOrigin: this.cfg.origin,
      expectedRPID: this.cfg.rpId,
      requireUserVerification: true,
      credential: { id: c.id, publicKey: new Uint8Array(c.public_key), counter: contador, transports: c.transports as never },
    }).catch(() => recusa("passkey não confere"));
    if (!v.verified) recusa("passkey não confere");
    // Contador que não avança (quando a passkey usa contador) indica cópia da credencial.
    const novo = v.authenticationInfo.newCounter;
    if ((contador > 0 || novo > 0) && novo <= contador) recusa("passkey com contador repetido: pode ter sido copiada");
    await tx.query("update obedient.credentials set counter = $2, last_used_at = $3 where id = $1", [c.id, novo, this.clock.now()]);
    return c.user_id;
  }
}
