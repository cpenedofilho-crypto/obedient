// SPDX-License-Identifier: AGPL-3.0-only
// Controlador do app de ponta a ponta no Node: sensor simulado, player falso, armazenamento em memória e
// um Growth OS falso. Consentimento, parâmetros, treino, fila de resumos e "apagar meus dados".
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ManualClock } from "@obedient/core";
import { gerarSinal, PlayerFalso, SensorSimulado } from "@obedient/music-engine";
import { ClienteGrowthOs } from "../api/cliente.ts";
import { KvMemoria, PREFIXO } from "../armazenamento/kv.ts";
import { CATALOGO_DEMO } from "../catalogo/demo.ts";
import { AJUSTES_PADRAO, ControladorDoTreino } from "./controlador.ts";

const TREINO = gerarSinal({
  semente: 5,
  trechos: [
    { duracaoS: 240, bpmInicial: 90, bpmFinal: 130 },
    { duracaoS: 480, bpmInicial: 155, bpmFinal: 170 },
    { duracaoS: 240, bpmInicial: 140, bpmFinal: 100 },
  ],
});

class PlayerComFim extends PlayerFalso {
  quandoAcabar(_f: (id: string) => void) {}
}

function montar(opts: { servidor?: (url: string, init: RequestInit) => Response; login?: boolean } = {}) {
  const kv = new KvMemoria();
  const clock = new ManualClock(new Date("2026-11-22T12:00:00.000Z"));
  const player = new PlayerComFim();
  const pedidos: { url: string; corpo: unknown; metodo: string }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    pedidos.push({ url, metodo: init.method ?? "GET", corpo: init.body ? JSON.parse(init.body as string) : null });
    return opts.servidor?.(url, init) ?? Response.json({ registrado: true }, { status: 201 });
  }) as unknown as typeof fetch;
  const api = new ClienteGrowthOs("https://growth.exemplo.test", { token: async () => (opts.login === false ? null : "tok"), organizacao: async () => null }, f);
  let n = 0;
  const arquivosApagados = { vezes: 0 };
  const c = new ControladorDoTreino({
    kv, clock, relogio: () => 0, player, catalogo: () => CATALOGO_DEMO.map((d) => d.faixa),
    intervalo: () => () => undefined, novoId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, api,
    apagarArquivos: async () => { arquivosApagados.vezes++; },
  });
  return { c, kv, player, pedidos, arquivosApagados };
}

const AJUSTES = { ...AJUSTES_PADRAO, fcRepouso: 60, fcMaxima: 190 };

describe("ControladorDoTreino", () => {
  it("does not start without the person's resting and max heart rate, nor without specific consent", async () => {
    const { c } = montar();
    await c.carregar();
    assert.equal(await c.iniciarTreino(new SensorSimulado("s", TREINO)), "sem_parametros");
    assert.deepEqual(await c.salvarAjustes(AJUSTES), []);
    assert.equal(await c.iniciarTreino(new SensorSimulado("s", TREINO)), "sem_consentimento");
  });

  it("rejects implausible heart-rate settings", async () => {
    const { c } = montar();
    await c.carregar();
    assert.deepEqual(await c.salvarAjustes({ ...AJUSTES, fcMaxima: 400 }), ["maxima_fora_da_faixa"]);
  });

  it("heart-rate settings stay on the device: the server only gets declared preferences", async () => {
    const { c, pedidos } = montar();
    await c.carregar();
    await c.salvarAjustes(AJUSTES);
    const pref = pedidos.find((p) => p.url.endsWith("/preferencias"))!;
    assert.equal(pref.metodo, "PUT");
    assert.ok(!JSON.stringify(pref.corpo).match(/fc|bpm|repouso|maxima/i), JSON.stringify(pref.corpo));
  });

  it("a whole workout adapts music; the summary is queued and sent only with aggregate consent", async () => {
    const { c, player, pedidos } = montar();
    await c.carregar();
    await c.salvarAjustes(AJUSTES);
    await c.consentirSinal(true);
    assert.equal(await c.iniciarTreino(new SensorSimulado("s", TREINO)), null);
    // espera o sensor simulado terminar
    for (let i = 0; i < 50 && c.visao().sessao?.contexto?.t !== TREINO.at(-1)!.t; i++) await new Promise((r) => setImmediate(r));
    assert.ok(c.visao().sessao?.contexto?.zona);
    const resumo = await c.pararTreino();
    assert.ok(resumo && resumo.trocasAutomaticas >= 2);
    assert.ok(player.pedidos.some((p) => p.acao === "tocar"));
    // sem consentimento de agregados, nada vai para /sessoes
    assert.equal(pedidos.filter((p) => p.url.endsWith("/sessoes")).length, 0);

    await c.consentirAgregados(true);
    await c.iniciarTreino(new SensorSimulado("s", TREINO.slice(0, 300)));
    for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
    await c.pararTreino();
    const envio = pedidos.filter((p) => p.url.endsWith("/sessoes"));
    assert.equal(envio.length, 1);
    assert.deepEqual(Object.keys(envio[0]!.corpo as object).sort(), ["duracaoMin", "percentualAdaptado", "pulosManuais", "sessaoRef", "trocasAutomaticas", "versaoMotor"]);
    assert.equal(c.visao().resumosPendentes, 0);
  });

  it("without network the summary waits in the queue and goes later", async () => {
    let online = false;
    const { c, pedidos } = montar({ servidor: () => { if (!online) throw new TypeError("sem rede"); return Response.json({ registrado: true }, { status: 201 }); } });
    await c.carregar();
    await c.salvarAjustes(AJUSTES);
    await c.consentirSinal(true);
    await c.consentirAgregados(true);
    await c.iniciarTreino(new SensorSimulado("s", TREINO.slice(0, 300)));
    for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
    await c.pararTreino();
    assert.equal(c.visao().resumosPendentes, 1);
    online = true;
    assert.equal(await c.enviarPendentes(), 1);
    assert.equal(c.visao().resumosPendentes, 0);
    assert.ok(pedidos.length > 0);
  });

  it("delete-my-data revokes, stops, wipes the device and asks the server", async () => {
    const { c, kv, pedidos, arquivosApagados } = montar();
    await c.carregar();
    await c.salvarAjustes(AJUSTES);
    await c.consentirSinal(true);
    const r = await c.apagarMeusDados();
    assert.deepEqual(r, { servidor: "apagado" });
    assert.equal(arquivosApagados.vezes, 1);
    assert.ok(pedidos.some((p) => p.metodo === "DELETE" && p.url.endsWith("/meus-dados")));
    assert.equal([...kv.dados.keys()].filter((k) => k.startsWith(PREFIXO)).length, 0);
    assert.equal(c.visao().sinalPermitido, false);
    assert.equal(c.visao().ajustes.fcRepouso, null);
  });

  it("works offline without login: no network call at all", async () => {
    const { c, pedidos } = montar({ login: false });
    await c.carregar();
    await c.salvarAjustes(AJUSTES);
    await c.consentirSinal(true);
    assert.equal(await c.iniciarTreino(new SensorSimulado("s", TREINO.slice(0, 200))), null);
    await c.pararTreino();
    assert.equal(pedidos.length, 0);
    assert.deepEqual(await c.apagarMeusDados(), { servidor: "sem_login" });
  });

  it("a suggestion is played only after a fresh licence check", async () => {
    const { c, player } = montar();
    await c.carregar();
    assert.equal(await c.aceitarSugestao("demo-05"), true);
    assert.equal(await c.aceitarSugestao("nao-existe"), false);
    assert.deepEqual(player.pedidos.map((p) => p.faixaId), ["demo-05"]);
  });

  it("export carries settings, consents and the local trail, all from the device", async () => {
    const { c } = montar();
    await c.carregar();
    await c.salvarAjustes(AJUSTES);
    await c.consentirSinal(true);
    const e = await c.exportarDoAparelho();
    assert.equal(e.ajustes.fcMaxima, 190);
    assert.ok(e.consentimentos.some((x) => x.purpose === "adaptacao_musical" && x.specific));
  });
});
