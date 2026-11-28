// SPDX-License-Identifier: AGPL-3.0-only
// Cliente do Growth OS com fetch falso: autenticação, organização, corpo sem dado de saúde, erros.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ClienteGrowthOs } from "./cliente.ts";

function montar(resposta: (url: string, init: RequestInit) => Response | Promise<Response>, token: string | null = "tok") {
  const pedidos: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => { pedidos.push({ url, init }); return resposta(url, init); }) as unknown as typeof fetch;
  const c = new ClienteGrowthOs("https://growth.exemplo.test", { token: async () => token, organizacao: async () => "org-a" }, f, 50);
  return { c, pedidos };
}

describe("ClienteGrowthOs", () => {
  it("refuses plain http outside localhost", () => {
    assert.throws(() => new ClienteGrowthOs("http://growth.exemplo.test", { token: async () => null, organizacao: async () => null }));
    assert.doesNotThrow(() => new ClienteGrowthOs("http://localhost:3000", { token: async () => null, organizacao: async () => null }));
  });

  it("without login it does not call the network", async () => {
    const { c, pedidos } = montar(() => Response.json({}), null);
    assert.deepEqual(await c.catalogo(), { ok: false, status: 401, codigo: "sem_login" });
    assert.equal(pedidos.length, 0);
  });

  it("sends the bearer token and the organization; the session summary carries only counts", async () => {
    const { c, pedidos } = montar(() => Response.json({ registrado: true }, { status: 201 }));
    const r = await c.enviarResumo("a1b2c3d4e5f6a7b8c9d0", { duracaoS: 1530, trocasAutomaticas: 6, pulosManuais: 1, percentualAdaptado: 91.6, versaoMotor: "0.1.0" });
    assert.deepEqual(r, { ok: true, dados: { registrado: true } });
    const p = pedidos[0]!;
    assert.equal(p.url, "https://growth.exemplo.test/api/musica/sessoes");
    const h = p.init.headers as Record<string, string>;
    assert.equal(h.authorization, "Bearer tok");
    assert.equal(h["x-organizacao"], "org-a");
    assert.deepEqual(JSON.parse(p.init.body as string), { sessaoRef: "a1b2c3d4e5f6a7b8c9d0", duracaoMin: 26, trocasAutomaticas: 6, pulosManuais: 1, percentualAdaptado: 92, versaoMotor: "0.1.0" });
  });

  it("maps server errors, network failure and timeout to codes", async () => {
    assert.deepEqual(await montar(() => Response.json({ error: "sem_consentimento_agregados" }, { status: 403 })).c.catalogo(), { ok: false, status: 403, codigo: "sem_consentimento_agregados" });
    assert.deepEqual(await montar(() => { throw new TypeError("rede"); }).c.catalogo(), { ok: false, status: 0, codigo: "sem_rede" });
    const lento = montar((_u, init) => new Promise((_, rej) => init.signal?.addEventListener("abort", () => rej(Object.assign(new Error("x"), { name: "AbortError" })))));
    assert.deepEqual(await lento.c.catalogo(), { ok: false, status: 0, codigo: "tempo_esgotado" });
  });

  it("granting consent always marks it specific; revoking does not", async () => {
    const { c, pedidos } = montar(() => Response.json({}, { status: 201 }));
    await c.registrarConsentimento("adaptacao_musical", true, "musica-v1");
    await c.registrarConsentimento("adaptacao_musical", false, "musica-v1");
    assert.deepEqual(pedidos.map((p) => JSON.parse(p.init.body as string).especifico), [true, false]);
  });
});
