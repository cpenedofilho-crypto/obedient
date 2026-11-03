// SPDX-License-Identifier: AGPL-3.0-only
//
// A API do app de ponta a ponta, sem navegador: um autenticador de software cadastra a passkey,
// entra, reautentica; o painel mostra o que o motor tem; as ações passam pelo motor e pela RLS.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { ManualClock } from "@obedient/core";
import { comoOperador, comoUsuario, memoriaNaTransacao, motorNaTransacao } from "@obedient/store-postgres";
import { bancoDeTeste, type BancoDeTeste } from "../../store-postgres/src/banco-de-teste.ts";
import { AutenticadorDeTeste } from "./autenticador-de-teste.ts";
import { COOKIE, criarApi, lerCookie, type Pedido } from "./api.ts";
import { arquivoEstatico, servidorHttp } from "./http.ts";
import { Passkeys } from "./passkeys.ts";
import { processarMissoes } from "./processador.ts";

const ORIGIN = "https://obedient.exemplo.test";
const RP_ID = "obedient.exemplo.test";
const T0 = new Date("2026-11-03T12:00:00Z");
const H = 3_600_000;

let banco: BancoDeTeste;
let clock: ManualClock;
let api: ReturnType<typeof criarApi>;
before(async () => {
  banco = await bancoDeTeste();
  clock = new ManualClock(T0);
  api = criarApi(banco.db, { rpName: "OBEDIENT", rpId: RP_ID, origin: ORIGIN }, clock);
});
after(() => banco.fechar());

let n = 0;
const usuario = (nome: string) => `${nome}-${++n}`;
let op = 0;
const opId = () => `op-${Date.now().toString(36)}-${++op}`;

function post(path: string, corpo: unknown, cookie?: string, extra: Record<string, string> = {}): Pedido {
  return {
    method: "POST",
    path,
    headers: { origin: ORIGIN, "x-obedient": "1", "content-type": "application/json", ...(cookie ? { cookie: `${COOKIE}=${cookie}` } : {}), ...extra },
    body: JSON.stringify(corpo),
  };
}
const get = (path: string, cookie?: string): Pedido => ({ method: "GET", path, headers: cookie ? { cookie: `${COOKIE}=${cookie}` } : {}, body: "" });
const corpo = <T = Record<string, unknown>>(r: { body: string }) => JSON.parse(r.body) as T;

/** Convite + cadastro da passkey: devolve o autenticador e o cookie da sessão. */
async function cadastrar(u: string) {
  const { codigo } = await Passkeys.criarConvite(banco.db, u, clock);
  const aut = new AutenticadorDeTeste(ORIGIN, RP_ID);
  const opcoes = await api(post("/api/convite/opcoes", { codigo }));
  assert.equal(opcoes.status, 200, opcoes.body);
  const fim = await api(post("/api/convite/concluir", { codigo, resposta: aut.cadastrar(corpo(opcoes)) }));
  assert.equal(fim.status, 200, fim.body);
  const token = lerCookie(fim.headers["set-cookie"]?.split(";")[0], COOKIE);
  assert.ok(token);
  return { aut, codigo, token: token! };
}

/** O agente pede algo pelo motor (o que o runtime fará em produção). */
const motorDe = <T>(u: string, fn: (m: ReturnType<typeof motorNaTransacao>) => Promise<T>) => comoUsuario(banco.db, u, (tx) => fn(motorNaTransacao(tx, { clock })));
async function grantEPedidos(u: string) {
  const g = await motorDe(u, (m) =>
    m.grants.grant(
      { userId: u, agentId: "obedient", systemId: "mail", capability: "mail.*", purpose: "cuidar do e-mail de trabalho", limits: { maxRisk: "CRITICAL", autonomousUpTo: "LOW", maxAmount: null, amountField: null }, expiresAt: new Date(T0.getTime() + 8 * H) },
      u,
    ),
  );
  const alto = await motorDe(u, (m) => m.authorize({ userId: u, agentId: "obedient", systemId: "mail", tool: "mail.send", risk: "HIGH", category: "COMMUNICATION", args: { para: "equipe@exemplo.org", assunto: "Resumo da semana" } }));
  clock.advance(1000); // ordem dos cartões: o mais antigo primeiro
  const critico = await motorDe(u, (m) => m.authorize({ userId: u, agentId: "obedient", systemId: "mail", tool: "mail.delete_all", risk: "LOW", category: "DESTRUCTIVE", args: { pasta: "Arquivo" } }));
  assert.equal(alto.outcome, "approval_required");
  assert.equal(critico.outcome, "approval_required");
  return { g, alto: alto.outcome === "approval_required" ? alto.proposal : null!, critico: critico.outcome === "approval_required" ? critico.proposal : null! };
}

describe("entrada por passkey", () => {
  it("convite cadastra a passkey uma vez só e já entra", async () => {
    const u = usuario("ana");
    const { codigo, token } = await cadastrar(u);
    assert.equal((await api(get("/api/painel", token))).status, 200);
    const de_novo = await api(post("/api/convite/opcoes", { codigo }));
    assert.equal(de_novo.status, 401);
    assert.equal(corpo(de_novo).erro, "UNAUTHENTICATED");
  });

  it("entrar com a passkey; página falsa, desafio repetido e contador repetido são recusados", async () => {
    const u = usuario("ana");
    const { aut } = await cadastrar(u);
    const o1 = corpo<{ challenge: string }>(await api(post("/api/entrar/opcoes", {})));
    const ok = await api(post("/api/entrar", { resposta: aut.entrar(o1) }));
    assert.equal(ok.status, 200, ok.body);
    assert.equal(corpo(ok).usuario, u);
    const aceito = aut.contador;
    // o mesmo desafio de novo
    assert.equal((await api(post("/api/entrar", { resposta: aut.entrar(o1) }))).status, 401, "desafio repetido");
    // site falso: o aparelho assina com a origem de quem pediu
    const o2 = corpo<{ challenge: string }>(await api(post("/api/entrar/opcoes", {})));
    assert.equal((await api(post("/api/entrar", { resposta: aut.entrar(o2, { origin: "https://obedient-exemplo.test.golpe" }) }))).status, 401, "origem falsa");
    // contador igual ao último aceito: passkey copiada
    const o3 = corpo<{ challenge: string }>(await api(post("/api/entrar/opcoes", {})));
    assert.equal((await api(post("/api/entrar", { resposta: aut.entrar(o3, { contador: aceito }) }))).status, 401, "contador repetido");
    // com o contador avançando, a mesma passkey entra de novo
    const o5 = corpo<{ challenge: string }>(await api(post("/api/entrar/opcoes", {})));
    assert.equal((await api(post("/api/entrar", { resposta: aut.entrar(o5, { contador: aceito + 5 }) }))).status, 200, "contador avançou");
    // passkey que o servidor não conhece
    const o4 = corpo<{ challenge: string }>(await api(post("/api/entrar/opcoes", {})));
    assert.equal((await api(post("/api/entrar", { resposta: new AutenticadorDeTeste(ORIGIN, RP_ID).entrar(o4) }))).status, 401);
  });

  it("passkey sem contador (sincronizada) entra normalmente", async () => {
    const u = usuario("ana");
    const { codigo } = await Passkeys.criarConvite(banco.db, u, clock);
    const aut = new AutenticadorDeTeste(ORIGIN, RP_ID, false);
    const o = corpo<{ challenge: string; rp: { id: string } }>(await api(post("/api/convite/opcoes", { codigo })));
    assert.equal((await api(post("/api/convite/concluir", { codigo, resposta: aut.cadastrar(o) }))).status, 200);
    for (let i = 0; i < 2; i++) {
      const oe = corpo<{ challenge: string }>(await api(post("/api/entrar/opcoes", {})));
      assert.equal((await api(post("/api/entrar", { resposta: aut.entrar(oe) }))).status, 200);
    }
  });

  it("sem sessão, nada; pedido de fora do app não muda nada (CSRF)", async () => {
    assert.equal((await api(get("/api/painel"))).status, 401);
    assert.equal((await api(get("/api/painel", "x".repeat(43)))).status, 401);
    const { token } = await cadastrar(usuario("ana"));
    for (const h of [{ origin: "https://outro.site" }, { "x-obedient": "" }, { "content-type": "text/plain" }] as Record<string, string>[])
      assert.equal((await api(post("/api/acoes", { opId: opId(), tipo: "parar" }, token, h))).status, 403, JSON.stringify(h));
    const semOrigem = post("/api/acoes", { opId: opId(), tipo: "parar" }, token);
    delete semOrigem.headers.origin;
    assert.equal((await api(semOrigem)).status, 403);
  });

  it("sair encerra a sessão", async () => {
    const { token } = await cadastrar(usuario("ana"));
    const r = await api(post("/api/sair", {}, token));
    assert.match(r.headers["set-cookie"] ?? "", /Max-Age=0/);
    assert.equal((await api(get("/api/painel", token))).status, 401);
  });
});

describe("painel e ações", () => {
  it("o painel mostra pedidos, autorizações e atividade em português", async () => {
    const u = usuario("ana");
    const { token } = await cadastrar(u);
    await grantEPedidos(u);
    const p = corpo<{
      pedidos: { acao: string; agente: string; exigeReautenticacao: boolean; detalhes: { campo: string; valor: string }[] }[];
      autorizacoes: { finalidade: string }[];
      atividade: { texto: string }[];
      parada: null;
    }>(await api(get("/api/painel", token)));
    assert.deepEqual(p.pedidos.map((c) => [c.acao, c.agente, c.exigeReautenticacao]), [["mail.send", "obedient", false], ["mail.delete_all", "obedient", true]]);
    assert.deepEqual(p.pedidos[0]!.detalhes, [{ campo: "assunto", valor: "Resumo da semana" }, { campo: "para", valor: "equipe@exemplo.org" }]);
    assert.equal(p.autorizacoes[0]!.finalidade, "cuidar do e-mail de trabalho");
    assert.match(p.atividade[0]!.texto, /pediu sua aprovação para mail\.delete_all em mail/);
    assert.equal(p.parada, null);
  });

  it("aprovar: uma vez só, a mesma ação reenviada devolve o mesmo resultado", async () => {
    const u = usuario("ana");
    const { token } = await cadastrar(u);
    const { alto } = await grantEPedidos(u);
    const acao = { opId: opId(), tipo: "aprovar", propostaId: alto.id, hash: alto.payloadHash };
    const r1 = corpo<{ resultado: { ok: boolean }; repetida: boolean }>(await api(post("/api/acoes", acao, token)));
    assert.deepEqual(r1, { resultado: { ok: true, tipo: "aprovar" }, repetida: false });
    const r2 = corpo<{ resultado: { ok: boolean }; repetida: boolean }>(await api(post("/api/acoes", acao, token)));
    assert.deepEqual(r2, { resultado: { ok: true, tipo: "aprovar" }, repetida: true });
    // Outra ação, mesmo pedido: já decidido.
    const r3 = corpo<{ resultado: { ok: boolean; codigo: string; mensagem: string } }>(await api(post("/api/acoes", { ...acao, opId: opId() }, token)));
    assert.equal(r3.resultado.codigo, "PROPOSAL_NOT_PENDING");
    assert.match(r3.resultado.mensagem, /já tinha sido decidido/);
    assert.equal((await motorDe(u, (m) => m.approvals.get(alto.id)))?.status, "approved");
  });

  it("a mesma ação chegando várias vezes ao mesmo tempo é feita uma vez", async () => {
    const u = usuario("ana");
    const { token } = await cadastrar(u);
    const { alto } = await grantEPedidos(u);
    const acao = { opId: opId(), tipo: "aprovar", propostaId: alto.id, hash: alto.payloadHash };
    const rs = await Promise.all(Array.from({ length: 4 }, () => api(post("/api/acoes", acao, token))));
    assert.ok(rs.every((r) => r.status === 200), rs.map((r) => r.body).join("\n"));
    const resultados = rs.map((r) => corpo<{ resultado: { ok: boolean } }>(r).resultado.ok);
    assert.ok(resultados.every((x) => x === true));
    const trilha = await motorDe(u, (m) => m.audit.forUser(u));
    assert.equal(trilha.filter((e) => e.event === "proposal.approve" && e.outcome === "approved").length, 1);
  });

  it("aprovar com o cartão adulterado é recusado (o hash é o do que a pessoa viu)", async () => {
    const u = usuario("ana");
    const { token } = await cadastrar(u);
    const { alto } = await grantEPedidos(u);
    const r = corpo<{ resultado: { codigo: string } }>(await api(post("/api/acoes", { opId: opId(), tipo: "aprovar", propostaId: alto.id, hash: "a".repeat(64) }, token)));
    assert.equal(r.resultado.codigo, "PAYLOAD_MISMATCH");
  });

  it("ação CRITICAL: exige reautenticação recente com a passkey; depois de 5 minutos, de novo", async () => {
    const u = usuario("ana");
    const { aut, token } = await cadastrar(u);
    const { critico } = await grantEPedidos(u);
    // A sessão nasceu forte no cadastro; passados 5 minutos, já não é.
    clock.advance(6 * 60 * 1000);
    const aprovar = () => api(post("/api/acoes", { opId: opId(), tipo: "aprovar", propostaId: critico.id, hash: critico.payloadHash }, token));
    const sem = corpo<{ resultado: { codigo: string; mensagem: string } }>(await aprovar());
    assert.equal(sem.resultado.codigo, "STRONG_AUTH_REQUIRED");
    assert.match(sem.resultado.mensagem, /confirme que é você/);
    assert.equal(corpo(await api(get("/api/painel", token))).reautenticado, false);

    const o = corpo<{ challenge: string; allowCredentials: { id: string }[] }>(await api(post("/api/reautenticar/opcoes", {}, token)));
    assert.deepEqual(o.allowCredentials.map((c) => c.id), [aut.id]);
    assert.equal((await api(post("/api/reautenticar", { resposta: aut.entrar(o) }, token))).status, 200);
    assert.equal(corpo(await api(get("/api/painel", token))).reautenticado, true);
    assert.equal(corpo<{ resultado: { ok: boolean } }>(await aprovar()).resultado.ok, true);
  });

  it("reautenticar com a passkey de outra pessoa não vale", async () => {
    const ana = usuario("ana");
    const bia = usuario("bia");
    const { token } = await cadastrar(ana);
    const { aut: daBia } = await cadastrar(bia);
    const o = corpo<{ challenge: string }>(await api(post("/api/reautenticar/opcoes", {}, token)));
    assert.equal((await api(post("/api/reautenticar", { resposta: daBia.entrar(o) }, token))).status, 401);
  });

  it("parar: o agente é barrado na hora; liberar volta; a parada geral só o operador libera", async () => {
    const u = usuario("ana");
    const { token } = await cadastrar(u);
    await grantEPedidos(u);
    assert.equal(corpo<{ resultado: { ok: boolean } }>(await api(post("/api/acoes", { opId: opId(), tipo: "parar" }, token))).resultado.ok, true);
    const p = corpo<{ parada: { global: boolean; motivo: string }; pedidos: unknown[] }>(await api(get("/api/painel", token)));
    assert.deepEqual([p.parada.global, p.parada.motivo], [false, "acionada pela pessoa no app"]);
    assert.equal(p.pedidos.length, 0, "a parada cancela o que esperava aprovação");
    const ler = () => motorDe(u, (m) => m.authorize({ userId: u, agentId: "obedient", systemId: "mail", tool: "mail.list", risk: "LOW", category: "READ", args: {} }));
    assert.equal((await ler()).outcome, "denied");
    assert.equal(corpo<{ resultado: { ok: boolean } }>(await api(post("/api/acoes", { opId: opId(), tipo: "liberar" }, token))).resultado.ok, true);
    assert.equal((await ler()).outcome, "allowed");
    assert.match(corpo<{ atividade: { texto: string }[] }>(await api(get("/api/painel", token))).atividade.map((a) => a.texto).join("\n"), /Parada liberada/);

    await comoOperador(banco.db, (tx) => motorNaTransacao(tx, { clock }).stop.engage({ kind: "global" }, "op-1", "manutenção"));
    try {
      assert.equal(corpo<{ parada: { global: boolean } }>(await api(get("/api/painel", token))).parada.global, true);
      const r = corpo<{ resultado: { codigo: string; mensagem: string } }>(await api(post("/api/acoes", { opId: opId(), tipo: "liberar" }, token)));
      assert.equal(r.resultado.codigo, "EMERGENCY_STOP");
      assert.match(r.resultado.mensagem, /só pode ser liberada pelo operador/);
    } finally {
      await comoOperador(banco.db, (tx) => motorNaTransacao(tx, { clock, operators: new Set(["op-1"]) }).stop.release({ kind: "global" }, "op-1", "operator"));
    }
  });

  it("tirar uma autorização: some do painel e o agente perde o acesso", async () => {
    const u = usuario("ana");
    const { token } = await cadastrar(u);
    const { g } = await grantEPedidos(u);
    assert.equal(corpo<{ resultado: { ok: boolean } }>(await api(post("/api/acoes", { opId: opId(), tipo: "revogar", autorizacaoId: g.id }, token))).resultado.ok, true);
    const p = corpo<{ autorizacoes: unknown[]; atividade: { texto: string }[] }>(await api(get("/api/painel", token)));
    assert.equal(p.autorizacoes.length, 0);
    assert.match(p.atividade[0]!.texto, /tirou uma autorização/);
  });

  it("ação malformada é recusada antes do banco", async () => {
    const { token } = await cadastrar(usuario("ana"));
    for (const a of [{ tipo: "parar" }, { opId: "curto", tipo: "parar" }, { opId: opId(), tipo: "dar_acesso_total" }, { opId: opId(), tipo: "aprovar", propostaId: "x", hash: "nao-e-hash" }])
      assert.equal((await api(post("/api/acoes", a, token))).status, 400, JSON.stringify(a));
  });
});

describe("isolamento pela sessão", () => {
  it("a sessão da Bia não vê nem decide o que é da Ana, mesmo com o id certo", async () => {
    const ana = usuario("ana");
    const bia = usuario("bia");
    await cadastrar(ana);
    const { token: daBia } = await cadastrar(bia);
    const { alto, g } = await grantEPedidos(ana);
    const p = corpo<{ pedidos: unknown[]; autorizacoes: unknown[]; atividade: unknown[] }>(await api(get("/api/painel", daBia)));
    assert.deepEqual([p.pedidos.length, p.autorizacoes.length, p.atividade.length], [0, 0, 0]);
    const r = corpo<{ resultado: { codigo: string } }>(await api(post("/api/acoes", { opId: opId(), tipo: "aprovar", propostaId: alto.id, hash: alto.payloadHash }, daBia)));
    assert.equal(r.resultado.codigo, "PROPOSAL_NOT_FOUND");
    const rv = corpo<{ resultado: { codigo: string } }>(await api(post("/api/acoes", { opId: opId(), tipo: "revogar", autorizacaoId: g.id }, daBia)));
    assert.equal(rv.resultado.codigo, "GRANT_NOT_FOUND");
    assert.equal((await motorDe(ana, (m) => m.approvals.get(alto.id)))?.status, "pending");
    // O mesmo opId em pessoas diferentes não colide.
    const mesmo = opId();
    for (const t of [daBia, (await cadastrar(usuario("caio"))).token])
      assert.equal(corpo<{ repetida: boolean }>(await api(post("/api/acoes", { opId: mesmo, tipo: "parar" }, t))).repetida, false);
  });
});

describe("servidor HTTP", () => {
  it("arquivo fora de public/ não existe; o app sai com política de conteúdo estrita", async () => {
    for (const c of ["/../package.json", "/%2e%2e/package.json", "/..%2f..%2fpackage.json", "/src/api.ts"]) assert.equal(await arquivoEstatico(c), null, c);
    const srv = servidorHttp(api).listen(0);
    try {
      const porta = (srv.address() as AddressInfo).port;
      const h = await new Promise<Record<string, unknown>>((ok, falha) => request({ port: porta, path: "/api/painel" }, (r) => (r.resume(), ok(r.headers))).on("error", falha).end());
      assert.match(String(h["content-security-policy"]), /script-src 'self'; style-src 'self'/);
      assert.doesNotMatch(String(h["content-security-policy"]), /unsafe/);
      assert.equal(h["x-content-type-options"], "nosniff");
      assert.equal(h["cache-control"], "no-store");
    } finally {
      srv.close();
    }
  });
});

describe("memória e direitos pelo app (Arts. 10 e 13)", () => {
  const acao = (token: string, a: Record<string, unknown>) => api(post("/api/acoes", { opId: opId(), ...a }, token)).then((r) => corpo<{ resultado: { ok: boolean; codigo?: string; mensagem?: string } }>(r).resultado);
  const painel = (token: string) =>
    api(get("/api/painel", token)).then((r) =>
      corpo<{
        aprendizado: { categorias: { id: string; ligada: boolean }[]; licoes: { id: string; texto: string; categoriaNome: string }[] };
        contestacoes: { seq: number; status: string }[];
        atividade: { seq: number; texto: string; contestavel: boolean }[];
        autorizacoes: unknown[];
        pedidos: unknown[];
      }>(r),
    );
  const memoriaDe = <T>(u: string, fn: (mem: ReturnType<typeof memoriaNaTransacao>) => Promise<T>) =>
    comoUsuario(banco.db, u, (tx) => fn(memoriaNaTransacao(tx, motorNaTransacao(tx, { clock }), clock)));

  it("ligar, ver o que foi aprendido, apagar uma lição, desligar", async () => {
    const u = usuario("ana");
    const { token } = await cadastrar(u);
    assert.ok((await painel(token)).aprendizado.categorias.every((c) => !c.ligada), "tudo nasce desligado");
    assert.equal((await acao(token, { tipo: "ligar_aprendizado", categoria: "agenda" })).ok, true);
    await memoriaDe(u, (m) => m.lembrar(u, "obedient", "agenda", "academia às 7h"));
    await memoriaDe(u, (m) => m.lembrar(u, "obedient", "agenda", "almoço às 12h"));
    const p = await painel(token);
    assert.deepEqual(p.aprendizado.licoes.map((l) => l.categoriaNome), ["Rotina e agenda", "Rotina e agenda"]);
    assert.match(p.atividade.map((a) => a.texto).join("\n"), /obedient aprendeu algo sobre rotina e agenda/);
    assert.equal((await acao(token, { tipo: "esquecer", licaoId: p.aprendizado.licoes[0]!.id })).ok, true);
    const de_novo = await acao(token, { tipo: "esquecer", licaoId: p.aprendizado.licoes[0]!.id });
    assert.equal(de_novo.mensagem, "Essa lição já tinha sido apagada.");
    assert.equal((await acao(token, { tipo: "desligar_aprendizado", categoria: "agenda" })).ok, true);
    assert.deepEqual((await painel(token)).aprendizado.licoes, []);
  });

  it("categoria sensível só com consentimento específico; categoria inventada é recusada", async () => {
    const { token } = await cadastrar(usuario("ana"));
    assert.equal((await acao(token, { tipo: "ligar_aprendizado", categoria: "health" })).ok, false);
    assert.equal((await acao(token, { tipo: "ligar_aprendizado", categoria: "health", especifico: true })).ok, true);
    assert.equal((await acao(token, { tipo: "ligar_aprendizado", categoria: "astrologia" })).ok, false);
  });

  it("contestar uma ação do agente; só a própria trilha", async () => {
    const ana = usuario("ana");
    const bia = usuario("bia");
    const { token } = await cadastrar(ana);
    const { token: daBia } = await cadastrar(bia);
    await grantEPedidos(ana);
    const p = await painel(token);
    const alvo = p.atividade.find((a) => a.contestavel)!;
    assert.ok(alvo);
    assert.equal(p.atividade.filter((a) => !a.contestavel).length, 0, "nada aqui é ação da própria pessoa");
    assert.equal((await acao(token, { tipo: "contestar", seq: alvo.seq, motivo: "não reconheço este pedido" })).ok, true);
    assert.deepEqual((await painel(token)).contestacoes.map((c) => [c.seq, c.status]), [[alvo.seq, "aberta"]]);
    // A Bia aponta para o mesmo número de entrada: na trilha dela, a entrada não existe (ou é dela).
    const r = await acao(daBia, { tipo: "contestar", seq: 999, motivo: "x" });
    assert.equal(r.mensagem, "Essa entrada não existe na sua trilha.");
  });

  it("baixar meus dados: um arquivo aberto com tudo, a trilha íntegra, nada de outra pessoa", async () => {
    const ana = usuario("ana");
    const bia = usuario("bia");
    const { token } = await cadastrar(ana);
    await cadastrar(bia);
    await grantEPedidos(ana);
    await grantEPedidos(bia);
    await acao(token, { tipo: "ligar_aprendizado", categoria: "trabalho" });
    await memoriaDe(ana, (m) => m.lembrar(ana, "obedient", "trabalho", "fornecedor é a Taberna Ipê"));
    const r = await api(get("/api/meus-dados", token));
    assert.equal(r.status, 200);
    assert.match(r.headers["content-disposition"] ?? "", /^attachment; filename="obedient-ana-\d+-\d{4}-\d{2}-\d{2}\.json"$/);
    const d = corpo<{ formato: string; usuario: string; trilhaIntegra: boolean; trilha: { userId: string }[]; pedidos: unknown[]; aprendizado: { licoes: { texto: string }[] }; consentimentos: unknown[] }>(r);
    assert.equal(d.formato, "obedient-exportacao/1");
    assert.equal(d.trilhaIntegra, true);
    assert.ok(d.trilha.every((e) => e.userId === ana));
    assert.equal(d.pedidos.length, 2);
    assert.deepEqual(d.aprendizado.licoes.map((l) => l.texto), ["fornecedor é a Taberna Ipê"]);
    assert.doesNotMatch(r.body, new RegExp(bia));
    assert.equal((await api(get("/api/meus-dados"))).status, 401);
  });

  it("apagar tudo: um passo, e o painel e a exportação mostram o resultado", async () => {
    const u = usuario("ana");
    const { token } = await cadastrar(u);
    await grantEPedidos(u);
    await acao(token, { tipo: "ligar_aprendizado", categoria: "preferencias" });
    await memoriaDe(u, (m) => m.lembrar(u, "obedient", "preferencias", "gosta de resumo curto"));
    assert.equal((await acao(token, { tipo: "apagar_tudo" })).ok, true);
    const p = await painel(token);
    assert.deepEqual([p.pedidos.length, p.autorizacoes.length, p.aprendizado.licoes.length], [0, 0, 0]);
    assert.ok(p.aprendizado.categorias.every((c) => !c.ligada));
    assert.match(p.atividade[0]!.texto, /Você apagou o que o OBEDIENT sabia sobre você/);
    const d = corpo<{ trilhaIntegra: boolean; pedidos: { payload: unknown }[] }>(await api(get("/api/meus-dados", token)));
    assert.equal(d.trilhaIntegra, true);
    assert.ok(d.pedidos.every((x) => JSON.stringify(x.payload) === "{}"));
    assert.doesNotMatch(JSON.stringify(d), /resumo curto|Resumo da semana/);
  });
});

describe("missões e identificação pelo app (Arts. 5º, 7º e 9º)", () => {
  const acao = (token: string, a: Record<string, unknown>) => api(post("/api/acoes", { opId: opId(), ...a }, token)).then((r) => corpo<{ resultado: { ok: boolean; codigo?: string; mensagem?: string } }>(r).resultado);
  type M = { id: string; objetivo: string; situacao: string; estado: string; impedimento: string | null; desfecho: { tipo: string; explicacao: string } | null; teto: string };
  const missoesDoPainel = async (token: string) => corpo<{ missoes: M[]; identificacao: string | null; atividade: { texto: string }[] }>(await api(get("/api/painel", token)));
  const processar = (u: string, exec: Parameters<typeof processarMissoes>[2]) => processarMissoes(banco.db, u, exec, {}, clock);

  it("a pessoa pede; o agente diz que não sabe; o painel mostra a explicação", async () => {
    const u = usuario("ana");
    const { token } = await cadastrar(u);
    assert.equal((await acao(token, { tipo: "criar_missao", objetivo: "Descobrir o horário do dentista" })).ok, true);
    let p = await missoesDoPainel(token);
    assert.deepEqual(p.missoes.map((m) => [m.objetivo, m.situacao]), [["Descobrir o horário do dentista", "Trabalhando nisso"]]);
    await processar(u, async () => ({ tipo: "nao_sei", explicacao: "Não achei na agenda nem nos e-mails.", custoCentavos: 3 }));
    p = await missoesDoPainel(token);
    assert.equal(p.missoes[0]!.situacao, "Não soube responder");
    assert.equal(p.missoes[0]!.desfecho?.explicacao, "Não achei na agenda nem nos e-mails.");
    assert.match(p.atividade.map((a) => a.texto).join("\n"), /disse que não sabe responder/);
  });

  it("falhou até o teto: impedimento explicado; a pessoa manda tentar de novo ou cancela", async () => {
    const u = usuario("ana");
    const { token } = await cadastrar(u);
    await acao(token, { tipo: "criar_missao", objetivo: "Confirmar a reserva", tetoCentavos: 100 });
    const falha = async () => ({ tipo: "falha_temporaria" as const, erro: "o site do restaurante não abriu", custoCentavos: 10 });
    for (let i = 0; i < 3; i++) {
      await processar(u, falha);
      clock.advance(10 * 60_000);
    }
    let [m] = (await missoesDoPainel(token)).missoes;
    assert.equal(m!.situacao, "Parou e precisa de você");
    assert.match(m!.impedimento!, /Tentou 3 vez\(es\).*o site do restaurante não abriu/);
    assert.equal((await acao(token, { tipo: "tentar_de_novo", missaoId: m!.id })).ok, true);
    [m] = (await missoesDoPainel(token)).missoes;
    assert.equal(m!.situacao, "Trabalhando nisso");
    assert.equal((await acao(token, { tipo: "cancelar_missao", missaoId: m!.id })).ok, true);
    const outra = await acao(token, { tipo: "cancelar_missao", missaoId: m!.id });
    assert.equal(outra.mensagem, "Essa missão já tinha terminado.");
  });

  it("parar pelo app cancela as missões no mesmo commit", async () => {
    const u = usuario("ana");
    const { token } = await cadastrar(u);
    await acao(token, { tipo: "criar_missao", objetivo: "x" });
    await acao(token, { tipo: "parar" });
    assert.equal((await missoesDoPainel(token)).missoes[0]!.situacao, "Cancelada");
    let chamou = false;
    await processar(u, async () => ((chamou = true), { tipo: "feito", explicacao: "x", custoCentavos: 1 }));
    assert.equal(chamou, false);
  });

  it("cancelada durante a tentativa: o resultado que chega depois não vale", async () => {
    const u = usuario("ana");
    const { token } = await cadastrar(u);
    await acao(token, { tipo: "criar_missao", objetivo: "Mandar o resumo" });
    const [m] = (await missoesDoPainel(token)).missoes;
    await processar(u, async () => {
      // Enquanto o agente trabalha (fora do banco), a pessoa cancela pelo app.
      await acao(token, { tipo: "cancelar_missao", missaoId: m!.id });
      return { tipo: "feito", explicacao: "enviado", custoCentavos: 2 };
    });
    const [depois] = (await missoesDoPainel(token)).missoes;
    assert.deepEqual([depois!.situacao, depois!.desfecho], ["Cancelada", null]);
  });

  it("identificação: a pessoa configura; texto curto demais é recusado", async () => {
    const { token } = await cadastrar(usuario("ana"));
    assert.equal((await missoesDoPainel(token)).identificacao, null);
    assert.equal((await acao(token, { tipo: "identificacao", texto: "ok" })).ok, false);
    assert.equal((await acao(token, { tipo: "identificacao", texto: "Enviada pelo assistente da Ana" })).ok, true);
    assert.equal((await missoesDoPainel(token)).identificacao, "Enviada pelo assistente da Ana");
  });

  it("uma pessoa não cancela a missão de outra", async () => {
    const ana = usuario("ana");
    const bia = usuario("bia");
    const { token } = await cadastrar(ana);
    const { token: daBia } = await cadastrar(bia);
    await acao(token, { tipo: "criar_missao", objetivo: "segredo da Ana" });
    const [m] = (await missoesDoPainel(token)).missoes;
    assert.equal((await acao(daBia, { tipo: "cancelar_missao", missaoId: m!.id })).mensagem, "Essa missão não existe mais.");
    assert.equal((await missoesDoPainel(daBia)).missoes.length, 0);
    assert.equal((await missoesDoPainel(token)).missoes[0]!.situacao, "Trabalhando nisso");
  });
});
