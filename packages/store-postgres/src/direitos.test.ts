// SPDX-License-Identifier: AGPL-3.0-only
//
// Memória e direitos do titular sobre o banco (Arts. 10 e 13): o que se aprende fica na RLS da
// pessoa; contestar só a própria trilha; "apagar o que você sabe" apaga e esvazia num passo, guarda
// o que precisa ser guardado, e não toca em nada de outra pessoa.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { ManualClock } from "@obedient/core";
import { bancoDeTeste, type BancoDeTeste } from "./banco-de-teste.ts";
import { apagarMeusDados, comoUsuario, contestacoes, contestar, memoriaNaTransacao, motorNaTransacao, type Executor } from "./index.ts";

const T0 = new Date("2026-11-03T12:00:00Z");
let banco: BancoDeTeste;
const clock = new ManualClock(T0);
before(async () => {
  banco = await bancoDeTeste();
});
after(() => banco.fechar());

let n = 0;
const usuario = (nome: string) => `${nome}-d${++n}`;
type Motor = ReturnType<typeof motorNaTransacao>;
const como = <T>(u: string, fn: (m: Motor, tx: Executor) => Promise<T>) => comoUsuario(banco.db, u, (tx) => fn(motorNaTransacao(tx, { clock }), tx));
const memoria = <T>(u: string, fn: (mem: ReturnType<typeof memoriaNaTransacao>, m: Motor, tx: Executor) => Promise<T>) =>
  como(u, (m, tx) => fn(memoriaNaTransacao(tx, m, clock), m, tx));
const codigo = (e: unknown) => (e as { code?: string }).code;

async function preparar(u: string) {
  await memoria(u, (mem) => mem.ligar(u, "trabalho"));
  await memoria(u, (mem) => mem.lembrar(u, "obedient", "trabalho", "o fornecedor de peixe é a Taberna Ipê"));
  const g = await como(u, (m) =>
    m.grants.grant({ userId: u, agentId: "obedient", systemId: "email", capability: "email.*", purpose: "responder e-mails da Casa Bertoldi", limits: { maxRisk: "HIGH", autonomousUpTo: "LOW", maxAmount: null, amountField: null }, expiresAt: new Date(T0.getTime() + 3600_000) }, u),
  );
  const a = await como(u, (m) => m.authorize({ userId: u, agentId: "obedient", systemId: "email", tool: "email.enviar", risk: "HIGH", category: "WRITE", args: { para: "marta@exemplo.org", texto: "segredo da Ana" } }));
  assert.equal(a.outcome, "approval_required");
  return { g, proposta: a.outcome === "approval_required" ? a.proposal : null! };
}

describe("memória no banco (Art. 10)", () => {
  it("guarda só com a categoria ligada; desligar apaga; a RLS separa as pessoas", async () => {
    const ana = usuario("ana");
    const bia = usuario("bia");
    await assert.rejects(memoria(ana, (mem) => mem.lembrar(ana, "obedient", "agenda", "academia às 7h")), (e) => codigo(e) === "CONSENT_REQUIRED");
    await memoria(ana, (mem) => mem.ligar(ana, "agenda"));
    const l = await memoria(ana, (mem) => mem.lembrar(ana, "obedient", "agenda", "academia às 7h"));
    assert.deepEqual(await memoria(bia, (mem) => mem.listar(ana)), []);
    assert.equal(await memoria(bia, (mem) => mem.esquecer(ana, l.id)), false);
    await assert.rejects(memoria(bia, (_mem, _m, tx) => tx.query("insert into obedient.memories values ('x', $1, 'agenda', 'plantada', 'obedient', now())", [ana])), /row-level security/);
    assert.equal((await memoria(ana, (mem) => mem.listar(ana))).length, 1);
    assert.equal(await memoria(ana, (mem) => mem.desligar(ana, "agenda")), 1);
    assert.deepEqual(await memoria(ana, (mem) => mem.listar(ana)), []);
  });

  it("o papel do app não muda o texto de uma lição (só inclui e apaga)", async () => {
    const ana = usuario("ana");
    await memoria(ana, (mem) => mem.ligar(ana, "preferencias"));
    await memoria(ana, (mem) => mem.lembrar(ana, "obedient", "preferencias", "resumo curto"));
    await assert.rejects(como(ana, (_m, tx) => tx.query("update obedient.memories set texto = 'outra coisa'")), /permission denied/);
  });
});

describe("contestar (Art. 13)", () => {
  it("contesta a própria entrada; a do outro não existe; o motivo não vai para a trilha", async () => {
    const ana = usuario("ana");
    const bia = usuario("bia");
    await preparar(ana);
    await preparar(bia);
    const trilha = await como(ana, (m) => m.audit.forUser(ana));
    const alvo = trilha.find((e) => e.outcome === "approval_required")!;
    const c = await como(ana, (m, tx) => contestar(tx, m.audit, ana, alvo.seq, "eu não pedi para escrever para a Marta", clock));
    assert.equal(c.status, "aberta");
    assert.deepEqual((await como(ana, (_m, tx) => contestacoes(tx, ana))).map((x) => x.auditSeq), [alvo.seq]);
    // Bia não contesta a trilha da Ana, nem vê as contestações dela.
    await assert.rejects(como(bia, (m, tx) => contestar(tx, m.audit, ana, alvo.seq, "x", clock)));
    assert.deepEqual(await como(bia, (_m, tx) => contestacoes(tx, ana)), []);
    // Entrada que não existe.
    await assert.rejects(como(ana, (m, tx) => contestar(tx, m.audit, ana, 9999, "x", clock)), (e) => codigo(e) === "PROPOSAL_NOT_FOUND");
    const ultima = (await como(ana, (m) => m.audit.forUser(ana))).at(-1)!;
    assert.equal(ultima.event, "action.contested");
    assert.doesNotMatch(JSON.stringify(ultima), /Marta/);
    assert.equal(await como(ana, (m) => m.audit.verify(ana)), true);
  });

  it("o app não responde nem edita a própria contestação", async () => {
    const ana = usuario("ana");
    await preparar(ana);
    const seq = (await como(ana, (m) => m.audit.forUser(ana)))[0]!.seq;
    await como(ana, (m, tx) => contestar(tx, m.audit, ana, seq, "isto está errado", clock));
    await assert.rejects(como(ana, (_m, tx) => tx.query("update obedient.contestations set status = 'respondida', resposta = 'tudo certo'")), /permission denied/);
  });
});

describe("apagar o que o OBEDIENT sabe (Art. 13)", () => {
  it("num passo: apaga a memória, esvazia pedidos e finalidades, encerra o que estava aberto", async () => {
    const ana = usuario("ana");
    const { g, proposta } = await preparar(ana);
    const r = await como(ana, (m, tx) => apagarMeusDados(tx, m.audit, ana, clock));
    assert.deepEqual(r, { memorias: 1, pedidos: 1, autorizacoes: 1, consentimentos_revogados: 1, acoes_do_aparelho: 0, missoes: 0 });

    assert.deepEqual(await memoria(ana, (mem) => mem.listar(ana)), []);
    const p = await como(ana, (m) => m.approvals.get(proposta.id));
    assert.deepEqual(p?.payload, {});
    assert.equal(p?.summary, "(apagado a pedido da pessoa)");
    assert.equal(p?.status, "rejected");
    const gg = await como(ana, (m) => m.grants.get(g.id));
    assert.equal(gg?.purpose, "(apagado a pedido da pessoa)");
    assert.ok(gg?.revokedAt);
    // O agente perdeu tudo: sem grant, nada passa; sem consentimento, nada se aprende.
    assert.equal((await como(ana, (m) => m.authorize({ userId: ana, agentId: "obedient", systemId: "email", tool: "email.ler", risk: "LOW", category: "READ", args: {} }))).outcome, "denied");
    await assert.rejects(memoria(ana, (mem) => mem.lembrar(ana, "obedient", "trabalho", "de novo")), (e) => codigo(e) === "CONSENT_REQUIRED");
  });

  it("guarda a trilha (sem o conteúdo apagado) e o registro dos consentimentos", async () => {
    const ana = usuario("ana");
    await preparar(ana);
    await como(ana, (m, tx) => apagarMeusDados(tx, m.audit, ana, clock));
    const trilha = await como(ana, (m) => m.audit.forUser(ana));
    assert.equal(trilha.at(-1)!.event, "user.data_erased");
    assert.equal(await como(ana, (m) => m.audit.verify(ana)), true);
    const tudo = JSON.stringify(trilha) + JSON.stringify(await como(ana, (_m, tx) => tx.query("select * from obedient.proposals where user_id = $1", [ana])));
    assert.doesNotMatch(tudo, /segredo da Ana|Taberna Ipê|marta@exemplo/);
    const consent = await como(ana, (m) => m.consent.export(ana));
    assert.equal(consent.length, 1, "o registro do consentimento fica, revogado");
    assert.ok(consent[0]!.revokedAt);
  });

  it("não toca em nada de outra pessoa", async () => {
    const ana = usuario("ana");
    const bia = usuario("bia");
    await preparar(ana);
    const daBia = await preparar(bia);
    await como(ana, (m, tx) => apagarMeusDados(tx, m.audit, ana, clock));
    assert.equal((await memoria(bia, (mem) => mem.listar(bia))).length, 1);
    assert.equal((await como(bia, (m) => m.approvals.get(daBia.proposta.id)))?.status, "pending");
    assert.equal((await como(bia, (m) => m.grants.get(daBia.g.id)))?.revokedAt, null);
  });

  it("o papel que apaga também está preso à RLS: com o usuário da Ana, não alcança a linha da Bia", async () => {
    const ana = usuario("ana");
    const bia = usuario("bia");
    await preparar(bia);
    const tocadas = await banco.db.transaction(async (tx) => {
      await tx.query("set local role obedient_eraser");
      await tx.query("select set_config('obedient.user_id', $1, true)", [ana]);
      const m = await tx.query("delete from obedient.memories where user_id = $1 returning id", [bia]);
      const p = await tx.query("update obedient.proposals set payload = '{}'::jsonb where user_id = $1 returning id", [bia]);
      return m.rows.length + p.rows.length;
    });
    assert.equal(tocadas, 0);
    assert.equal((await memoria(bia, (mem) => mem.listar(bia))).length, 1);
  });

  it("sem usuário na transação a função recusa; o app não chama como outro papel", async () => {
    await assert.rejects(
      banco.db.transaction(async (tx) => {
        await tx.query("set local role obedient_app");
        await tx.query("select obedient.apagar_meus_dados(now())");
      }),
      /sem usuário/,
    );
    await assert.rejects(
      banco.db.transaction(async (tx) => {
        await tx.query("set local role obedient_operator");
        await tx.query("select obedient.apagar_meus_dados(now())");
      }),
      /permission denied/,
    );
  });
});
