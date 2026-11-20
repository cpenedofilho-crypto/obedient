// SPDX-License-Identifier: AGPL-3.0-only
//
// Saúde, prontidão e métricas (D20, M5; G8): /health não toca o banco, /ready confere as migrations,
// /metrics fecha por padrão e só devolve números somados, sem dado de pessoa.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { ManualClock } from "@obedient/core";
import { comoOperador, comoUsuario, lerMetricas, missoesNaTransacao, motorNaTransacao } from "@obedient/store-postgres";
import { bancoDeTeste, type BancoDeTeste } from "../../store-postgres/src/banco-de-teste.ts";
import { criarApi, type Pedido } from "./api.ts";
import { servidorHttp } from "./http.ts";
import { textoPrometheus, tokenConfere, versaoDoAmbiente } from "./saude.ts";

const T0 = new Date("2026-11-19T12:00:00Z");
const ORIGIN = "https://obedient.exemplo.test";
const TOKEN = "token-de-metricas-de-teste-com-tamanho";
let banco: BancoDeTeste;
const clock = new ManualClock(T0);
before(async () => {
  banco = await bancoDeTeste();
});
after(() => banco.fechar());

const get = (path: string, headers: Record<string, string> = {}): Pedido => ({ method: "GET", path, headers, body: "" });
const api = (tokenMetricas?: string) => criarApi(banco.db, { rpName: "OBEDIENT", rpId: "obedient.exemplo.test", origin: ORIGIN, ...(tokenMetricas ? { tokenMetricas } : {}) }, clock);
const missoes = <T>(u: string, fn: (ms: ReturnType<typeof missoesNaTransacao>) => Promise<T>) =>
  comoUsuario(banco.db, u, (tx) => fn(missoesNaTransacao(tx, motorNaTransacao(tx, { clock }), clock)));

describe("saúde, prontidão e métricas (D20, M5)", () => {
  it("/health responde sem sessão; /ready confere que todas as migrations do código estão aplicadas", async () => {
    const a = api();
    const h = await a(get("/health"));
    assert.deepEqual([h.status, JSON.parse(h.body)], [200, { vivo: true }]);
    const r = await a(get("/ready"));
    assert.deepEqual([r.status, JSON.parse(r.body)], [200, { pronto: true }]);
  });

  it("/health mostra a versão do código (M7): o commit do deploy, só hexadecimal, cortado em 12", async () => {
    assert.equal(versaoDoAmbiente({}), null);
    assert.equal(versaoDoAmbiente({ RAILWAY_GIT_COMMIT_SHA: "ABCDEF0123456789abcdef0123456789abcdef01" }), "abcdef012345");
    assert.equal(versaoDoAmbiente({ OBEDIENT_VERSAO: "1234567", RAILWAY_GIT_COMMIT_SHA: "a".repeat(40) }), "1234567", "a do dono vale primeiro");
    assert.equal(versaoDoAmbiente({ OBEDIENT_VERSAO: "<script>", RAILWAY_GIT_COMMIT_SHA: "123456" }), null, "texto arbitrário não entra");
    const h = await criarApi(banco.db, { rpName: "OBEDIENT", rpId: "obedient.exemplo.test", origin: ORIGIN, versao: "abcdef012345" }, clock)(get("/health"));
    assert.deepEqual(JSON.parse(h.body), { vivo: true, versao: "abcdef012345" });
  });

  it("/ready: migration com conteúdo diferente do código deixa o servidor não pronto (503), com o nome dela", async () => {
    const { rows } = await banco.db.query<{ name: string; hash: string }>("select name, hash from obedient.schema_migrations order by name limit 1");
    const [m] = rows;
    await banco.db.query("update obedient.schema_migrations set hash = 'outro' where name = $1", [m!.name]);
    try {
      const r = await api()(get("/ready"));
      assert.equal(r.status, 503);
      assert.deepEqual(JSON.parse(r.body), { pronto: false, motivo: "migrations", pendentes: [], divergentes: [m!.name] });
    } finally {
      await banco.db.query("update obedient.schema_migrations set hash = $2 where name = $1", [m!.name, m!.hash]);
    }
  });

  it("/metrics fecha por padrão: sem token configurado não existe; com token, exige o token certo", async () => {
    assert.equal((await api()(get("/metrics"))).status, 404);
    const a = api(TOKEN);
    assert.equal((await a(get("/metrics"))).status, 401);
    assert.equal((await a(get("/metrics", { authorization: "Bearer errado" }))).status, 401);
    assert.equal((await a(get("/metrics", { authorization: TOKEN }))).status, 401, "sem o Bearer");
    const ok = await a(get("/metrics", { authorization: `Bearer ${TOKEN}` }));
    assert.equal(ok.status, 200);
    assert.match(ok.headers["content-type"]!, /^text\/plain; version=0\.0\.4/);
  });

  it("as métricas somam todas as pessoas e não levam id, objetivo nem texto de ninguém", async () => {
    const ana = "ana-metricas-7f3";
    const bia = "bia-metricas-9k2";
    const antes = await comoOperador(banco.db, (tx) => lerMetricas(tx, clock.now()));
    await missoes(ana, (ms) => ms.criar(ana, "obedient", "Objetivo secreto da Ana"));
    const b = await missoes(bia, (ms) => ms.criar(bia, "obedient", "Objetivo secreto da Bia"));
    const r = await missoes(bia, (ms) => ms.reservar(b.id));
    await missoes(bia, (ms) => ms.concluir(r.missao, { tipo: "nao_consegui", explicacao: "Explicação secreta", custoCentavos: 42 }));
    const depois = await comoOperador(banco.db, (tx) => lerMetricas(tx, clock.now()));
    assert.equal((depois.missoesPorEstado.created ?? 0) - (antes.missoesPorEstado.created ?? 0), 1);
    assert.equal((depois.missoesPorEstado.failed ?? 0) - (antes.missoesPorEstado.failed ?? 0), 1);
    assert.equal(depois.gastoMesCentavos - antes.gastoMesCentavos, 42);
    const corpo = (await api(TOKEN)(get("/metrics", { authorization: `Bearer ${TOKEN}` }))).body;
    for (const segredo of [ana, bia, "secreto", "Explicação", b.id]) assert.ok(!corpo.includes(segredo), segredo);
    assert.match(corpo, /^obedient_missoes\{estado="failed"\} \d+$/m);
    assert.match(corpo, /^obedient_gasto_mes_centavos \d+$/m);
  });

  it("o papel do app não lê as métricas; o operador lê só pelas funções, nunca a tabela", async () => {
    await assert.rejects(comoUsuario(banco.db, "ana-x", (tx) => tx.query("select obedient.metricas(now(), now(), 1)")), /permission denied/);
    await assert.rejects(comoOperador(banco.db, (tx) => tx.query("select estado from obedient.missions")), /permission denied/);
    await assert.rejects(comoOperador(banco.db, (tx) => tx.query("select name from obedient.schema_migrations")), /permission denied/);
  });

  it("alertas: medidores 0/1 com limiares fixos; rótulos só de listas fechadas", () => {
    const t = textoPrometheus({ missoesPorEstado: { blocked: 10, 'x"}\nmal': 1 }, reservasVencidas: 1, aprovacoesPendentes: 0, passos24hPorTipo: {}, gastoMesCentavos: 0, pessoasNoTetoMes: 0, paradaGeral: true });
    assert.match(t, /^obedient_alerta\{tipo="parada_geral"\} 1$/m);
    assert.match(t, /^obedient_alerta\{tipo="reserva_vencida"\} 1$/m);
    assert.match(t, /^obedient_alerta\{tipo="bloqueadas_acumuladas"\} 1$/m);
    assert.match(t, /^obedient_alerta\{tipo="teto_do_mes"\} 0$/m);
    assert.ok(!t.includes('"}\nmal'), "rótulo não injeta linha");
    assert.equal(tokenConfere("Bearer  abc ", "abc"), true);
    assert.equal(tokenConfere("Bearer abc", "   "), false, "token vazio nunca confere");
  });

  it("o servidor HTTP leva /health, /ready e /metrics à API (não é arquivo do app)", async () => {
    const srv = servidorHttp(api(TOKEN)).listen(0);
    try {
      const porta = (srv.address() as AddressInfo).port;
      const pedir = (path: string) =>
        new Promise<{ status: number; body: string }>((ok, falha) => {
          const req = request({ host: "127.0.0.1", port: porta, path }, (res) => {
            let b = "";
            res.on("data", (c) => (b += c));
            res.on("end", () => ok({ status: res.statusCode ?? 0, body: b }));
          });
          req.on("error", falha);
          req.end();
        });
      assert.deepEqual(await pedir("/health"), { status: 200, body: '{"vivo":true}' });
      assert.equal((await pedir("/ready")).status, 200);
      assert.equal((await pedir("/metrics")).status, 401);
    } finally {
      srv.close();
    }
  });
});
