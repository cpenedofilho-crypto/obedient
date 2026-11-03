// SPDX-License-Identifier: AGPL-3.0-only
//
// O adaptador contra uma API falsa (fetch injetado no SDK; nada sai para a rede): o pedido que sai,
// a resposta que volta ao laço sem edição, o gasto por modelo e a leitura dos erros.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { ErroModelo } from "@obedient/agent-orchestrator";
import { MODELO_PADRAO, ModeloAnthropic, PRECOS, custoEmDolares } from "./index.ts";

interface Pedido {
  url: string;
  headers: Headers;
  corpo: Record<string, unknown>;
}

function apiFalsa(responder: (p: Pedido) => { status?: number; json: unknown }) {
  const pedidos: Pedido[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const p = { url: String(url), headers: new Headers(init?.headers), corpo: JSON.parse(String(init?.body ?? "{}")) };
    pedidos.push(p);
    const r = responder(p);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  // Chave falsa: o fetch é nosso, nada chega à Anthropic.
  const cliente = new Anthropic({ apiKey: "chave-de-teste", fetch, maxRetries: 0 });
  return { cliente, pedidos };
}

const mensagem = (extra: Record<string, unknown> = {}) => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: MODELO_PADRAO,
  content: [
    { type: "thinking", thinking: "", signature: "assinatura-opaca" },
    { type: "tool_use", id: "tu_1", name: "google_agenda__listar_eventos", input: { de: "2026-11-04T00:00:00Z", ate: "2026-11-05T00:00:00Z" } },
  ],
  stop_reason: "tool_use",
  stop_sequence: null,
  usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 },
  ...extra,
});

const pedido = (signal = new AbortController().signal) => ({
  system: "Você é o OBEDIENT.",
  messages: [{ role: "user" as const, content: "Quais compromissos tenho amanhã?" }],
  tools: [{ name: "google_agenda__listar_eventos", description: "Lista eventos", input_schema: { type: "object", properties: {}, additionalProperties: false } }],
  maxTokens: 16_000,
  signal,
});

describe("modelo Anthropic", () => {
  it("o pedido: modelo, esforço, ferramentas, cache e fallback; a resposta volta sem edição", async () => {
    const { cliente, pedidos } = apiFalsa(() => ({ json: mensagem() }));
    const m = new ModeloAnthropic({ cliente });
    const r = await m.responder(pedido());
    const p = pedidos[0]!;
    assert.match(p.url, /\/v1\/messages(\?|$)/);
    assert.equal(p.corpo.model, "claude-opus-5-5");
    assert.equal(p.corpo.max_tokens, 16_000);
    assert.deepEqual(p.corpo.output_config, { effort: "high" });
    assert.equal(p.corpo.thinking, undefined, "raciocínio no modo do modelo (adaptativo)");
    assert.equal(p.corpo.temperature, undefined);
    assert.deepEqual(p.corpo.cache_control, { type: "ephemeral" });
    assert.equal(p.corpo.fallbacks, "default");
    assert.match(p.headers.get("anthropic-beta") ?? "", /server-side-fallback-2026-07-01/);
    assert.equal((p.corpo.tools as { name: string }[])[0]!.name, "google_agenda__listar_eventos");
    assert.equal(p.corpo.system, "Você é o OBEDIENT.");
    // O bloco de raciocínio volta inteiro: o laço o devolve ao modelo como veio.
    assert.deepEqual(r.content[0], { type: "thinking", thinking: "", signature: "assinatura-opaca" });
    assert.equal(r.stopReason, "tool_use");
    assert.deepEqual(r.usage, { input: 1000, output: 200, cacheRead: 5000, cacheWrite: 0 });
    // 1000 × 4 + 200 × 20 + 5000 × 0,20, por milhão.
    assert.ok(Math.abs(m.gastoEmDolares - (4000 + 4000 + 1000) / 1e6) < 1e-12);
  });

  it("sem fallback quando desligado ou onde não existe", async () => {
    for (const o of [{ fallbacks: false }, { modelo: "claude-haiku-5-5" }]) {
      const { cliente, pedidos } = apiFalsa(() => ({ json: mensagem({ model: o.modelo ?? MODELO_PADRAO }) }));
      await new ModeloAnthropic({ cliente, ...o }).responder(pedido());
      assert.equal(pedidos[0]!.corpo.fallbacks, undefined, JSON.stringify(o));
      assert.doesNotMatch(pedidos[0]!.headers.get("anthropic-beta") ?? "", /server-side-fallback/);
    }
  });

  it("com fallback, cada tentativa é cobrada pelo modelo que a fez", async () => {
    const iteracoes = [
      { type: "message", model: "claude-opus-5-5", input_tokens: 1000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      { type: "fallback_message", model: "claude-opus-5", input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: null },
    ];
    const { cliente } = apiFalsa(() => ({ json: mensagem({ model: "claude-opus-5", usage: { input_tokens: 1000, output_tokens: 100, iterations: iteracoes } }) }));
    const m = new ModeloAnthropic({ cliente });
    await m.responder(pedido());
    assert.ok(Math.abs(m.gastoEmDolares - (1000 * 4 + 1000 * 5 + 100 * 25) / 1e6) < 1e-12);
  });

  it("modelo fora da tabela de preços não sobe; modelo desconhecido numa resposta é cobrado pelo mais caro", () => {
    const { cliente } = apiFalsa(() => ({ json: {} }));
    assert.throws(() => new ModeloAnthropic({ cliente, modelo: "claude-qualquer" }), /sem preço/);
    const maisCaro = Math.max(...Object.values(PRECOS).map((p) => p.saida));
    assert.equal(custoEmDolares("modelo-novo", { input_tokens: 0, output_tokens: 1_000_000 }), maisCaro);
  });

  it("erros: o que passa vira transitório; o resto, falha clara", async () => {
    const casos: [number, unknown, string, boolean][] = [
      [429, { type: "error", error: { type: "rate_limit_error", message: "x" } }, "limite_de_uso", true],
      [529, { type: "error", error: { type: "overloaded_error", message: "x" } }, "indisponivel", true],
      [500, { type: "error", error: { type: "api_error", message: "x" } }, "indisponivel", true],
      [401, { type: "error", error: { type: "authentication_error", message: "x" } }, "credencial", false],
      [400, { type: "error", error: { type: "invalid_request_error", message: "tools.0: inválido" } }, "pedido_recusado", false],
    ];
    for (const [status, json, codigo, transitorio] of casos) {
      const { cliente } = apiFalsa(() => ({ status, json }));
      await assert.rejects(new ModeloAnthropic({ cliente }).responder(pedido()), (e: unknown) => {
        assert.ok(e instanceof ErroModelo, String(e));
        assert.deepEqual([e.codigo, e.transitorio], [codigo, transitorio], `${status}`);
        assert.doesNotMatch(e.message, /chave-de-teste/);
        return true;
      });
    }
    // Sem rede.
    const semRede = new Anthropic({ apiKey: "chave-de-teste", maxRetries: 0, fetch: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch });
    await assert.rejects(new ModeloAnthropic({ cliente: semRede }).responder(pedido()), (e: ErroModelo) => e.codigo === "rede" && e.transitorio);
    // O laço abortou (prazo da tentativa).
    const c = new AbortController();
    c.abort();
    const { cliente } = apiFalsa(() => ({ json: mensagem() }));
    await assert.rejects(new ModeloAnthropic({ cliente }).responder(pedido(c.signal)), (e: ErroModelo) => e.codigo === "timeout" && !e.transitorio);
  });
});
