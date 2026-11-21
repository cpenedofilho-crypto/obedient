// SPDX-License-Identifier: AGPL-3.0-only
//
// Critérios e verificador (D20, M3): lista fechada, conferência pelo registro de passos e pelo esquema,
// nada dado por verificado sem prova, e a missão que não confere para em vez de terminar.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ManualClock, payloadHash } from "@obedient/core";
import { AuditTrail, EthicsEngine, InMemoryAuditSink } from "@obedient/ethics-engine";
import { InMemoryMissionStore, Missoes, type PassoVerificavel, problemasDosCriterios, textoNaoVerificada, verificar } from "./index.ts";

const passo = (seq: number, tipo: string, status: string, ferramenta: string | null, tentativa = 1): PassoVerificavel => ({ tentativa, seq, tipo, status, ferramenta });
const PASSOS = [
  passo(1, "modelo", "ok", "google_agenda/google_agenda.criar_evento"),
  passo(2, "inicio", "chamando", "google_agenda/google_agenda.criar_evento"),
  passo(3, "ferramenta", "succeeded", "google_agenda/google_agenda.criar_evento"),
  passo(4, "inicio", "chamando", "google_agenda/google_agenda.listar_eventos"),
  passo(5, "ferramenta", "tool_error", "google_agenda/google_agenda.listar_eventos"),
  passo(1, "retomada", "succeeded", "gmail/gmail.enviar", 2),
];

describe("critérios de conclusão (D20, M3)", () => {
  it("lista fechada: tipo desconhecido, nome curto, esquema fora do subconjunto, campo a mais e lista longa são recusados", () => {
    assert.deepEqual(problemasDosCriterios(undefined), []);
    assert.deepEqual(problemasDosCriterios([{ tipo: "ferramenta_ok", ferramenta: "google_agenda/*" }, { tipo: "resultado_conforme", esquema: { type: "object", required: ["horario"], properties: { horario: { type: "string" } } } }]), []);
    for (const [c, re] of [
      [[{ tipo: "o_agente_disse_que_fez" }], /tipo precisa ser/],
      [[{ tipo: "ferramenta_ok", ferramenta: "a*" }], /3 a 200 caracteres/],
      [[{ tipo: "ferramenta_ok", ferramenta: "*" }], /3 a 200 caracteres/],
      [[{ tipo: "ferramenta_ok", ferramenta: "gmail/x", minimo: 0 }], /minimo/],
      [[{ tipo: "ferramenta_ok", ferramenta: "gmail/x", extra: 1 }], /campo não previsto/],
      [[{ tipo: "resultado_conforme", esquema: { type: "object", pattern: "x" } }], /fora do subconjunto/],
      [[{ tipo: "resultado_conforme", esquema: { type: "string" } }], /raiz do esquema/],
      [Array.from({ length: 11 }, () => ({ tipo: "ferramenta_ok", ferramenta: "gmail/x" })), /no máximo 10/],
      ["não é lista", /lista/],
    ] as const)
      assert.match(problemasDosCriterios(c).join(" | "), re, JSON.stringify(c).slice(0, 80));
  });

  it("sem critério: confere, mas diz que só o registro de passos foi conferido", () => {
    const v = verificar([], PASSOS, undefined);
    assert.equal(v.ok, true);
    assert.deepEqual(v.evidencias, [{ criterio: null, tipo: "sem_criterio", ok: true, referencia: "1:3, 2:1", detalhe: "Nenhum critério definido: conferido só o registro de passos (2 chamada(s) com sucesso)." }]);
  });

  it("ferramenta_ok conta só o FIM com sucesso (nunca o início nem o erro), com nome exato ou prefixo, e respeita o mínimo", () => {
    const ok = verificar([{ tipo: "ferramenta_ok", ferramenta: "google_agenda/google_agenda.criar_evento" }], PASSOS, undefined);
    assert.equal(ok.ok, true);
    assert.equal(ok.evidencias[0]!.referencia, "1:3");
    assert.equal(verificar([{ tipo: "ferramenta_ok", ferramenta: "google_agenda/google_agenda.listar_eventos" }], PASSOS, undefined).ok, false, "início e erro não contam");
    assert.equal(verificar([{ tipo: "ferramenta_ok", ferramenta: "google_agenda/*" }], PASSOS, undefined).evidencias[0]!.referencia, "1:3");
    assert.equal(verificar([{ tipo: "ferramenta_ok", ferramenta: "gmail/*" }], PASSOS, undefined).ok, true, "retomada aprovada conta");
    const minimo = verificar([{ tipo: "ferramenta_ok", ferramenta: "google_agenda/*", minimo: 2 }], PASSOS, undefined);
    assert.equal(minimo.ok, false);
    assert.match(minimo.evidencias[0]!.detalhe, /1 vez\(es\); o critério pede pelo menos 2/);
  });

  it("resultado_conforme confere o esquema e guarda só o hash do resultado", () => {
    const esquema = { type: "object", required: ["horario"], properties: { horario: { type: "string", maxLength: 5 } }, additionalProperties: false };
    const bom = { horario: "10:00" };
    const v = verificar([{ tipo: "resultado_conforme", esquema }], [], bom);
    assert.deepEqual([v.ok, v.evidencias[0]!.referencia], [true, `sha256:${payloadHash(bom)}`]);
    assert.ok(!JSON.stringify(v.evidencias).includes("10:00"), "o conteúdo do resultado não vai para a evidência");
    assert.equal(verificar([{ tipo: "resultado_conforme", esquema }], [], { horario: "amanhã de manhã" }).ok, false);
    assert.equal(verificar([{ tipo: "resultado_conforme", esquema }], [], { horario: "10:00", extra: 1 }).ok, false);
    const sem = verificar([{ tipo: "resultado_conforme", esquema }], [], undefined);
    assert.deepEqual([sem.ok, sem.evidencias[0]!.referencia], [false, null]);
    assert.match(sem.evidencias[0]!.detalhe, /não entregou resultado/);
  });

  it("todos precisam conferir: um que falha derruba a verificação, e o texto do impedimento cita só o que falhou", () => {
    const v = verificar([{ tipo: "ferramenta_ok", ferramenta: "google_agenda/*" }, { tipo: "ferramenta_ok", ferramenta: "drive/*" }], PASSOS, undefined);
    assert.deepEqual(v.evidencias.map((e) => e.ok), [true, false]);
    assert.equal(v.ok, false);
    assert.match(textoNaoVerificada(v.evidencias), /^O agente disse que terminou, mas a verificação não confere: drive\/\* rodou com sucesso 0 vez/);
  });
});

describe("missão terminando pela verificação (D20, M3)", () => {
  const setup = () => {
    const clock = new ManualClock(new Date("2026-11-19T12:00:00Z"));
    const sink = new InMemoryAuditSink();
    const store = new InMemoryMissionStore();
    return { missoes: new Missoes(store, new EthicsEngine({ clock, audit: new AuditTrail(sink, clock) }), clock), sink, store };
  };

  it("critérios inválidos não criam missão; os válidos ficam na missão", async () => {
    const { missoes } = setup();
    await assert.rejects(missoes.criar("ana", "obedient", "x", { criterios: [{ tipo: "x" } as never] }), /critérios inválidos/);
    const m = await missoes.criar("ana", "obedient", "x", { criterios: [{ tipo: "ferramenta_ok", ferramenta: "gmail/*" }] });
    assert.deepEqual(m.criterios, [{ tipo: "ferramenta_ok", ferramenta: "gmail/*" }]);
  });

  it("feito com evidência que não confere: verifying → blocked, com as evidências gravadas e sem desfecho", async () => {
    const { missoes } = setup();
    const m = await missoes.criar("ana", "obedient", "x", { criterios: [{ tipo: "ferramenta_ok", ferramenta: "gmail/*" }] });
    const evidencias = verificar(m.criterios, [], undefined).evidencias;
    const fim = await missoes.avancar(m.id, async () => ({ tipo: "feito", explicacao: "Mandei o e-mail.", evidencias, custoCentavos: 1 }));
    assert.deepEqual([fim.estado, fim.desfecho], ["blocked", null]);
    assert.equal(fim.impedimento, textoNaoVerificada(evidencias));
    assert.deepEqual((await missoes.evidencias(m.id)).map((e) => [e.tipo, e.ok, e.tentativa]), [["ferramenta_ok", false, 1]]);
  });

  it("feito sem evidências do executor: a missão confere o que pode, e com critério de ferramenta não dá por verificado", async () => {
    const { missoes } = setup();
    const com = await missoes.criar("ana", "obedient", "x", { criterios: [{ tipo: "ferramenta_ok", ferramenta: "gmail/*" }] });
    assert.equal((await missoes.avancar(com.id, async () => ({ tipo: "feito", explicacao: "ok", custoCentavos: 1 }))).estado, "blocked");
    const sem = await missoes.criar("ana", "obedient", "y");
    const fim = await missoes.avancar(sem.id, async () => ({ tipo: "feito", explicacao: "ok", custoCentavos: 1 }));
    assert.equal(fim.estado, "completed");
    assert.deepEqual((await missoes.evidencias(sem.id)).map((e) => e.tipo), ["sem_criterio"]);
  });

  it("não sei também passa por verifying e deixa evidência; não consegui vai direto a failed", async () => {
    const { missoes, sink } = setup();
    const a = await missoes.criar("ana", "obedient", "x", { criterios: [{ tipo: "ferramenta_ok", ferramenta: "gmail/*" }] });
    const fa = await missoes.avancar(a.id, async () => ({ tipo: "nao_sei", explicacao: "Não achei.", custoCentavos: 1 }));
    assert.deepEqual([fa.estado, fa.desfecho?.tipo], ["completed", "nao_sei"]);
    assert.deepEqual((await missoes.evidencias(a.id)).map((e) => e.tipo), ["nao_sei"]);
    const b = await missoes.criar("ana", "obedient", "y");
    const fb = await missoes.avancar(b.id, async () => ({ tipo: "nao_consegui", explicacao: "Deu erro.", custoCentavos: 1 }));
    assert.equal(fb.estado, "failed");
    assert.deepEqual(await missoes.evidencias(b.id), []);
    assert.ok(!(await sink.entries("ana")).some((e) => e.event === "mission.verifying" && e.correlationId === b.id));
  });
});
