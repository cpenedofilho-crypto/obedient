// SPDX-License-Identifier: AGPL-3.0-only
// Contrato do barramento: o que vale para a implementação em memória vale para a Postgres
// (casa-de-ia/src/event-bus/barramento.harness.test.ts testa a mesma semântica lá).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BarramentoEmMemoria, criarVocabulario, ErroPermanente, RegistroDeConsumidores, VOCABULARIO_OBEDIENT, type ContextoPublicacao, type EventoBus } from "./index.ts";

const vocab = criarVocabulario({
  fontes: ["motor", "nucleo"],
  entidades: ["contact", "mission"],
  entidadesInternas: ["mission"],
  tipos: [
    { tipo: "lead.created", entidades: ["contact"], legado: ["lead_created"], descricao: "t" },
    { tipo: "lead.lost", entidades: ["contact"], descricao: "t" },
    { tipo: "mission.created", entidades: ["mission"], fontes: ["nucleo"], descricao: "t" },
  ],
});

function mundo() {
  let t = new Date("2026-11-02T12:00:00Z").getTime();
  let n = 0;
  const relogio = { now: () => new Date(t) };
  const bus = new BarramentoEmMemoria(vocab, relogio, () => `id-${++n}`);
  const avancar = (s: number) => {
    t += s * 1000;
  };
  return { bus, avancar };
}
const ctxA: ContextoPublicacao = { organizationId: "org-a", source: "motor", ator: { tipo: "connector" } };
const ctxB: ContextoPublicacao = { ...ctxA, organizationId: "org-b" };
const lead = (extra = {}) => ({ type: "lead.created", entityType: "contact", entityExternalId: "lead-1", ...extra });

describe("publicação", () => {
  it("normaliza o nome legado e o assinante de `lead.*` recebe (o defeito de 04/10)", async () => {
    const { bus } = mundo();
    bus.assinar({ organizationId: "org-a", consumer: "contador", padroes: ["lead.*"] });
    const [r] = bus.publicar(ctxA, [lead({ type: "lead_created" })]);
    assert.equal(bus.evento(r!.id)?.type, "lead.created");
    const vistos: string[] = [];
    await bus.despachar(new RegistroDeConsumidores().registrar("contador", (e) => void vistos.push(e.type)));
    assert.deepEqual(vistos, ["lead.created"]);
  });

  it("idempotente: mesma chave e conteúdo = duplicado; conteúdo diferente = conflito, e o lote não grava nada", () => {
    const { bus } = mundo();
    const [a] = bus.publicar(ctxA, [lead({ idempotencyKey: "k1", payload: { etapa: 1 } })]);
    const [b] = bus.publicar(ctxA, [lead({ idempotencyKey: "k1", payload: { etapa: 1 } })]);
    assert.equal(b!.duplicate, true);
    assert.equal(b!.id, a!.id);
    assert.throws(() => bus.publicar(ctxA, [lead({ idempotencyKey: "k2" }), lead({ idempotencyKey: "k1", payload: { etapa: 2 } })]), /outro conteúdo/);
    // Tudo-ou-nada: k2 não foi gravado junto com o conflito.
    const [c] = bus.publicar(ctxA, [lead({ idempotencyKey: "k2" })]);
    assert.equal(c!.duplicate, false);
  });

  it("conteúdo aninhado diferente com a mesma chave é conflito (ordem de chave não importa)", () => {
    const { bus } = mundo();
    bus.publicar(ctxA, [lead({ idempotencyKey: "k", payload: { a: { x: 1, y: 2 } } })]);
    assert.equal(bus.publicar(ctxA, [lead({ idempotencyKey: "k", payload: { a: { y: 2, x: 1 } } })])[0]!.duplicate, true);
    assert.throws(() => bus.publicar(ctxA, [lead({ idempotencyKey: "k", payload: { a: { x: 1, y: 3 } } })]), /outro conteúdo/);
  });

  it("a mesma chave em outro tenant é outro evento", () => {
    const { bus } = mundo();
    const [a] = bus.publicar(ctxA, [lead({ idempotencyKey: "k" })]);
    const [b] = bus.publicar(ctxB, [lead({ idempotencyKey: "k" })]);
    assert.notEqual(a!.id, b!.id);
  });

  it("recusa fonte fora do vocabulário, fonte sem direito ao tipo e dado pessoal", () => {
    const { bus } = mundo();
    assert.throws(() => bus.publicar({ ...ctxA, source: "invasor" }, [lead()]), /fonte "invasor"/);
    assert.throws(() => bus.publicar(ctxA, [{ type: "mission.created", entityType: "mission", entityId: "4d0f6b9e-9a0b-4f8e-9d1e-1a2b3c4d5e6f" }]), /não pode publicar/);
    assert.throws(() => bus.publicar(ctxA, [lead({ payload: { telefone: "x" } })]), /dado pessoal/);
  });

  it("assinatura com padrão que não casa nada, ou nome legado, é recusada", () => {
    const { bus } = mundo();
    assert.throws(() => bus.assinar({ organizationId: "org-a", consumer: "x", padroes: ["pedido.*"] }), /não casa/);
    // nome legado é normalizado na assinatura (lead_created → lead.created)
    assert.deepEqual(bus.assinar({ organizationId: "org-a", consumer: "x", padroes: ["lead_created"] }).padroes, ["lead.created"]);
  });
});

describe("isolamento entre tenants", () => {
  it("evento de um tenant nunca é entregue ao assinante de outro", async () => {
    const { bus } = mundo();
    bus.assinar({ organizationId: "org-b", consumer: "espiao", padroes: ["*"] });
    bus.publicar(ctxA, [lead()]);
    let chamadas = 0;
    await bus.despachar(new RegistroDeConsumidores().registrar("espiao", () => void chamadas++));
    assert.equal(chamadas, 0);
    assert.equal(bus.entregasDo("org-b").length, 0);
  });
});

describe("entrega", () => {
  it("falha → espera dobrada → dead_letter ao esgotar; reprocessar volta a pending", async () => {
    const { bus, avancar } = mundo();
    bus.assinar({ organizationId: "org-a", consumer: "instavel", padroes: ["lead.*"], maxAttempts: 3, backoffSeconds: 10 });
    bus.publicar(ctxA, [lead()]);
    const reg = new RegistroDeConsumidores().registrar("instavel", () => {
      throw new Error("fora do ar");
    });
    assert.deepEqual(await bus.despachar(reg), { processadas: 0, falhas: 1, mortas: 0 });
    assert.deepEqual(await bus.despachar(reg), { processadas: 0, falhas: 0, mortas: 0 }); // ainda esperando 10 s
    avancar(10);
    assert.equal((await bus.despachar(reg)).falhas, 1); // 2ª tentativa; próxima em 20 s
    avancar(19);
    assert.equal((await bus.despachar(reg)).falhas, 0);
    avancar(1);
    assert.equal((await bus.despachar(reg)).mortas, 1); // 3ª = última
    const [d] = bus.entregasDo("org-a");
    assert.equal(d!.status, "dead_letter");
    assert.equal(d!.lastError, "fora do ar");
    bus.reprocessar("org-a", d!.id);
    assert.equal(bus.entregasDo("org-a")[0]!.status, "pending");
    assert.throws(() => bus.reprocessar("org-b", d!.id), /não encontrada/);
  });

  it("ErroPermanente vai direto para dead_letter; consumidor desconhecido é falha que tenta de novo", async () => {
    const { bus } = mundo();
    bus.assinar({ organizationId: "org-a", consumer: "recusa", padroes: ["lead.*"] });
    bus.assinar({ organizationId: "org-a", consumer: "fantasma", padroes: ["lead.*"] });
    bus.publicar(ctxA, [lead()]);
    const r = await bus.despachar(
      new RegistroDeConsumidores().registrar("recusa", () => {
        throw new ErroPermanente("payload sem campo obrigatório");
      }),
    );
    assert.deepEqual(r, { processadas: 0, falhas: 1, mortas: 1 });
    const porConsumidor = Object.fromEntries(bus.entregasDo("org-a").map((d) => [d.consumer, d.status]));
    assert.deepEqual(porConsumidor, { recusa: "dead_letter", fantasma: "failed" });
  });

  it("evento derivado herda tenant e correlação, e causation_id aponta a causa", async () => {
    const { bus } = mundo();
    bus.assinar({ organizationId: "org-a", consumer: "reage", padroes: ["lead.created"] });
    bus.assinar({ organizationId: "org-a", consumer: "ouve", padroes: ["lead.lost"] });
    const [orig] = bus.publicar(ctxA, [lead({ correlationId: "cadeia-1" })]);
    let derivado: EventoBus | null = null;
    const reg = new RegistroDeConsumidores()
      .registrar("reage", async (_e, ctx) => {
        await ctx.publicar([{ type: "lead.lost", entityType: "contact", entityExternalId: "lead-1" }]);
      })
      .registrar("ouve", (e) => {
        derivado = e;
      });
    await bus.despachar(reg);
    await bus.despachar(reg);
    const d = derivado as EventoBus | null;
    assert.ok(d);
    assert.equal(d.organizationId, "org-a");
    assert.equal(d.correlationId, "cadeia-1");
    assert.equal(d.causationId, orig!.id);
  });

  it("maior prioridade primeiro", async () => {
    const { bus } = mundo();
    bus.assinar({ organizationId: "org-a", consumer: "fila", padroes: ["lead.*"] });
    bus.publicar(ctxA, [lead({ priority: 1, entityExternalId: "baixo" }), lead({ priority: 9, entityExternalId: "alto" })]);
    const ordem: string[] = [];
    await bus.despachar(new RegistroDeConsumidores().registrar("fila", (e) => void ordem.push(e.entityId)));
    assert.deepEqual(ordem, ["ext:alto", "ext:baixo"]);
  });
});

describe("vocabulário", () => {
  it("vocabulário inconsistente não nasce", () => {
    const base = { fontes: ["a"], entidades: ["x"], entidadesInternas: [] as string[] };
    const ruins = [
      { tipos: [{ tipo: "semponto", entidades: ["x"], descricao: "t" }] },
      { tipos: [{ tipo: "x.a", entidades: ["x"], descricao: "t" }, { tipo: "x.a", entidades: ["x"], descricao: "t" }] },
      { tipos: [{ tipo: "x.a", entidades: ["y"], descricao: "t" }] },
      { tipos: [{ tipo: "x.a", entidades: ["x"], fontes: ["z"], descricao: "t" }] },
      { tipos: [{ tipo: "x.a", entidades: ["x"], legado: ["x.b"], descricao: "t" }] },
      { tipos: [{ tipo: "x.a", entidades: ["x"], legado: ["xa"], descricao: "t" }, { tipo: "x.b", entidades: ["x"], legado: ["xa"], descricao: "t" }] },
      { tipos: [{ tipo: "x.a", entidades: [], descricao: "t" }] },
    ];
    for (const r of ruins) assert.throws(() => criarVocabulario({ ...base, ...r }), /vocabulário inválido/, JSON.stringify(r));
    assert.throws(() => criarVocabulario({ ...base, entidadesInternas: ["y"], tipos: [] }), /fora da lista/);
  });

  it("normaliza o legado e explica o padrão que não serve", () => {
    assert.equal(vocab.normalizarTipo("lead_created"), "lead.created");
    assert.equal(vocab.normalizarTipo("qualquer.coisa"), "qualquer.coisa");
    assert.equal(vocab.normalizarPadrao("lead.*"), "lead.*");
    assert.match(vocab.problemaDoPadrao("lead_created") ?? "", /nome antigo; use "lead.created"/);
    assert.equal(vocab.problemaDoPadrao("lead.*"), null);
    assert.equal(vocab.problemaDoPadrao("*"), null);
  });
});

describe("vocabulário do OBEDIENT", () => {
  const uuid = "4d0f6b9e-9a0b-4f8e-9d1e-1a2b3c4d5e6f";
  const nucleo: ContextoPublicacao = { organizationId: "user-1", source: "obedient", ator: { tipo: "system" } };

  it("só o núcleo anuncia parada de emergência e decisão sobre proposta (Arts. 9º e 12)", () => {
    const bus = new BarramentoEmMemoria(VOCABULARIO_OBEDIENT);
    assert.doesNotThrow(() => bus.publicar(nucleo, [{ type: "emergency_stop.engaged", entityType: "user", entityId: uuid }]));
    for (const source of ["dots", "integration", "user"]) {
      assert.throws(() => bus.publicar({ ...nucleo, source }, [{ type: "emergency_stop.released", entityType: "user", entityId: uuid }]), /não pode publicar/, source);
      assert.throws(() => bus.publicar({ ...nucleo, source }, [{ type: "proposal.approved", entityType: "proposal", entityId: uuid }]), /não pode publicar/, source);
    }
  });

  it("o DOTS só avisa que há algo esperando; o usuário não é referenciado por id externo", () => {
    const bus = new BarramentoEmMemoria(VOCABULARIO_OBEDIENT);
    assert.doesNotThrow(() => bus.publicar({ ...nucleo, source: "dots" }, [{ type: "dots.attention.needed", entityType: "integration", entityExternalId: "recupera" }]));
    assert.throws(() => bus.publicar(nucleo, [{ type: "emergency_stop.engaged", entityType: "user", entityExternalId: "x" }]), /só aceita entity_id/);
  });

  it("evento de proposta não leva o conteúdo com dado pessoal", () => {
    const bus = new BarramentoEmMemoria(VOCABULARIO_OBEDIENT);
    assert.throws(
      () => bus.publicar(nucleo, [{ type: "proposal.created", entityType: "proposal", entityId: uuid, payload: { args: { to: "ana@exemplo.com.br" } } }]),
      /dado pessoal/,
    );
  });
});
