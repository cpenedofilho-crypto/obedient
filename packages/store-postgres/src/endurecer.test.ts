// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Migration 0007: o que o banco recusa mesmo quando alguém tem SQL na transação da pessoa (o papel
// do app). Atalhos que nem o motor permite: proposta que nasce aprovada, transição que pula etapa,
// aprovação em nome de outro, entrada de auditoria vazia, e testar se existe proposta de outra pessoa.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { ManualClock } from "@obedient/core";
import type { GrantSpec } from "@obedient/ethics-engine";
import { bancoDeTeste, type BancoDeTeste } from "./banco-de-teste.ts";
import { comoUsuario, missoesNaTransacao, motorNaTransacao, type Executor } from "./index.ts";

const T0 = new Date("2026-11-10T12:00:00Z");
const H = 3_600_000;
const clock = new ManualClock(T0);

let banco: BancoDeTeste;
before(async () => {
  banco = await bancoDeTeste();
});
after(async () => {
  await banco.fechar();
});

let n = 0;
const usuario = (nome: string) => `${nome}-endurecer-${++n}`;
const como = <T>(u: string, fn: (m: ReturnType<typeof motorNaTransacao>, tx: Executor) => Promise<T>) => comoUsuario(banco.db, u, (tx) => fn(motorNaTransacao(tx, { clock }), tx));
// 23514: o gatilho recusou; 42501: o papel nem tem o privilégio na coluna. Os dois são "não".
const recusa = (e: unknown) => ["23514", "42501"].includes((e as { code?: string }).code ?? "") || /check_violation|transição|nasce pendente|sem grant|própria pessoa|inconsistente|só status/.test(String((e as Error).message));

const spec = (userId: string): GrantSpec => ({
  userId,
  agentId: "obedient",
  systemId: "mail",
  capability: "mail.*",
  purpose: "responder e-mails de trabalho",
  limits: { maxRisk: "HIGH", autonomousUpTo: "MEDIUM", maxAmount: null, amountField: null },
  expiresAt: new Date(T0.getTime() + 8 * H),
});

/** Uma proposta HIGH pendente, pelo motor. */
async function pendente(u: string) {
  await como(u, (m) => m.grants.grant(spec(u), u));
  const a = await como(u, (m) => m.authorize({ userId: u, agentId: "obedient", systemId: "mail", tool: "mail.send", risk: "HIGH", category: "COMMUNICATION", args: { to: "x@example.org" } }));
  if (a.outcome !== "approval_required") throw new Error("esperava proposta");
  return a.proposal;
}

describe("0007: máquina de estados das propostas no banco", () => {
  it("proposta não nasce aprovada nem sem grant, mesmo inserida direto pelo papel do app", async () => {
    const u = usuario("ana");
    const p = await pendente(u);
    const inserir = (status: string, grant: string | null) =>
      como(u, (_m, tx) =>
        tx.query(
          `insert into obedient.proposals (id, user_id, requested_by, payload, payload_hash, summary, approver, reason, grant_id, created_at, expires_at, status, decided_by, decided_at)
           values ($1, $2, 'agent:obedient', '{}', $3, 'x', 'user', 'x', $4, $5, $6, $7, $8, $9)`,
          [`forjada-${++n}`, u, "f".repeat(64), grant, T0, new Date(T0.getTime() + H), status, status === "approved" ? u : null, status === "approved" ? T0 : null],
        ),
      );
    await assert.rejects(inserir("approved", p.grantId), recusa, "já aprovada");
    await assert.rejects(inserir("pending", null), recusa, "sem grant");
    await inserir("pending", p.grantId); // a forma certa continua aceita
  });

  it("status só anda pelas transições do motor; aprovar só em nome da própria pessoa", async () => {
    const u = usuario("ana");
    const p = await pendente(u);
    const mudar = (sets: string, params: unknown[] = []) => como(u, (_m, tx) => tx.query(`update obedient.proposals set ${sets} where id = $1`, [p.id, ...params]));
    await assert.rejects(mudar("status = 'executing'"), recusa, "pending → executing pula a aprovação");
    await assert.rejects(mudar("status = 'executed', executed_at = now()"), recusa, "pending → executed");
    await assert.rejects(mudar("status = 'approved', decided_by = 'agent:obedient', decided_at = now()"), recusa, "o agente não aprova");
    await assert.rejects(mudar("status = 'approved', decided_by = 'outra-pessoa', decided_at = now()"), recusa, "outra pessoa não aprova");
    await assert.rejects(mudar("payload_hash = $2", ["0".repeat(64)]), recusa, "o hash aprovado não muda");
    await assert.rejects(mudar("decided_by = $2", [u]), recusa, "decisão sem mudar o status");

    // O caminho do motor continua: aprovar, executar uma vez.
    await como(u, (m) => m.approve(p.id, { id: u, kind: "user", strongAuth: false }, p.payloadHash));
    assert.equal(await como(u, (m) => m.executeApproved(p.id, p.payloadHash, async () => "ok")), "ok");
    await assert.rejects(mudar("status = 'approved'"), recusa, "executada não volta a aprovada");
    await assert.rejects(mudar("status = 'executing'"), recusa, "executada não volta a executar");
  });

  it("parar e apagar continuam funcionando (cancelam e esvaziam pelo caminho deles)", async () => {
    const u = usuario("ana");
    const p = await pendente(u);
    await como(u, (m) => m.stop.engage({ kind: "user", userId: u }, u, "parar"));
    assert.equal((await como(u, (m) => m.approvals.get(p.id)))?.status, "rejected");
  });
});

describe("0007: auditoria", () => {
  it("entrada com a cadeia certa mas JSON vazio é recusada (antes entrava e quebrava a verificação para sempre)", async () => {
    const u = usuario("ana");
    await pendente(u); // authorize grava na trilha: a cadeia já tem cabeça
    const forjar = (entry: Record<string, unknown>) =>
      como(u, async (_m, tx) => {
        await tx.query("select obedient.audit_lock($1)", [u]);
        const h = (await tx.query<{ seq: number; hash: string }>("select seq, hash from obedient.audit_log where user_id = $1 order by seq desc limit 1", [u])).rows[0]!;
        await tx.query("insert into obedient.audit_log (user_id, seq, prev_hash, hash, entry) values ($1, $2, $3, $4, $5)", [u, h.seq + 1, h.hash, "a".repeat(64), JSON.stringify(entry)]);
      });
    await assert.rejects(forjar({}), recusa);
    await assert.rejects(forjar({ seq: 99 }), recusa);
    assert.equal(await como(u, (m) => m.audit.verify(u)), true, "a cadeia continua íntegra");
  });
});

describe("0007: missão só aponta para proposta da mesma pessoa", () => {
  it("o id de uma proposta de outra pessoa é recusado igual a um id inexistente (sem oráculo de existência)", async () => {
    const ana = usuario("ana");
    const bob = usuario("bob");
    const daAna = await pendente(ana);
    const missao = await comoUsuario(banco.db, bob, (tx) => missoesNaTransacao(tx, motorNaTransacao(tx, { clock }), clock).criar(bob, "obedient", "testar ids"));
    const vincular = (propostaId: string) => comoUsuario(banco.db, bob, (tx) => tx.query("update obedient.missions set proposta_id = $2 where id = $1", [missao.id, propostaId]));
    const erro = async (id: string) => {
      try {
        await vincular(id);
        return "aceito";
      } catch (e) {
        return (e as { code?: string }).code ?? "erro";
      }
    };
    assert.equal(await erro(daAna.id), await erro("nao-existe"), "a mesma recusa nos dois casos");
    assert.notEqual(await erro(daAna.id), "aceito");
  });
});
