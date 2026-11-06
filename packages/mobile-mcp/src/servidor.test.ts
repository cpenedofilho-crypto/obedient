// SPDX-License-Identifier: AGPL-3.0-only
//
// O servidor MCP do Mobile Control Engine como o MCP Gateway do Growth OS o vê:
//   • cada ferramenta cai na faixa de risco certa pelo MESMO classificador que o Gateway usa;
//   • propor não age; executar só pela ferramenta da faixa, com o resumo exato, uma vez;
//   • organizações não se enxergam; HTTP com token e Host conferidos;
//   • o adaptador HTTP fala com o serviço do aparelho no formato combinado e desconfia da resposta.

import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ManualClock } from "@obedient/core";
import { CAMPO_COMPROVANTE, assinarComprovante, classificar, classificarCategoria } from "@obedient/integration-gateway";
import { APP_DEMO, AdaptadorHttp, CelularFalso, lerCaptura, MotorMovel, RegistroDeDispositivos } from "@obedient/mobile-control";
import { criarServidorMcp, type OpcoesServidor } from "./servidor.ts";
import { motorDaInstancia, servirMcp } from "./servir.ts";

const T0 = new Date("2026-11-05T12:00:00Z");
const TOKEN = "m".repeat(40);

function montar() {
  const clock = new ManualClock(T0);
  const celular = new CelularFalso();
  const dispositivos = new RegistroDeDispositivos();
  for (const org of ["org-a", "org-b"])
    dispositivos.registrar({
      id: `emulador-${org}`, tenantId: org, rotulo: "Emulador", plataforma: "android", provedor: "android_local", ambiente: "isolado",
      appsPermitidos: [APP_DEMO], appsNegados: [], permiteMensagens: false, credencialRef: null, ativo: true,
    });
  let n = 0;
  const motor = new MotorMovel({ dispositivos, adaptador: celular, clock, novoId: () => `id-${String(++n).padStart(8, "0")}` });
  return { clock, celular, motor };
}

// O par de chaves do "Gateway" dos testes: a privada assina, o servidor só conhece a pública.
const der = (k: { export(o: object): Buffer | string }, type: string) => (k.export({ format: "der", type }) as Buffer).toString("base64");
const parGateway = generateKeyPairSync("ed25519");
const PRIVADA = der(parGateway.privateKey, "pkcs8");
const PUBLICA = der(parGateway.publicKey, "spki");
const OUTRA_PRIVADA = der(generateKeyPairSync("ed25519").privateKey, "pkcs8");

async function cliente(motor: MotorMovel, org = "org-a", opcoes: OpcoesServidor = { chaveAprovacao: PUBLICA }) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await criarServidorMcp(motor, org, opcoes).connect(a);
  const c = new Client({ name: "teste", version: "0" });
  await c.connect(b);
  const bruto = async (name: string, args: Record<string, unknown>, _meta?: Record<string, unknown>) => {
    const r = (await c.callTool({ name, arguments: args, ...(_meta ? { _meta } : {}) })) as { isError?: boolean; content: { type: string; text: string }[] };
    return { erro: Boolean(r.isError), dados: JSON.parse(r.content[0]!.text) };
  };
  // Papel do Gateway depois que uma pessoa aprovou: executar leva o comprovante assinado.
  const chamar = (name: string, args: Record<string, unknown> = {}) =>
    bruto(name, args, name.startsWith("mobile_executar_")
      ? { [CAMPO_COMPROVANTE]: assinarComprovante({ chavePrivada: PRIVADA, ferramenta: name, argumentos: args, approvalId: "aprov-0001" }) }
      : undefined);
  return { c, chamar, bruto };
}

type Tela = { observation_id: string; elementos: { id: string; texto: string }[] };
const id = (t: Tela, texto: string) => t.elementos.find((e) => e.texto.startsWith(texto))!.id;

describe("servidor MCP do Mobile Control Engine", () => {
  it("cada ferramenta cai na faixa certa pelo classificador do Gateway", async () => {
    const { motor } = montar();
    const { c } = await cliente(motor);
    const { tools } = await c.listTools();
    const faixa = Object.fromEntries(tools.map((t) => [t.name, [classificar({ name: t.name, annotations: t.annotations ?? {} }).nivel, classificarCategoria({ name: t.name, annotations: t.annotations ?? {} }).categoria]]));
    assert.deepEqual(faixa, {
      mobile_listar_aparelhos: ["LOW", "READ"],
      mobile_iniciar_sessao: ["HIGH", "WRITE"],
      mobile_ler_tela: ["LOW", "READ"],
      mobile_propor_acao: ["LOW", "READ"],
      mobile_executar_acao: ["HIGH", "WRITE"],
      mobile_executar_acao_alta: ["HIGH", "WRITE"],
      mobile_executar_acao_critica: ["CRITICAL", "DESTRUCTIVE"],
      mobile_encerrar_sessao: ["HIGH", "WRITE"],
    });
  });

  it("propor não age; executar só na faixa da proposta, com o resumo exato, uma vez", async () => {
    const { motor, celular } = montar();
    const { chamar } = await cliente(motor);
    const { dados: s } = await chamar("mobile_iniciar_sessao", { device_id: "emulador-org-a", minutos: 10 });
    let t = (await chamar("mobile_ler_tela", { session_id: s.session_id })).dados.conteudo_externo as Tela;
    const abrir = (await chamar("mobile_propor_acao", { session_id: s.session_id, observation_id: t.observation_id, operacao: "apps.launch", app: APP_DEMO, intencao: "abrir o demo" })).dados;
    assert.deepEqual([abrir.risco, abrir.executar_com, abrir.resumo], ["MEDIUM", "mobile_executar_acao", `Abrir o app ${APP_DEMO}`]);
    assert.equal(celular.comandos.length, 0, "propor não age");
    assert.equal((await chamar("mobile_executar_acao", { proposta_id: abrir.proposta_id, resumo: abrir.resumo })).erro, false);

    t = (await chamar("mobile_ler_tela", { session_id: s.session_id })).dados.conteudo_externo as Tela;
    const enviar = (await chamar("mobile_propor_acao", { session_id: s.session_id, observation_id: t.observation_id, operacao: "input.tap_element", alvo: id(t, "Enviar"), intencao: "enviar o cadastro" })).dados;
    assert.deepEqual([enviar.risco, enviar.categoria, enviar.executar_com], ["HIGH", "COMMUNICATION", "mobile_executar_acao_alta"]);
    assert.match(enviar.resumo, /^Tocar em "Enviar" \(dev\.obedient\.demo\)$/);

    // Pela ferramenta de outra faixa (que o Gateway governa com outro risco): recusado.
    const errada = await chamar("mobile_executar_acao", { proposta_id: enviar.proposta_id, resumo: enviar.resumo });
    assert.deepEqual([errada.erro, errada.dados.erro], [true, "faixa_errada"]);
    // Com outro resumo (a pessoa aprovaria um texto e outro seria feito): recusado.
    const outro = await chamar("mobile_executar_acao_alta", { proposta_id: enviar.proposta_id, resumo: "Tocar em \"Cancelar\"" });
    assert.deepEqual([outro.erro, outro.dados.erro], [true, "resumo_diferente"]);
    assert.equal(celular.enviados, 0);

    const ok = await chamar("mobile_executar_acao_alta", { proposta_id: enviar.proposta_id, resumo: enviar.resumo });
    assert.equal(ok.erro, false, JSON.stringify(ok));
    assert.equal(ok.dados.conteudo_externo.status, "executada");
    assert.equal(celular.enviados, 1);
    assert.equal((await chamar("mobile_executar_acao_alta", { proposta_id: enviar.proposta_id, resumo: enviar.resumo })).dados.erro, "proposta_usada");
    assert.equal(celular.enviados, 1);

    await chamar("mobile_encerrar_sessao", { session_id: s.session_id });
    assert.equal(motor.sessao(s.session_id)?.estado, "stopped");
  });

  it("a política do motor continua valendo: app negado nem vira proposta", async () => {
    const { motor } = montar();
    const { chamar } = await cliente(motor);
    const { dados: s } = await chamar("mobile_iniciar_sessao", { device_id: "emulador-org-a" });
    const t = (await chamar("mobile_ler_tela", { session_id: s.session_id })).dados.conteudo_externo as Tela;
    const r = await chamar("mobile_propor_acao", { session_id: s.session_id, observation_id: t.observation_id, operacao: "apps.launch", app: "com.android.settings", intencao: "abrir configurações" });
    assert.deepEqual([r.erro, r.dados.erro], [true, "negada"]);
  });

  it("a proposta vence, e a tela mudada não deixa a ação acontecer", async () => {
    const { motor, celular, clock } = montar();
    const { chamar } = await cliente(motor);
    const { dados: s } = await chamar("mobile_iniciar_sessao", { device_id: "emulador-org-a", minutos: 30 });
    let t = (await chamar("mobile_ler_tela", { session_id: s.session_id })).dados.conteudo_externo as Tela;
    const p1 = (await chamar("mobile_propor_acao", { session_id: s.session_id, observation_id: t.observation_id, operacao: "nav.home", intencao: "ir ao início" })).dados;
    clock.advance(11 * 60_000);
    assert.equal((await chamar("mobile_executar_acao", { proposta_id: p1.proposta_id, resumo: p1.resumo })).dados.erro, "proposta_vencida");

    t = (await chamar("mobile_ler_tela", { session_id: s.session_id })).dados.conteudo_externo as Tela;
    const p2 = (await chamar("mobile_propor_acao", { session_id: s.session_id, observation_id: t.observation_id, operacao: "nav.home", intencao: "ir ao início" })).dados;
    celular.mudarTela({ app: "outro.app", elementos: [] });
    const r = await chamar("mobile_executar_acao", { proposta_id: p2.proposta_id, resumo: p2.resumo });
    assert.equal(r.dados.conteudo_externo.status, "tela_mudou");
    assert.equal(celular.comandos.length, 0);
  });

  it("organizações não se enxergam", async () => {
    const { motor } = montar();
    const a = await cliente(motor, "org-a");
    const b = await cliente(motor, "org-b");
    const { dados: s } = await a.chamar("mobile_iniciar_sessao", { device_id: "emulador-org-a" });
    assert.deepEqual((await b.chamar("mobile_listar_aparelhos")).dados.aparelhos.map((x: { id: string }) => x.id), ["emulador-org-b"]);
    assert.equal((await b.chamar("mobile_ler_tela", { session_id: s.session_id })).erro, true);
    assert.equal((await b.chamar("mobile_iniciar_sessao", { device_id: "emulador-org-a" })).dados.erro, "aparelho_inexistente");
    assert.equal((await b.chamar("mobile_encerrar_sessao", { session_id: s.session_id })).dados.erro, "sessao_inexistente");
    // A proposta de uma organização não existe para a outra (nem a existência ela revela).
    const t = (await a.chamar("mobile_ler_tela", { session_id: s.session_id })).dados.conteudo_externo as Tela;
    const p = (await a.chamar("mobile_propor_acao", { session_id: s.session_id, observation_id: t.observation_id, operacao: "nav.home", intencao: "ir ao início" })).dados;
    assert.equal((await b.chamar("mobile_executar_acao", { proposta_id: p.proposta_id, resumo: p.resumo })).dados.erro, "proposta_inexistente");
  });
});

describe("defesa no destino: executar exige o comprovante do Gateway (R6)", () => {
  async function propostaCritica() {
    const { motor, celular } = montar();
    const cli = await cliente(motor);
    const { dados: s } = await cli.chamar("mobile_iniciar_sessao", { device_id: "emulador-org-a" });
    let t = (await cli.chamar("mobile_ler_tela", { session_id: s.session_id })).dados.conteudo_externo as Tela;
    const abrir = (await cli.chamar("mobile_propor_acao", { session_id: s.session_id, observation_id: t.observation_id, operacao: "apps.launch", app: APP_DEMO, intencao: "abrir o demo" })).dados;
    assert.equal((await cli.chamar("mobile_executar_acao", { proposta_id: abrir.proposta_id, resumo: abrir.resumo })).erro, false);
    t = (await cli.chamar("mobile_ler_tela", { session_id: s.session_id })).dados.conteudo_externo as Tela;
    const p = (await cli.chamar("mobile_propor_acao", { session_id: s.session_id, observation_id: t.observation_id, operacao: "input.tap_element", alvo: id(t, "Enviar"), intencao: "enviar o cadastro" })).dados;
    return { ...cli, celular, motor, p, args: { proposta_id: p.proposta_id, resumo: p.resumo } };
  }
  const comp = (ferramenta: string, argumentos: object, over: Partial<Parameters<typeof assinarComprovante>[0]> = {}) =>
    ({ [CAMPO_COMPROVANTE]: assinarComprovante({ chavePrivada: PRIVADA, ferramenta, argumentos, approvalId: "aprov-0001", ...over }) });

  it("só o Bearer não basta: sem comprovante, nada é executado", async () => {
    const { bruto, celular, args } = await propostaCritica();
    const r = await bruto("mobile_executar_acao_alta", args);
    assert.deepEqual([r.erro, r.dados.erro], [true, "sem_aprovacao"]);
    assert.match(r.dados.motivo, /ausente/);
    assert.equal(celular.enviados, 0);
  });

  it("recusa comprovante de outra ferramenta, de outros argumentos, vencido ou assinado por outra chave", async () => {
    const { bruto, celular, args } = await propostaCritica();
    const casos: [string, Record<string, unknown>][] = [
      ["ferramenta", comp("mobile_executar_acao_critica", args)],
      ["argumentos", comp("mobile_executar_acao_alta", { ...args, resumo: "Tocar em \"Cancelar\"" })],
      ["vencido", comp("mobile_executar_acao_alta", args, { agora: Date.now() - 10 * 60_000, validadeMs: 60_000 })],
      ["assinatura", comp("mobile_executar_acao_alta", args, { chavePrivada: OUTRA_PRIVADA })],
    ];
    for (const [motivo, meta] of casos) {
      const r = await bruto("mobile_executar_acao_alta", args, meta);
      assert.deepEqual([r.erro, r.dados.erro], [true, "sem_aprovacao"], motivo);
      assert.match(r.dados.motivo, new RegExp(motivo), motivo);
    }
    assert.equal(celular.enviados, 0);
    // Com o comprovante certo, executa; e só uma vez.
    assert.equal((await bruto("mobile_executar_acao_alta", args, comp("mobile_executar_acao_alta", args))).dados.conteudo_externo.status, "executada");
    assert.equal((await bruto("mobile_executar_acao_alta", args, comp("mobile_executar_acao_alta", args))).dados.erro, "proposta_usada");
    assert.equal(celular.enviados, 1);
  });

  it("sem a chave pública configurada, nenhuma faixa executa (falha fechada)", async () => {
    const { motor, celular } = montar();
    const { chamar } = await cliente(motor, "org-a", {});
    const { dados: s } = await chamar("mobile_iniciar_sessao", { device_id: "emulador-org-a" });
    const t = (await chamar("mobile_ler_tela", { session_id: s.session_id })).dados.conteudo_externo as Tela;
    const p = (await chamar("mobile_propor_acao", { session_id: s.session_id, observation_id: t.observation_id, operacao: "nav.home", intencao: "ir ao início" })).dados;
    const r = await chamar("mobile_executar_acao", { proposta_id: p.proposta_id, resumo: p.resumo });
    assert.deepEqual([r.erro, r.dados.erro], [true, "sem_aprovacao"]);
    assert.equal(celular.comandos.length, 0);
  });

  it("a faixa comum dispensa o comprovante só com comumSemAprovacao; alta e crítica nunca", async () => {
    const { motor, celular } = montar();
    const { bruto, chamar } = await cliente(motor, "org-a", { chaveAprovacao: PUBLICA, comumSemAprovacao: true });
    const { dados: s } = await chamar("mobile_iniciar_sessao", { device_id: "emulador-org-a" });
    let t = (await chamar("mobile_ler_tela", { session_id: s.session_id })).dados.conteudo_externo as Tela;
    const abrir = (await chamar("mobile_propor_acao", { session_id: s.session_id, observation_id: t.observation_id, operacao: "apps.launch", app: APP_DEMO, intencao: "abrir o demo" })).dados;
    // Comum, sem comprovante: passa (decisão escrita de rebaixar no Gateway).
    assert.equal((await bruto("mobile_executar_acao", { proposta_id: abrir.proposta_id, resumo: abrir.resumo })).erro, false);
    t = (await chamar("mobile_ler_tela", { session_id: s.session_id })).dados.conteudo_externo as Tela;
    const enviar = (await chamar("mobile_propor_acao", { session_id: s.session_id, observation_id: t.observation_id, operacao: "input.tap_element", alvo: id(t, "Enviar"), intencao: "enviar o cadastro" })).dados;
    assert.equal((await bruto("mobile_executar_acao_alta", { proposta_id: enviar.proposta_id, resumo: enviar.resumo })).dados.erro, "sem_aprovacao");
    assert.equal(celular.enviados, 0);
  });
});

describe("HTTP do servidor MCP", () => {
  it("token e Host conferidos; com eles, o Gateway lista as ferramentas", async () => {
    const { motor } = montar();
    const srv = await servirMcp({ tenantId: "org-a", token: TOKEN, hostsPermitidos: ["127.0.0.1"], motor, porta: 0 });
    const porta = (srv.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${porta}/mcp`;
    try {
      const inicio = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "0" } } });
      const cab = { "content-type": "application/json", accept: "application/json, text/event-stream" };
      assert.equal((await fetch(url, { method: "POST", headers: cab, body: inicio })).status, 401);
      assert.equal((await fetch(url, { method: "POST", headers: { ...cab, authorization: `Bearer ${"x".repeat(40)}` }, body: inicio })).status, 401);
      assert.equal((await fetch(`http://127.0.0.1:${porta}/outra`, { method: "POST", headers: { ...cab, authorization: `Bearer ${TOKEN}` }, body: inicio })).status, 404);
      // Host fora da lista (DNS rebinding): o transporte recusa.
      const http = await import("node:http");
      const status = await new Promise<number>((ok) => {
        const r = http.request({ host: "127.0.0.1", port: porta, path: "/mcp", method: "POST", headers: { ...cab, authorization: `Bearer ${TOKEN}`, host: "atacante.exemplo" } }, (res) => ok(res.statusCode ?? 0));
        r.end(inicio);
      });
      assert.equal(status, 403);

      const c = new Client({ name: "gateway", version: "0" });
      await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } }));
      assert.equal((await c.listTools()).tools.length, 8);
      await c.close();
    } finally {
      await new Promise((ok) => srv.close(ok));
    }
  });

  it("não sobe sem token longo nem sem hosts; a instância precisa da organização e do aparelho", () => {
    const { motor } = montar();
    assert.throws(() => servirMcp({ tenantId: "org-a", token: "curto", hostsPermitidos: ["x"], motor }), /32 caracteres/);
    assert.throws(() => servirMcp({ tenantId: "org-a", token: TOKEN, hostsPermitidos: [], motor }), /hosts permitidos/);
    assert.throws(() => motorDaInstancia({}), /MOBILE_MCP_TENANT/);
    assert.throws(() => motorDaInstancia({ MOBILE_MCP_TENANT: "org-a" }), /MOBILE_CONTROL_URL/);
  });
});

describe("adaptador HTTP do serviço do aparelho", () => {
  function servicoFalso(responder: (rota: string, corpo: Record<string, unknown>) => { status?: number; json: unknown }) {
    const pedidos: { url: string; auth: string | null; corpo: Record<string, unknown> }[] = [];
    const http = (async (url: string | URL | Request, init?: RequestInit) => {
      const corpo = JSON.parse(String(init?.body));
      pedidos.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), corpo });
      const r = responder(new URL(String(url)).pathname, corpo);
      return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    return { http, pedidos };
  }

  it("as quatro rotas no formato do serviço, com token", async () => {
    const { http, pedidos } = servicoFalso((rota) => (rota === "/v1/capturar" ? { json: { app: APP_DEMO, elementos: [{ texto: "Enviar", origem: "tree", caixa: { x: 40, y: 500, w: 1000, h: 64 }, clicavel: true, campo: false, senha: false }] } } : { json: { ok: true } }));
    const a = new AdaptadorHttp({ url: "http://127.0.0.1:8765/ignorado", token: TOKEN, fetch: http });
    await a.iniciar("emulador-1");
    const tela = await a.capturar("emulador-1");
    await a.executar("emulador-1", { tipo: "tocar", x: 540, y: 532 });
    await a.encerrar("emulador-1");
    assert.deepEqual(pedidos.map((p) => p.url), ["http://127.0.0.1:8765/v1/iniciar", "http://127.0.0.1:8765/v1/capturar", "http://127.0.0.1:8765/v1/executar", "http://127.0.0.1:8765/v1/encerrar"]);
    assert.ok(pedidos.every((p) => p.auth === `Bearer ${TOKEN}`));
    assert.deepEqual(pedidos[2]!.corpo, { dispositivo_id: "emulador-1", comando: { tipo: "tocar", x: 540, y: 532 } });
    assert.equal(tela.elementos[0]!.texto, "Enviar");
  });

  it("desconfia da resposta e não vaza o token no erro", async () => {
    assert.throws(() => lerCaptura({ app: 1, elementos: [] }), /app inválido/);
    assert.throws(() => lerCaptura({ app: null, elementos: [{ texto: "x" }] }), /elemento inválido/);
    assert.throws(() => lerCaptura({ app: null, elementos: new Array(301).fill(null) }), /elementos inválidos/);
    assert.equal(lerCaptura({ app: null, elementos: [{ texto: "segredo", senha: true, origem: "tree", caixa: { x: 0, y: 0, w: 1, h: 1 }, clicavel: true }] }).elementos[0]!.texto, "", "texto de senha nunca passa");
    const { http } = servicoFalso(() => ({ status: 403, json: { erro: "o app com.android.settings nunca pode ser aberto" } }));
    const a = new AdaptadorHttp({ url: "http://127.0.0.1:8765", token: TOKEN, fetch: http });
    await assert.rejects(a.executar("emulador-1", { tipo: "abrir_app", app: "com.android.settings" }), (e: Error) => /recusou \(403\): o app com\.android\.settings/.test(e.message) && !e.message.includes(TOKEN));
    assert.throws(() => new AdaptadorHttp({ url: "file:///etc/passwd", token: TOKEN }), /http ou https/);
    assert.throws(() => new AdaptadorHttp({ url: "http://x", token: "curto" }), /32 caracteres/);
  });
});
