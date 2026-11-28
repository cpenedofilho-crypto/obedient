// SPDX-License-Identifier: AGPL-3.0-only
// Sessão de ponta a ponta com sinal sintético, Consent Manager real do Ethics Engine e player falso.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ConsentManager, InMemoryConsentStore } from "@obedient/ethics-engine";
import { ManualClock } from "@obedient/core";
import { CATALOGO } from "./__teste__/catalogo.ts";
import { PREFERENCIAS_PADRAO } from "./preferencias/engine.ts";
import { AdaptadorCatalogoProprio, PlayerFalso } from "./reproducao/catalogo-proprio.ts";
import { MotorDePrivacidade } from "./privacidade/engine.ts";
import { TrilhaLocal } from "./privacidade/retencao.ts";
import { SensorSimulado, gerarSinal } from "./sensor/simulado.ts";
import { INTERVALO_MINIMO_TROCA_MS } from "./decisao/decidir.ts";
import { SessaoMusical } from "./sessao.ts";
import { chaveDeSaude, ErroEventoMusica, eventoResumoSessao } from "./eventos.ts";

const TREINO = gerarSinal({
  semente: 11,
  trechos: [
    { duracaoS: 300, bpmInicial: 85, bpmFinal: 125 },
    { duracaoS: 600, bpmInicial: 155, bpmFinal: 170 },
    { duracaoS: 120, bpmInicial: 178, bpmFinal: 182 },
    { duracaoS: 300, bpmInicial: 140, bpmFinal: 100 },
  ],
  artefatos: 0.03,
});

function montar(opts: { consentir?: boolean; modo?: "ligada" | "so_sugestao" } = {}) {
  const clock = new ManualClock(new Date("2026-11-22T12:00:00.000Z"));
  const consent = new ConsentManager(clock, new InMemoryConsentStore());
  const privacidade = new MotorDePrivacidade(consent, "user-teste");
  const player = new PlayerFalso();
  const trilha = new TrilhaLocal(24 * 3600_000, clock);
  const sessao = new SessaoMusical({
    contexto: { fcRepouso: 60, fcMaxima: 190 },
    preferencias: { ...PREFERENCIAS_PADRAO, modo: opts.modo ?? "ligada" },
    catalogo: CATALOGO,
    player: new AdaptadorCatalogoProprio(CATALOGO, player, clock),
    privacidade,
    trilha,
    clock,
  });
  return { sessao, privacidade, player, trilha, consent };
}

describe("SessaoMusical", () => {
  it("without specific consent no sample is processed and the player is never touched", async () => {
    const { sessao, player, consent } = montar();
    await consent.give("user-teste", "adaptacao_musical", "health"); // não específico: não vale
    assert.equal(await sessao.iniciar(), false);
    await sessao.ouvir(new SensorSimulado("s1", TREINO));
    for (const a of TREINO.slice(0, 50)) assert.equal((await sessao.processar(a)).motivo, "sem_consentimento");
    assert.equal(player.pedidos.length, 0);
    assert.equal((await sessao.parar()).duracaoS, 0);
  });

  it("adapts a whole workout: several switches, always spaced by the minimum interval", async () => {
    const { sessao, privacidade, player } = montar();
    await privacidade.concederSinal();
    assert.equal(await sessao.iniciar(), true);
    await sessao.ouvir(new SensorSimulado("s1", TREINO));
    const trocas = player.pedidos.filter((p) => p.acao === "tocar");
    assert.ok(trocas.length >= 3, `trocas: ${trocas.length}`);
    for (let i = 1; i < trocas.length; i++) assert.ok(trocas[i]!.emMs! - trocas[i - 1]!.emMs! >= INTERVALO_MINIMO_TROCA_MS - 30_000);
    const resumo = await sessao.parar();
    assert.equal(resumo.trocasAutomaticas, trocas.length);
    assert.ok(resumo.duracaoS > 1200);
  });

  it("revoking consent mid-session stops reading the sensor immediately", async () => {
    const { sessao, privacidade, player } = montar();
    await privacidade.concederSinal();
    await sessao.iniciar();
    let lidas = 0;
    const sensor = {
      id: "s2",
      fonte: "simulado" as const,
      async *amostras(sinal: AbortSignal) {
        for (const a of TREINO) {
          if (sinal.aborted) return;
          lidas++;
          if (lidas === 400) await privacidade.revogarSinal();
          yield a;
        }
      },
    };
    await sessao.ouvir(sensor);
    assert.equal(lidas, 400);
    const antes = player.pedidos.length;
    assert.equal((await sessao.processar(TREINO[500]!)).motivo, "sem_consentimento");
    assert.equal(player.pedidos.length, antes);
  });

  it("manual controls win over the engine", async () => {
    const { sessao, privacidade, player } = montar();
    await privacidade.concederSinal();
    await sessao.iniciar();
    sessao.pausar();
    for (const a of TREINO.slice(0, 600)) await sessao.processar(a);
    assert.equal(player.pedidos.length, 0);
    sessao.retomar();
    sessao.travarFaixa("f03");
    for (const a of TREINO.slice(600, 900)) assert.equal((await sessao.processar(a)).motivo, "faixa_travada");
    assert.equal(player.pedidos.length, 0);
    sessao.travarFaixa(null);
    sessao.informarReproducao("f05", 900_000, true);
    assert.equal(sessao.resumo().pulosManuais, 1);
  });

  it("suggest-only mode shows suggestions and never plays by itself", async () => {
    const { sessao, privacidade, player } = montar({ modo: "so_sugestao" });
    await privacidade.concederSinal();
    await sessao.iniciar();
    await sessao.ouvir(new SensorSimulado("s1", TREINO));
    assert.ok(player.pedidos.some((p) => p.acao === "sugerir"));
    assert.ok(!player.pedidos.some((p) => p.acao === "tocar"));
  });

  it("the local trail explains decisions without heart rate and expires", async () => {
    const { sessao, privacidade, trilha } = montar();
    await privacidade.concederSinal();
    await sessao.iniciar();
    for (const a of TREINO.slice(0, 120)) await sessao.processar(a);
    const registros = trilha.exportar();
    assert.ok(registros.length > 0);
    assert.ok(!JSON.stringify(registros).match(/bpm|rr/i));
    trilha.apagarTudo();
    assert.equal(trilha.exportar().length, 0);
  });
});

describe("eventoResumoSessao", () => {
  const resumo = { duracaoS: 1500, trocasAutomaticas: 6, pulosManuais: 1, percentualAdaptado: 92.4, versaoMotor: "0.1.0" };

  it("needs the separate aggregates consent", () => {
    assert.throws(() => eventoResumoSessao(resumo, "sessao-ref-1", false), (e: unknown) => e instanceof ErroEventoMusica && e.codigo === "sem_consentimento_agregados");
  });

  it("carries only rounded counts, validated against the bus vocabulary", () => {
    const ev = eventoResumoSessao(resumo, "sessao-ref-1", true);
    assert.equal(ev.type, "music.session.ended");
    assert.deepEqual(ev.payload, { duracao_min: 25, trocas_automaticas: 6, pulos_manuais: 1, percentual_adaptado: 92, versao_motor: "0.1.0" });
    assert.equal(ev.idempotencyKey, "music.session.ended:sessao-ref-1");
  });

  it("the health-key net catches heart rate and listening data", () => {
    for (const k of ["bpm", "fc_media", "hr", "rr_ms", "zona", "faixa_id", "track", "heart_rate", "horario_inicio"]) assert.equal(chaveDeSaude({ [k]: 1 }), k);
    assert.equal(chaveDeSaude({ duracao_min: 1, trocas_automaticas: 2 }), null);
  });
});
