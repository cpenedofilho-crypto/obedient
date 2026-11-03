// SPDX-License-Identifier: AGPL-3.0-only
//
// O Ethics Engine sobre Postgres. Três perguntas:
//   1. o motor decide igual ao da memória? (mesmos cenários de engine.test.ts e da suíte constitucional)
//   2. a RLS separa os usuários mesmo quando o código pede a linha do outro?
//   3. a auditoria é só de inclusão, com a cadeia conferida pelo banco?

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { ManualClock } from "@obedient/core";
import { CONSTITUTION_VERSION, type GrantSpec } from "@obedient/ethics-engine";
import { bancoDeTeste, type BancoDeTeste } from "./banco-de-teste.ts";
import { Sessoes, STRONG_AUTH_WINDOW_MS, comoOperador, comoUsuario, migrate, motorNaTransacao, type Executor } from "./index.ts";

const T0 = new Date("2026-11-03T12:00:00Z");
const H = 3_600_000;

let banco: BancoDeTeste;
let clock = new ManualClock(T0);
before(async () => {
  banco = await bancoDeTeste();
});
after(async () => {
  await banco.fechar();
});

let n = 0;
/** Usuários novos por teste: o banco é compartilhado e nada é apagado (nem dá para apagar a auditoria). */
const usuario = (nome: string) => `${nome}-${++n}`;

function spec(userId: string, extra: Partial<GrantSpec> = {}): GrantSpec {
  return {
    userId,
    agentId: "obedient",
    systemId: "mail",
    capability: "mail.*",
    purpose: "responder e-mails de trabalho",
    limits: { maxRisk: "HIGH", autonomousUpTo: "MEDIUM", maxAmount: null, amountField: null },
    expiresAt: new Date(T0.getTime() + 8 * H),
    ...extra,
  };
}

const pedido = (userId: string, tool: string, risk: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL", category = "WRITE", extra: Record<string, unknown> = {}) => ({
  userId,
  agentId: "obedient",
  systemId: "mail",
  tool,
  risk,
  category,
  args: { to: "x@example.org" },
  ...extra,
});

/** Cada chamada = uma requisição: transação do usuário, motor novo, commit no fim. */
function como<T>(userId: string, fn: (m: ReturnType<typeof motorNaTransacao>, tx: Executor) => Promise<T>): Promise<T> {
  return comoUsuario(banco.db, userId, (tx) => fn(motorNaTransacao(tx, { clock, operators: new Set(["op-1"]) }), tx));
}

const codigo = (e: unknown) => (e as { code?: string }).code;

describe("store-postgres: o motor decide igual sobre o banco", () => {
  before(() => {
    clock = new ManualClock(T0);
  });

  it("migration é idempotente", async () => {
    assert.deepEqual(await migrate(banco.db), []);
  });

  it("sem grant nega; com grant, MEDIUM autônomo passa e HIGH vira proposta (Art. 1º e 3º)", async () => {
    const u = usuario("ana");
    assert.equal((await como(u, (m) => m.authorize(pedido(u, "mail.send", "MEDIUM")))).outcome, "denied");
    await como(u, (m) => m.grants.grant(spec(u), u));
    assert.equal((await como(u, (m) => m.authorize(pedido(u, "mail.send", "MEDIUM")))).outcome, "allowed");
    assert.equal((await como(u, (m) => m.authorize(pedido(u, "mail.send", "HIGH", "COMMUNICATION")))).outcome, "approval_required");
    for (const c of ["FINANCIAL", "LEGAL", "DESTRUCTIVE"]) assert.equal((await como(u, (m) => m.authorize(pedido(u, "mail.x", "LOW", c)))).outcome, "denied", c);
  });

  it("revogação vale na próxima chamada e desce para a subdelegação (Art. 2º e 12)", async () => {
    const u = usuario("ana");
    const pai = await como(u, (m) => m.grants.grant(spec(u), u));
    const filho = await como(u, (m) =>
      m.grants.delegate(pai.id, { agentId: "dots", systemId: "mail", capability: "mail.list_*", purpose: "ler a caixa para o resumo", limits: { maxRisk: "LOW", autonomousUpTo: "LOW", maxAmount: null, amountField: null }, expiresAt: new Date(T0.getTime() + H) }, "obedient"),
    );
    await assert.rejects(
      como(u, (m) => m.grants.delegate(pai.id, { agentId: "dots", systemId: "mail", capability: "mail.*", purpose: "tudo do pai e mais", limits: { maxRisk: "CRITICAL", autonomousUpTo: null, maxAmount: null, amountField: null }, expiresAt: new Date(T0.getTime() + H) }, "obedient")),
      (e) => codigo(e) === "DELEGATION_EXCEEDS_PARENT",
    );
    assert.ok(await como(u, (m) => m.grants.findCovering(u, "dots", "mail", "mail.list_inbox")));
    const revogados = await como(u, (m) => m.grants.revoke(pai.id, u));
    assert.deepEqual(revogados.map((g) => g.id).sort(), [pai.id, filho.id].sort());
    assert.equal(await como(u, (m) => m.grants.findCovering(u, "dots", "mail", "mail.list_inbox")), null);
    assert.equal((await como(u, (m) => m.authorize(pedido(u, "mail.list", "LOW", "READ")))).outcome, "denied");
  });

  it("prazo vencido acaba com a autoridade (Art. 3º)", async () => {
    const u = usuario("ana");
    const c = new ManualClock(T0);
    await comoUsuario(banco.db, u, (tx) => motorNaTransacao(tx, { clock: c }).grants.grant(spec(u), u));
    c.advance(9 * H);
    const r = await comoUsuario(banco.db, u, (tx) => motorNaTransacao(tx, { clock: c }).authorize(pedido(u, "mail.list", "LOW", "READ")));
    assert.equal(r.outcome, "denied");
  });

  it("dado pessoal só com consentimento; sensível só com consentimento específico; revogar é imediato (Art. 4º)", async () => {
    const u = usuario("ana");
    await como(u, (m) => m.grants.grant(spec(u), u));
    const r = (cats: string[]) => como(u, async (m) => (await m.authorize(pedido(u, "mail.list", "LOW", "READ", { dataCategories: cats, purpose: "agenda" }))).outcome);
    assert.equal(await r(["contacts"]), "denied");
    await como(u, (m) => m.consent.give(u, "agenda", "contacts"));
    assert.equal(await r(["contacts"]), "allowed");
    await como(u, (m) => m.consent.give(u, "agenda", "health"));
    assert.equal(await r(["health"]), "denied");
    await como(u, (m) => m.consent.give(u, "agenda", "health", { specific: true }));
    assert.equal(await r(["health"]), "allowed");
    assert.equal(await como(u, (m) => m.consent.revoke(u, "agenda", "contacts")), 1);
    assert.equal(await r(["contacts"]), "denied");
    assert.equal((await como(u, (m) => m.consent.export(u))).length, 3);
  });

  it("proposta: quem pede não aprova; aprova-se o hash visto; executa uma vez só (Art. 12)", async () => {
    const u = usuario("ana");
    await como(u, (m) => m.grants.grant(spec(u), u));
    const a = await como(u, (m) => m.authorize(pedido(u, "mail.send", "HIGH", "COMMUNICATION")));
    if (a.outcome !== "approval_required") throw new Error("esperava proposta");
    const p = a.proposal;
    await assert.rejects(como(u, (m) => m.approve(p.id, { id: "obedient", kind: "agent", strongAuth: true }, p.payloadHash)), (e) => codigo(e) === "APPROVER_NOT_HUMAN");
    await assert.rejects(como(u, (m) => m.approve(p.id, { id: "agent:obedient", kind: "user", strongAuth: true }, p.payloadHash)), (e) => codigo(e) === "SELF_APPROVAL");
    await assert.rejects(como(u, (m) => m.approve(p.id, { id: u, kind: "user", strongAuth: false }, "0".repeat(64))), (e) => codigo(e) === "PAYLOAD_MISMATCH");
    assert.equal((await como(u, (m) => m.approve(p.id, { id: u, kind: "user", strongAuth: false }, p.payloadHash))).status, "approved");
    await assert.rejects(como(u, (m) => m.approve(p.id, { id: u, kind: "user", strongAuth: false }, p.payloadHash)), (e) => codigo(e) === "PROPOSAL_NOT_PENDING");

    let execucoes = 0;
    const executar = () => como(u, (m) => m.executeApproved(p.id, p.payloadHash, async () => ++execucoes));
    assert.equal(await executar(), 1);
    await assert.rejects(executar(), (e) => codigo(e) === "ALREADY_EXECUTED");
    assert.equal(execucoes, 1);
    assert.equal((await como(u, (m) => m.approvals.get(p.id)))?.status, "executed");
  });

  it("duas execuções simultâneas da mesma proposta: só uma passa", async () => {
    const u = usuario("ana");
    await como(u, (m) => m.grants.grant(spec(u), u));
    const a = await como(u, (m) => m.authorize(pedido(u, "mail.send", "HIGH", "COMMUNICATION")));
    if (a.outcome !== "approval_required") throw new Error("esperava proposta");
    await como(u, (m) => m.approve(a.proposal.id, { id: u, kind: "user", strongAuth: false }, a.proposal.payloadHash));
    let execucoes = 0;
    const r = await Promise.allSettled(
      Array.from({ length: 4 }, () => como(u, (m) => m.executeApproved(a.proposal.id, a.proposal.payloadHash, async () => ++execucoes))),
    );
    assert.equal(r.filter((x) => x.status === "fulfilled").length, 1, JSON.stringify(r.map((x) => x.status)));
    assert.equal(execucoes, 1);
  });

  it("CRITICAL exige reautenticação; proposta vence (Art. 1º)", async () => {
    const u = usuario("ana");
    const c = new ManualClock(T0);
    const m = <T>(fn: (e: ReturnType<typeof motorNaTransacao>) => Promise<T>) => comoUsuario(banco.db, u, (tx) => fn(motorNaTransacao(tx, { clock: c })));
    await m((e) => e.grants.grant(spec(u, { limits: { maxRisk: "CRITICAL", autonomousUpTo: "MEDIUM", maxAmount: null, amountField: null } }), u));
    const a = await m((e) => e.authorize(pedido(u, "mail.delete_all", "LOW", "DESTRUCTIVE")));
    if (a.outcome !== "approval_required") throw new Error("esperava proposta");
    assert.equal(a.proposal.approver, "user_strong_auth");
    await assert.rejects(m((e) => e.approve(a.proposal.id, { id: u, kind: "user", strongAuth: false }, a.proposal.payloadHash)), (e) => codigo(e) === "STRONG_AUTH_REQUIRED");
    c.advance(31 * 60 * 1000);
    await assert.rejects(m((e) => e.approve(a.proposal.id, { id: u, kind: "user", strongAuth: true }, a.proposal.payloadHash)), (e) => codigo(e) === "PROPOSAL_EXPIRED");
    assert.equal((await m((e) => e.approvals.get(a.proposal.id)))?.status, "expired");
  });

  it("parada do usuário bloqueia, cancela propostas e só ele libera (Art. 9º)", async () => {
    const u = usuario("ana");
    await como(u, (m) => m.grants.grant(spec(u), u));
    await como(u, (m) => m.authorize(pedido(u, "mail.send", "HIGH", "COMMUNICATION")));
    await como(u, (m) => m.stop.engage({ kind: "user", userId: u }, u, "apertei parar"));
    assert.equal((await como(u, (m) => m.authorize(pedido(u, "mail.list", "LOW", "READ")))).outcome, "denied");
    assert.equal((await como(u, (m) => m.approvals.pending(u))).length, 0);
    await assert.rejects(como(u, (m) => m.stop.release({ kind: "user", userId: u }, "obedient", "agent")));
    await como(u, (m) => m.stop.release({ kind: "user", userId: u }, u, "user"));
    assert.equal((await como(u, (m) => m.authorize(pedido(u, "mail.list", "LOW", "READ")))).outcome, "allowed");
  });

  it("parada global: o operador aciona e libera; todo usuário fica bloqueado; usuário não mexe nela", async () => {
    const u = usuario("ana");
    await como(u, (m) => m.grants.grant(spec(u), u));
    const operador = <T>(fn: (m: ReturnType<typeof motorNaTransacao>) => Promise<T>) =>
      comoOperador(banco.db, (tx) => fn(motorNaTransacao(tx, { clock, operators: new Set(["op-1"]) })));
    // Usuário não aciona a global: a RLS recusa a linha sem dono.
    await assert.rejects(como(u, (m) => m.stop.engage({ kind: "global" }, u, "não é meu")));
    await operador((m) => m.stop.engage({ kind: "global" }, "op-1", "incidente"));
    assert.equal((await como(u, (m) => m.authorize(pedido(u, "mail.list", "LOW", "READ")))).outcome, "denied");
    // Tentar apagar a global de dentro da sessão do usuário não apaga nada.
    await como(u, (_m, tx) => tx.query("delete from obedient.emergency_stops where scope_key = 'global'"));
    assert.equal((await como(u, (m) => m.authorize(pedido(u, "mail.list", "LOW", "READ")))).outcome, "denied");
    await operador((m) => m.stop.release({ kind: "global" }, "op-1", "operator"));
    assert.equal((await como(u, (m) => m.authorize(pedido(u, "mail.list", "LOW", "READ")))).outcome, "allowed");
    // A parada global ficou na cadeia "*", que o operador confere.
    assert.equal(await comoOperador(banco.db, (tx) => motorNaTransacao(tx).audit.verify("*")), true);
  });

  it("toda decisão fica na cadeia do usuário, com a versão da Constituição (Art. 8º)", async () => {
    const u = usuario("ana");
    await como(u, (m) => m.authorize(pedido(u, "mail.list", "LOW", "READ")));
    await como(u, (m) => m.grants.grant(spec(u), u));
    await como(u, (m) => m.authorize(pedido(u, "mail.list", "LOW", "READ")));
    await como(u, (m) => m.authorize(pedido(u, "mail.send", "HIGH", "COMMUNICATION")));
    const trilha = await como(u, (m) => m.audit.forUser(u));
    assert.deepEqual(trilha.map((e) => [e.seq, e.outcome]), [[1, "denied"], [2, "allowed"], [3, "approval_required"]]);
    assert.ok(trilha.every((e) => e.constitutionVersion === CONSTITUTION_VERSION));
    assert.equal(await como(u, (m) => m.audit.verify(u)), true);
  });

  it("gravações simultâneas do mesmo usuário mantêm a cadeia válida", async () => {
    const u = usuario("ana");
    await como(u, (m) => m.grants.grant(spec(u), u));
    await Promise.all(Array.from({ length: 12 }, () => como(u, (m) => m.authorize(pedido(u, "mail.list", "LOW", "READ")))));
    const trilha = await como(u, (m) => m.audit.forUser(u));
    assert.equal(trilha.length, 12);
    assert.deepEqual(trilha.map((e) => e.seq), Array.from({ length: 12 }, (_, i) => i + 1));
    assert.equal(await como(u, (m) => m.audit.verify(u)), true);
  });
});

describe("store-postgres: isolamento entre usuários (RLS)", () => {
  it("o que é de um usuário não aparece nem muda na sessão de outro", async () => {
    const ana = usuario("ana");
    const bia = usuario("bia");
    const g = await como(ana, (m) => m.grants.grant(spec(ana), ana));
    await como(ana, (m) => m.consent.give(ana, "agenda", "contacts"));
    const a = await como(ana, (m) => m.authorize(pedido(ana, "mail.send", "HIGH", "COMMUNICATION")));
    if (a.outcome !== "approval_required") throw new Error("esperava proposta");

    // Bia pede, pelo id, as coisas da Ana: nada existe para ela.
    assert.equal(await como(bia, (m) => m.grants.get(g.id)), undefined);
    assert.deepEqual(await como(bia, (m) => m.grants.list(ana)), []);
    assert.deepEqual(await como(bia, (m) => m.consent.export(ana)), []);
    assert.equal(await como(bia, (m) => m.approvals.get(a.proposal.id)), undefined);
    assert.deepEqual(await como(bia, (m) => m.audit.forUser(ana)), []);
    // Pedido em nome da Ana dentro da sessão da Bia: a requisição falha inteira (nada é autorizado
    // nem gravado na trilha de ninguém).
    await assert.rejects(como(bia, (m) => m.authorize(pedido(ana, "mail.list", "LOW", "READ"))), (e) => codigo(e) === "UNAUTHENTICATED");

    // Bia tenta aprovar a proposta da Ana se passando por ela: a proposta não existe na sessão dela.
    await assert.rejects(como(bia, (m) => m.approve(a.proposal.id, { id: ana, kind: "user", strongAuth: true }, a.proposal.payloadHash)), (e) => codigo(e) === "PROPOSAL_NOT_FOUND");
    // Nem revoga o grant dela.
    await assert.rejects(como(bia, (m) => m.grants.revoke(g.id, ana)), (e) => codigo(e) === "GRANT_NOT_FOUND");

    // SQL direto, sem passar pelo motor: UPDATE não acha a linha; INSERT com o dono errado é recusado.
    await como(bia, (_m, tx) => tx.query("update obedient.grants set revoked_at = now() where id = $1", [g.id]));
    assert.equal((await como(ana, (m) => m.grants.get(g.id)))?.revokedAt, null);
    await assert.rejects(como(bia, (m) => m.grants.grant(spec(ana), ana)), /row-level security/);
    await assert.rejects(
      como(bia, (_m, tx) => tx.query("insert into obedient.consents (id, user_id, purpose, category, given_at, specific) values ('x', $1, 'p', 'c', now(), true)", [ana])),
      /row-level security/,
    );
    // Ana continua vendo tudo o que é dela.
    assert.equal((await como(ana, (m) => m.approvals.pending(ana))).length, 1);
  });

  it("sem usuário na transação, nenhuma linha aparece", async () => {
    const ana = usuario("ana");
    await como(ana, (m) => m.grants.grant(spec(ana), ana));
    const vistos = await banco.db.transaction(async (tx) => {
      await tx.query("set local role obedient_app");
      return (await tx.query("select count(*)::int as n from obedient.grants")).rows[0] as { n: number };
    });
    assert.equal(vistos.n, 0);
  });

  it("o papel do app não muda o que não é revogação: escopo, finalidade e limites ficam como o usuário deu", async () => {
    const ana = usuario("ana");
    const g = await como(ana, (m) => m.grants.grant(spec(ana), ana));
    await assert.rejects(como(ana, (_m, tx) => tx.query("update obedient.grants set capability = 'mail.send' where id = $1", [g.id])), /permission denied/);
    await assert.rejects(como(ana, (_m, tx) => tx.query("update obedient.grants set limits = '{}'::jsonb where id = $1", [g.id])), /permission denied/);
    await assert.rejects(como(ana, (_m, tx) => tx.query("delete from obedient.grants where id = $1", [g.id])), /permission denied/);
    await assert.rejects(como(ana, (_m, tx) => tx.query("update obedient.proposals set payload = '{}'::jsonb")), /permission denied/);
    await assert.rejects(como(ana, (_m, tx) => tx.query("select * from obedient.sessions")), /permission denied/);
  });

  it("id de usuário malformado ou '*' nunca abre transação de usuário", async () => {
    for (const u of ["", "*", "a b", "x".repeat(200), "'; drop table x; --"]) await assert.rejects(comoUsuario(banco.db, u, async () => 1), (e) => codigo(e) === "INVALID_PAYLOAD", u);
  });
});

describe("store-postgres: auditoria só de inclusão (Art. 8º)", () => {
  it("ninguém edita nem apaga a trilha, nem o dono das tabelas", async () => {
    const ana = usuario("ana");
    await como(ana, (m) => m.authorize(pedido(ana, "mail.list", "LOW", "READ")));
    await assert.rejects(como(ana, (_m, tx) => tx.query("update obedient.audit_log set entry = '{}'::jsonb where user_id = $1", [ana])), /permission denied/);
    await assert.rejects(como(ana, (_m, tx) => tx.query("delete from obedient.audit_log where user_id = $1", [ana])), /permission denied/);
    // Conexão do dono (a que rodou a migration), sem papel de app: o gatilho recusa.
    await assert.rejects(banco.db.query("update obedient.audit_log set entry = '{}'::jsonb where user_id = $1", [ana]), /só de inclusão/);
    await assert.rejects(banco.db.query("delete from obedient.audit_log where user_id = $1", [ana]), /só de inclusão/);
    await assert.rejects(banco.db.query("truncate obedient.audit_log"), /só de inclusão/);
    assert.equal(await como(ana, (m) => m.audit.verify(ana)), true);
  });

  it("o banco recusa entrada que não continua a cadeia, mesmo vinda do app", async () => {
    const ana = usuario("ana");
    await como(ana, (m) => m.authorize(pedido(ana, "mail.list", "LOW", "READ")));
    const [e1] = await como(ana, (m) => m.audit.forUser(ana));
    const falsa = (seq: number, prevHash: string) => ({ ...e1, seq, prevHash, hash: "f".repeat(64) });
    const inserir = (e: Record<string, unknown>) =>
      como(ana, (_m, tx) => tx.query("insert into obedient.audit_log (user_id, seq, prev_hash, hash, entry) values ($1,$2,$3,$4,$5::jsonb)", [ana, e.seq, e.prevHash, e.hash, JSON.stringify(e)]));
    await assert.rejects(inserir(falsa(3, e1!.hash)), /cadeia de auditoria quebrada/); // pulou o 2
    await assert.rejects(inserir(falsa(2, "0".repeat(64))), /cadeia de auditoria quebrada/); // prev errado
    await assert.rejects(inserir({ ...falsa(2, e1!.hash), userId: "outra" }), /inconsistente/); // entrada diz outro dono
    await assert.rejects(inserir(falsa(1, "0".repeat(64))), /duplicate key|cadeia/); // reescrever o 1
    assert.equal(await como(ana, (m) => m.audit.verify(ana)), true);
  });
});

describe("store-postgres: sessão autenticada", () => {
  it("emite, resolve, eleva por 5 minutos e encerra; o banco guarda só o hash", async () => {
    const c = new ManualClock(T0);
    const s = new Sessoes(banco.db, c);
    const ana = usuario("ana");
    const { token } = await s.emitir(ana, { ttlMs: H });
    const r = await s.resolver(token);
    assert.equal(r?.userId, ana);
    assert.equal(r?.strongAuth, false);
    assert.equal(await s.elevar(token), true);
    assert.equal((await s.resolver(token))?.strongAuth, true);
    c.advance(STRONG_AUTH_WINDOW_MS + 1000);
    assert.equal((await s.resolver(token))?.strongAuth, false, "a reautenticação vence");

    const guardado = await banco.db.query<{ token_hash: string }>("select token_hash from obedient.sessions where user_id = $1", [ana]);
    assert.equal(guardado.rows.length, 1);
    assert.notEqual(guardado.rows[0]!.token_hash, token);

    assert.equal(await s.encerrar(token), true);
    assert.equal(await s.resolver(token), null);
  });

  it("sessão vencida, token inventado ou malformado não abre nada", async () => {
    const c = new ManualClock(T0);
    const s = new Sessoes(banco.db, c);
    const ana = usuario("ana");
    const { token } = await s.emitir(ana, { ttlMs: H });
    c.advance(H + 1);
    assert.equal(await s.resolver(token), null);
    assert.equal(await s.resolver("x".repeat(43)), null);
    assert.equal(await s.resolver(""), null);
    await assert.rejects(s.comSessao(token, async () => 1), (e) => codigo(e) === "UNAUTHENTICATED");
  });

  it("o usuário da transação vem da sessão, não do pedido", async () => {
    const s = new Sessoes(banco.db, new ManualClock(T0));
    const ana = usuario("ana");
    const bia = usuario("bia");
    await como(bia, (m) => m.grants.grant(spec(bia), bia));
    const { token } = await s.emitir(ana);
    // Com a sessão da Ana, o pedido diz que é da Bia: o grant da Bia não existe nesta transação.
    await assert.rejects(
      s.comSessao(token, (_sessao, tx) => motorNaTransacao(tx, { clock }).authorize(pedido(bia, "mail.list", "LOW", "READ"))),
      (e) => codigo(e) === "UNAUTHENTICATED",
    );
    assert.deepEqual(await como(bia, (m) => m.audit.forUser(bia)), []);
    // Com o próprio nome, a Ana passa pela regra de sempre (sem grant, negado e registrado).
    const r = await s.comSessao(token, (sessao, tx) => motorNaTransacao(tx, { clock }).authorize(pedido(sessao.userId, "mail.list", "LOW", "READ")));
    assert.equal(r.outcome, "denied");
    assert.equal((await como(ana, (m) => m.audit.forUser(ana))).length, 1);
  });

  it("o papel do app não emite sessão nem lê sessão de ninguém", async () => {
    const ana = usuario("ana");
    await assert.rejects(como(ana, (_m, tx) => tx.query("select obedient.session_issue('h', $1, now(), now() + interval '1 hour', true)", [ana])), /permission denied/);
    await assert.rejects(como(ana, (_m, tx) => tx.query("select * from obedient.session_resolve('h', now())")), /permission denied/);
  });
});
