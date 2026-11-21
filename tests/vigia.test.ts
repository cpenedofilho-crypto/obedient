// SPDX-License-Identifier: AGPL-3.0-only
//
// O vigia (A4): lê os alertas acesos, acusa /health e /ready fora, token errado nas métricas; com tudo
// em ordem, sai ok. Nada sai para a rede: o servidor é falso.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { alertasAcesos, vigiar } from "../scripts/vigia/vigia.ts";

const METRICAS = (parada: number, reserva: number) => `# HELP obedient_alerta Alertas (1 = aceso).
# TYPE obedient_alerta gauge
obedient_alerta{tipo="parada_geral"} ${parada}
obedient_alerta{tipo="reserva_vencida"} ${reserva}
obedient_alerta{tipo="bloqueadas_acumuladas"} 0
obedient_missoes{estado="blocked"} 12
`;

function servidor(o: { health?: number; ready?: Response; metrics?: string; token?: string; cai?: boolean } = {}) {
  const pedidos: { caminho: string; auth: string | null }[] = [];
  const http = async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    pedidos.push({ caminho: u.pathname, auth: new Headers(init?.headers).get("authorization") });
    if (o.cai) throw new TypeError("sem conexão");
    if (u.pathname === "/health") return Response.json({ vivo: true, versao: "abcdef012345" }, { status: o.health ?? 200 });
    if (u.pathname === "/ready") return o.ready ?? Response.json({ pronto: true });
    if (u.pathname === "/metrics") {
      if (new Headers(init?.headers).get("authorization") !== `Bearer ${o.token ?? "tok"}`) return new Response("não autorizado", { status: 401 });
      return new Response(o.metrics ?? METRICAS(0, 0));
    }
    return new Response("", { status: 404 });
  };
  return { http, pedidos };
}

describe("vigia (A4)", () => {
  it("lê só os alertas acesos, pelo nome; outras métricas não contam", () => {
    assert.deepEqual(alertasAcesos(METRICAS(0, 0)), []);
    assert.deepEqual(alertasAcesos(METRICAS(1, 1)), ["parada_geral", "reserva_vencida"]);
  });

  it("tudo em ordem: ok, com a versão; o token vai só para /metrics", async () => {
    const s = servidor();
    const r = await vigiar("https://obedient.exemplo.test", "tok", s.http);
    assert.equal(r.ok, true);
    assert.match(r.linhas.join("\n"), /versão `abcdef012345`/);
    assert.deepEqual(s.pedidos.map((p) => [p.caminho, p.auth]), [["/health", null], ["/ready", null], ["/metrics", "Bearer tok"]]);
  });

  it("alerta aceso, /ready com migrations pendentes ou /health fora: não ok, e diz o que fazer", async () => {
    const a = await vigiar("https://o.test", "tok", servidor({ metrics: METRICAS(0, 1) }).http);
    assert.equal(a.ok, false);
    assert.match(a.linhas.join("\n"), /alerta aceso: reserva_vencida/);
    const b = await vigiar("https://o.test", "tok", servidor({ ready: Response.json({ pronto: false, motivo: "migrations", pendentes: ["0017"] }, { status: 503 }) }).http);
    assert.equal(b.ok, false);
    assert.match(b.linhas.join("\n"), /HTTP 503, motivo: migrations/);
    const c = await vigiar("https://o.test", "tok", servidor({ cai: true }).http);
    assert.equal(c.ok, false);
    assert.match(c.linhas.join("\n"), /\/health não responde/);
  });

  it("200 que não é o /health do OBEDIENT (a página do app de uma versão antiga) não passa", async () => {
    const http = async () => new Response("<!doctype html><html></html>", { headers: { "content-type": "text/html" } });
    const r = await vigiar("https://o.test", "tok", http);
    assert.equal(r.ok, false);
    assert.match(r.linhas.join("\n"), /não é o OBEDIENT esperado/);
  });

  it("token errado nas métricas é acusado; sem token, as métricas ficam de fora sem falhar", async () => {
    const errado = await vigiar("https://o.test", "outro", servidor().http);
    assert.equal(errado.ok, false);
    assert.match(errado.linhas.join("\n"), /401/);
    const s = servidor();
    const sem = await vigiar("https://o.test", undefined, s.http);
    assert.equal(sem.ok, true);
    assert.ok(!s.pedidos.some((p) => p.caminho === "/metrics"));
  });
});
