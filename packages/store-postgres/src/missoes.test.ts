// SPDX-License-Identifier: AGPL-3.0-only
//
// Missões e identificação sobre o banco (Arts. 5º e 7º): RLS por pessoa, limites no próprio banco,
// reserva da tentativa em transação curta (a execução fica fora do banco), identificação exigida.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { ManualClock } from "@obedient/core";
import { PRAZO_RESERVA_MS } from "@obedient/missions";
import { bancoDeTeste, dePglite, type BancoDeTeste } from "./banco-de-teste.ts";
import { migrate, migrations } from "./migrate.ts";
import type { Database } from "./db.ts";
import { PgMissionStore, apagarMeusDados, comoOperador, comoUsuario, gravarIdentificacao, missoesNaTransacao, motorNaTransacao, pessoasComMissaoDevida, type Executor } from "./index.ts";

const T0 = new Date("2026-11-03T12:00:00Z");
let banco: BancoDeTeste;
const clock = new ManualClock(T0);
before(async () => {
  banco = await bancoDeTeste();
});
after(() => banco.fechar());

let n = 0;
const usuario = (nome: string) => `${nome}-m${++n}`;
type Motor = ReturnType<typeof motorNaTransacao>;
const missoes = <T>(u: string, fn: (ms: ReturnType<typeof missoesNaTransacao>, m: Motor, tx: Executor) => Promise<T>, opts = {}) =>
  comoUsuario(banco.db, u, (tx) => {
    const m = motorNaTransacao(tx, { clock, ...opts });
    return fn(missoesNaTransacao(tx, m, clock), m, tx);
  });

describe("missões no banco (Art. 7º)", () => {
  it("reserva e conclusão em transações separadas; falha marca a próxima tentativa; teto vira impedimento", async () => {
    const ana = usuario("ana");
    const m = await missoes(ana, (ms) => ms.criar(ana, "obedient", "Confirmar a reserva de quinta", { maxTentativas: 2 }));
    const r1 = await missoes(ana, (ms) => ms.reservar(m.id));
    assert.equal(r1.reservada, true);
    // A execução acontece aqui, fora de qualquer transação.
    const depois1 = await missoes(ana, (ms) => ms.concluir(r1.missao, { tipo: "falha_temporaria", erro: "fora do ar", custoCentavos: 10 }));
    assert.equal(depois1.proximaTentativaEm?.getTime(), T0.getTime() + 30_000);
    assert.equal((await missoes(ana, (ms) => ms.reservar(m.id))).reservada, false, "antes do intervalo, não reserva");
    clock.advance(30_000);
    const r2 = await missoes(ana, (ms) => ms.reservar(m.id));
    const fim = await missoes(ana, (ms) => ms.concluir(r2.missao, { tipo: "falha_temporaria", erro: "fora do ar", custoCentavos: 10 }));
    assert.equal(fim.estado, "blocked");
    assert.match(fim.impedimento!, /Tentou 2 vez/);
    assert.equal((await missoes(ana, (ms) => ms.get(m.id)))?.custoCentavos, 20);
  });

  it("duas reservas ao mesmo tempo: só uma conta (troca atômica pela versão)", async () => {
    const ana = usuario("ana");
    const m = await missoes(ana, (ms) => ms.criar(ana, "obedient", "x"));
    const rs = await Promise.all(Array.from({ length: 4 }, () => missoes(ana, (ms) => ms.reservar(m.id))));
    assert.equal(rs.filter((r) => r.reservada).length, 1, JSON.stringify(rs.map((r) => r.reservada)));
    assert.equal((await missoes(ana, (ms) => ms.get(m.id)))?.tentativas, 1);
  });

  it("corrida forçada: duas transações leem a mesma versão; só a primeira grava", async (t) => {
    // O PGlite tem uma conexão só: duas transações abertas ao mesmo tempo não existem nele.
    if (banco.tipo === "pglite") return t.skip("corrida real só no Postgres (job postgres do CI)");
    const ana = usuario("ana");
    const m = await missoes(ana, (ms) => ms.criar(ana, "obedient", "x"));
    let lerB!: () => void;
    const bLeu = new Promise<void>((ok) => (lerB = ok));
    let soltarA!: () => void;
    const aPode = new Promise<void>((ok) => (soltarA = ok));
    const gravar = (atraso: Promise<void>, sinal?: () => void) =>
      comoUsuario(banco.db, ana, async (tx) => {
        const store = new PgMissionStore(tx);
        const lida = (await store.get(m.id))!;
        sinal?.();
        await atraso;
        const v = lida.versao;
        lida.tentativas += 1;
        lida.versao = v + 1;
        return store.update(lida, v);
      });
    // B lê e espera; A lê depois de B ter lido, e as duas gravam.
    const b = gravar(aPode, lerB);
    await bLeu;
    const a = gravar(Promise.resolve());
    const ra = await a;
    soltarA();
    const rb = await b;
    assert.deepEqual([ra, rb].sort(), [false, true]);
    assert.equal((await missoes(ana, (ms) => ms.get(m.id)))?.tentativas, 1);
  });

  it("o banco recusa limite fora do Art. 7º mesmo se o código errar", async () => {
    const ana = usuario("ana");
    const m = await missoes(ana, (ms) => ms.criar(ana, "obedient", "x"));
    for (const sql of [
      "update obedient.missions set tentativas = 9 where id = $1",
      "update obedient.missions set teto_custo_centavos = 999999 where id = $1",
      "update obedient.missions set estado = 'blocked', impedimento = null where id = $1",
      "update obedient.missions set estado = 'completed' where id = $1",
    ])
      await assert.rejects(missoes(ana, (_ms, _m, tx) => tx.query(sql, [m.id])), /check constraint/, sql);
    await assert.rejects(missoes(ana, (_ms, _m, tx) => tx.query("update obedient.missions set objetivo = 'outro' where id = $1", [m.id])), /permission denied/);
  });

  it("uma pessoa não vê nem mexe na missão de outra", async () => {
    const ana = usuario("ana");
    const bia = usuario("bia");
    const m = await missoes(ana, (ms) => ms.criar(ana, "obedient", "segredo da Ana"));
    assert.equal(await missoes(bia, (ms) => ms.get(m.id)), undefined);
    await assert.rejects(missoes(bia, (ms) => ms.cancelarPelaPessoa(bia, m.id)));
    await assert.rejects(missoes(bia, (ms) => ms.reservar(m.id)));
    assert.equal((await missoes(ana, (ms) => ms.get(m.id)))?.estado, "running");
  });

  it("parar cancela as missões no mesmo commit", async () => {
    const ana = usuario("ana");
    const m = await missoes(ana, (ms) => ms.criar(ana, "obedient", "x"));
    await missoes(ana, (_ms, motor) => motor.stop.engage({ kind: "user", userId: ana }, ana, "parar"));
    assert.equal((await missoes(ana, (ms) => ms.get(m.id)))?.estado, "cancelled");
  });

  it("apagar o que o OBEDIENT sabe esvazia objetivo e explicação e cancela as abertas", async () => {
    const ana = usuario("ana");
    const aberta = await missoes(ana, (ms) => ms.criar(ana, "obedient", "marcar consulta com a Dra. Marta"));
    const feita = await missoes(ana, (ms) => ms.criar(ana, "obedient", "achar o telefone do encanador"));
    await missoes(ana, (ms) => ms.avancar(feita.id, async () => ({ tipo: "feito", explicacao: "é 21 99999-0000", custoCentavos: 1 })));
    const r = await missoes(ana, (_ms, m, tx) => apagarMeusDados(tx, m.audit, ana, clock));
    assert.equal(r.missoes, 2);
    const a = await missoes(ana, (ms) => ms.get(aberta.id));
    const f = await missoes(ana, (ms) => ms.get(feita.id));
    assert.deepEqual([a?.estado, a?.objetivo], ["cancelled", "(apagado a pedido da pessoa)"]);
    assert.deepEqual([f?.estado, f?.desfecho?.explicacao], ["completed", "(apagado a pedido da pessoa)"]);
  });
});

describe("identificação das mensagens (Art. 5º)", () => {
  it("com o servidor exigindo, mensagem só sai com a identificação configurada", async () => {
    const ana = usuario("ana");
    const exige = { exigirIdentificacao: true };
    await missoes(ana, (_ms, m) =>
      m.grants.grant({ userId: ana, agentId: "obedient", systemId: "email", capability: "email.*", purpose: "responder e-mails", limits: { maxRisk: "HIGH", autonomousUpTo: "MEDIUM", maxAmount: null, amountField: null }, expiresAt: new Date(T0.getTime() + 8 * 3_600_000) }, ana),
    );
    const enviar = (args: Record<string, unknown>) =>
      missoes(ana, async (_ms, m) => (await m.authorize({ userId: ana, agentId: "obedient", systemId: "email", tool: "email.enviar", risk: "MEDIUM", category: "COMMUNICATION", args })).outcome, exige);
    assert.equal(await enviar({ para: "x@exemplo.org" }), "denied");
    await assert.rejects(missoes(ana, (_ms, _m, tx) => gravarIdentificacao(tx, ana, "ab", clock)), /de 3 a 200/);
    const id = await missoes(ana, (_ms, _m, tx) => gravarIdentificacao(tx, ana, "  Enviada pelo   assistente da Ana ", clock));
    assert.equal(id, "Enviada pelo assistente da Ana");
    assert.equal(await enviar({ para: "x@exemplo.org" }), "denied");
    assert.equal(await enviar({ para: "x@exemplo.org", identificacao: id }), "allowed");
    // Sem a exigência ligada (motor fora do servidor), a regra fica de fora.
    assert.equal(await missoes(ana, async (_ms, m) => (await m.authorize({ userId: ana, agentId: "obedient", systemId: "email", tool: "email.enviar", risk: "MEDIUM", category: "COMMUNICATION", args: {} })).outcome), "allowed");
  });
});

describe("retomada persistida de missão (GH-600)", () => {
  it("nova instância lê rodada persistida e respeita o intervalo de nova tentativa", async () => {
    const ana = usuario("reinicio");
    const criada = await missoes(ana, (ms) =>
      ms.criar(ana, "obedient", "Retomar tarefa interrompida", { maxTentativas: 3 }),
    );
    const primeira = await missoes(ana, (ms) => ms.reservar(criada.id));
    assert.equal(primeira.reservada, true);
    const rodada = { messages: [{ role: "user", content: "Continuar a tarefa" }], passos: 2 };
    await missoes(ana, (ms) => ms.concluir(primeira.missao, {
      tipo: "falha_temporaria", erro: "processo interrompido",
      custoCentavos: 2, rodada,
    }));

    // Cada chamada cria outra instância de Missoes e outra transação: não depende da memória do processo.
    const recuperada = await missoes(ana, (ms) => ms.get(criada.id));
    assert.deepEqual(recuperada?.rodada, rodada);
    assert.equal(recuperada?.tentativas, 1);
    assert.equal((await missoes(ana, (ms) => ms.reservar(criada.id))).reservada, false);

    clock.advance(30_000);
    const segunda = await missoes(ana, (ms) => ms.reservar(criada.id));
    assert.equal(segunda.reservada, true);
    assert.deepEqual(segunda.missao.rodada, rodada);
    assert.equal(segunda.missao.tentativas, 2);
  });
});

describe("executor e agendador no banco (Fase 7)", () => {
  it("a conversa guardada vai e volta, e apagar o que o OBEDIENT sabe a esvazia", async () => {
    const ana = usuario("ana");
    const m = await missoes(ana, (ms) => ms.criar(ana, "obedient", "Ver a agenda de amanhã"));
    const r = await missoes(ana, (ms) => ms.reservar(m.id));
    const rodada = { messages: [{ role: "user", content: "Ver a agenda de amanhã — dentista às 10h" }], passos: 1 };
    await missoes(ana, (ms) => ms.concluir(r.missao, { tipo: "falha_temporaria", erro: "fora do ar", custoCentavos: 1, rodada }));
    assert.deepEqual((await missoes(ana, (ms) => ms.get(m.id)))?.rodada, rodada);
    await missoes(ana, (ms, mt, tx) => apagarMeusDados(tx, mt.audit, ana, clock));
    const depois = (await missoes(ana, (ms) => ms.get(m.id)))!;
    assert.deepEqual([depois.estado, depois.rodada], ["cancelled", null]);
  });

  it("o agendador vê só QUEM tem missão devida; o operador não lê missão; o app não chama o agendador", async () => {
    const ana = usuario("ana");
    const bia = usuario("bia");
    const caio = usuario("caio");
    await missoes(ana, (ms) => ms.criar(ana, "obedient", "Devida agora"));
    const b = await missoes(bia, (ms) => ms.criar(bia, "obedient", "Vai esperar"));
    const rb = await missoes(bia, (ms) => ms.reservar(b.id));
    await missoes(bia, (ms) => ms.concluir(rb.missao, { tipo: "falha_temporaria", erro: "x", custoCentavos: 0 }));
    // Caio: missão esperando um pedido que ninguém decidiu ainda.
    await missoes(caio, (_ms, mt) =>
      mt.grants.grant({ userId: caio, agentId: "obedient", systemId: "email", capability: "email.*", purpose: "teste", limits: { maxRisk: "HIGH", autonomousUpTo: "LOW", maxAmount: null, amountField: null }, expiresAt: new Date(clock.now().getTime() + 3_600_000) }, caio),
    );
    const pedido = await missoes(caio, async (_ms, mt) => {
      const a = await mt.authorize({ userId: caio, agentId: "obedient", systemId: "email", tool: "email.enviar", risk: "HIGH", category: "WRITE", args: {} });
      return a.outcome === "approval_required" ? a.proposal : null;
    });
    const c = await missoes(caio, (ms) => ms.criar(caio, "obedient", "Esperando a pessoa"));
    const rc = await missoes(caio, (ms) => ms.reservar(c.id));
    await missoes(caio, (ms) => ms.concluir(rc.missao, { tipo: "aguardando_aprovacao", propostaId: pedido!.id, custoCentavos: 0 }));

    const devidas = () => comoOperador(banco.db, (tx) => pessoasComMissaoDevida(tx, clock.now(), 1000));
    const agora = await devidas();
    assert.ok(agora.includes(ana));
    assert.ok(!agora.includes(bia), "a próxima tentativa da Bia ainda não chegou");
    assert.ok(!agora.includes(caio), "o pedido do Caio ainda espera a pessoa");
    await missoes(caio, (_ms, mt) => mt.approve(pedido!.id, { id: caio, kind: "user", strongAuth: false }, pedido!.payloadHash));
    assert.ok((await devidas()).includes(caio), "decidido o pedido, a missão anda");

    await assert.rejects(comoOperador(banco.db, (tx) => tx.query("select objetivo from obedient.missions")), /permission denied/);
    await assert.rejects(comoOperador(banco.db, (tx) => tx.query("select user_id from obedient.missions")), /permission denied/);
    await assert.rejects(comoUsuario(banco.db, ana, (tx) => pessoasComMissaoDevida(tx, clock.now())), /permission denied/);
  });
});

describe("durabilidade do executor no banco (processo que cai, reinício)", () => {
  const nos = <T>(db: Database, u: string, c: ManualClock, fn: (ms: ReturnType<typeof missoesNaTransacao>, m: Motor) => Promise<T>) =>
    comoUsuario(db, u, (tx) => {
      const m = motorNaTransacao(tx, { clock: c });
      return fn(missoesNaTransacao(tx, m, c), m);
    });

  it("a rodada sobrevive ao reinício do banco e do executor: a conversa e o passo voltam exatamente", async () => {
    const dir = mkdtempSync(join(tmpdir(), "obedient-restart-"));
    const c = new ManualClock(T0);
    const u = usuario("ana");
    const rodada = { estado: { messages: [{ role: "user", content: "Ver a agenda de amanhã" }, { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "x", input: { de: "2026-11-04" } }] }], passos: 3, repeticoes: { "x:{}": 1 } }, pendente: null };
    let id: string;
    {
      const lite = new PGlite(dir);
      const db = dePglite(lite);
      await migrate(db);
      const m = await nos(db, u, c, (ms) => ms.criar(u, "obedient", "Ver a agenda de amanhã", { maxTentativas: 3 }));
      id = m.id;
      const r = await nos(db, u, c, (ms) => ms.reservar(m.id));
      await nos(db, u, c, (ms) => ms.concluir(r.missao, { tipo: "falha_temporaria", erro: "fora do ar", custoCentavos: 2, rodada }));
      // E a tentativa seguinte "morre" no meio: reservada, nunca concluída.
      c.advance(30_000);
      assert.equal((await nos(db, u, c, (ms) => ms.reservar(m.id))).reservada, true);
      await lite.close();
    }
    {
      // Processo novo: outro PGlite no mesmo diretório, outro store, outro Missoes. Nada em memória.
      const lite = new PGlite(dir);
      const db = dePglite(lite);
      try {
        assert.deepEqual(await migrate(db), [], "nada a aplicar: é o mesmo banco");
        const devidas = () => comoOperador(db, (tx) => pessoasComMissaoDevida(tx, c.now(), 1000));
        assert.ok(!(await devidas()).includes(u), "dentro do prazo da reserva, ninguém pega");
        c.advance(PRAZO_RESERVA_MS);
        assert.ok((await devidas()).includes(u), "vencido o prazo, o agendador acha a missão (no SQL também)");
        const r = await nos(db, u, c, (ms) => ms.reservar(id));
        assert.equal(r.reservada, true);
        assert.deepEqual([r.missao.tentativas, r.missao.rodada, r.missao.custoCentavos], [3, rodada, 2], "a conversa e o passo voltam exatamente");
        const trilha = await nos(db, u, c, (_ms, m) => m.audit.forUser(u));
        assert.ok(trilha.some((e) => e.event === "mission.attempt_interrupted"));
      } finally {
        await lite.close();
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("dois executores leem a mesma reserva: só o commit da versão certa vale; o outro é descartado sem efeito", async () => {
    const ana = usuario("ana");
    const m = await missoes(ana, (ms) => ms.criar(ana, "obedient", "x", { maxTentativas: 3 }));
    const ra = await missoes(ana, (ms) => ms.reservar(m.id));
    clock.advance(PRAZO_RESERVA_MS);
    // O executor A demorou além do prazo; o B reservou de novo.
    const rb = await missoes(ana, (ms) => ms.reservar(m.id));
    assert.equal(rb.reservada, true);
    const fa = await missoes(ana, (ms) => ms.concluir(ra.missao, { tipo: "feito", explicacao: "do A", custoCentavos: 7 }));
    assert.deepEqual([fa.estado, fa.desfecho, fa.custoCentavos], ["running", null, 0], "A recebe conflito: nem desfecho nem custo entram");
    const fb = await missoes(ana, (ms) => ms.concluir(rb.missao, { tipo: "feito", explicacao: "do B", custoCentavos: 1 }));
    assert.deepEqual([fb.estado, fb.desfecho?.explicacao, fb.custoCentavos], ["completed", "do B", 1]);
    // No nível do store: duas cópias da mesma versão, uma grava.
    const n = await missoes(ana, (ms) => ms.criar(ana, "obedient", "y"));
    const [x, y] = await missoes(ana, async (_ms, _m, tx) => [(await new PgMissionStore(tx).get(n.id))!, (await new PgMissionStore(tx).get(n.id))!]);
    for (const k of [x, y]) {
      k.tentativas = 1;
      k.versao += 1;
    }
    assert.equal(await missoes(ana, (_ms, _m, tx) => new PgMissionStore(tx).update(x!, n.versao)), true);
    assert.equal(await missoes(ana, (_ms, _m, tx) => new PgMissionStore(tx).update(y!, n.versao)), false);
  });

  it("o banco recusa missão andando sem hora da próxima tentativa (a órfã de antes)", async () => {
    const ana = usuario("ana");
    const m = await missoes(ana, (ms) => ms.criar(ana, "obedient", "x"));
    await assert.rejects(missoes(ana, (_ms, _m, tx) => tx.query("update obedient.missions set proxima_tentativa_em = null where id = $1", [m.id])), /check constraint/);
  });

  it("a migration resgata as missões que já estavam órfãs (antes do prazo de reserva)", async () => {
    const lite = new PGlite();
    const db = dePglite(lite);
    try {
      const todas = migrations();
      const ate = todas.findIndex((x) => x.name.startsWith("0007_"));
      assert.ok(ate > 0, "existe a 0007");
      await db.exec(`create schema if not exists obedient;
        create table if not exists obedient.schema_migrations (name text primary key, hash text not null, applied_at timestamptz not null default now())`);
      for (const x of todas.slice(0, ate)) {
        await db.exec(x.sql);
        await db.query("insert into obedient.schema_migrations (name, hash) values ($1, $2)", [x.name, x.hash]);
      }
      // Como o código antigo deixava: reservada (tentativas contadas, sem próxima tentativa) e o processo caiu.
      await db.query(
        `insert into obedient.missions (id, user_id, agente, objetivo, estado, tentativas, max_tentativas, proxima_tentativa_em, custo_centavos, teto_custo_centavos, criada_em, atualizada_em, versao)
         values ('orfa', 'ana-legado', 'obedient', 'x', 'running', 1, 3, null, 0, 500, $1, $1, 2)`,
        [T0],
      );
      assert.deepEqual(await migrate(db), todas.slice(ate).map((x) => x.name));
      const { rows } = await db.query<{ proxima_tentativa_em: Date; reservada_ate: Date }>("select proxima_tentativa_em, reservada_ate from obedient.missions where id = 'orfa'");
      assert.equal(new Date(rows[0]!.proxima_tentativa_em).getTime(), T0.getTime() + PRAZO_RESERVA_MS);
      assert.equal(new Date(rows[0]!.reservada_ate).getTime(), T0.getTime() + PRAZO_RESERVA_MS, "marcada como reserva vencida: a retomada registra a interrupção");
      const devidas = await comoOperador(db, (tx) => pessoasComMissaoDevida(tx, new Date(T0.getTime() + PRAZO_RESERVA_MS), 10));
      assert.deepEqual(devidas, ["ana-legado"]);
    } finally {
      await lite.close();
    }
  });
});
