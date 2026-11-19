// SPDX-License-Identifier: AGPL-3.0-only
//
// O executor das missões de ponta a ponta no servidor, com o banco, o Google falso e um modelo
// roteirizado (nada sai para a rede):
//   ler a agenda e concluir; apagar compromisso pede passkey, a missão espera e, aprovada, a MESMA
//   tentativa continua e apaga uma vez; terminar sem desfecho não é "feito"; teto de custo; parar no
//   meio da tentativa; erro passageiro do modelo continua a conversa; o agendador acha a missão.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { ManualClock, payloadHash } from "@obedient/core";
import { PRAZO_RESERVA_MS } from "@obedient/missions";
import { ErroModelo, type PedidoModelo, type RespostaModelo, type ResultadoFerramenta } from "@obedient/agent-orchestrator";
import { Cofre, Conexoes, concederAoConectar, idDeEvento, lerChaves } from "@obedient/integrations";
import { comoUsuario, gravarIdentificacao, missoesNaTransacao, motorNaTransacao, passosNaTransacao } from "@obedient/store-postgres";
import { GoogleFalso } from "../../integrations/src/google-falso.ts";
import { bancoDeTeste, type BancoDeTeste } from "../../store-postgres/src/banco-de-teste.ts";
import { agendarMissoes } from "./agendador.ts";
import { CONCLUIR, CONCLUIR_TAREFA, PROPOR_PLANO, executorDeMissoes, type ModeloComGasto, textoIncerto } from "./executor.ts";
import { processarMissoes } from "./processador.ts";

const T0 = new Date("2026-11-03T12:00:00Z");
const CLIENTE = { clientId: "id", clientSecret: "segredo", redirectUri: "https://obedient.exemplo.test/api/conexoes/retorno" };
let banco: BancoDeTeste;
before(async () => {
  banco = await bancoDeTeste();
});
after(() => banco.fechar());

let n = 0;
const usuario = () => `ana-x${++n}`;

type Passo = (p: PedidoModelo) => RespostaModelo | Promise<RespostaModelo>;
/** Modelo roteirizado: cada chamada consome um passo e "gasta" o valor dado. */
function roteiro(gastoPorChamada: number, ...passos: Passo[]) {
  const pedidos: PedidoModelo[] = [];
  let i = 0;
  const novo = (): ModeloComGasto => {
    const m = {
      gastoEmDolares: 0,
      async responder(p: PedidoModelo) {
        pedidos.push(structuredClone({ ...p, signal: undefined }) as unknown as PedidoModelo);
        const passo = passos[i++];
        if (!passo) throw new Error("o roteiro acabou");
        m.gastoEmDolares += gastoPorChamada;
        return passo(p);
      },
    };
    return m;
  };
  return { novo, pedidos, chamadas: () => i };
}
const resposta = (content: RespostaModelo["content"], stopReason: string): RespostaModelo => ({ content, stopReason, model: "roteiro", usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 } });
const usar = (id: string, name: string, input: Record<string, unknown>) => () => resposta([{ type: "tool_use", id, name, input }], "tool_use");
const concluir = (tipo: string, explicacao: string, id = "fim") => usar(id, CONCLUIR, { tipo, explicacao });
const encerrar = () => resposta([{ type: "text", text: "Pronto." }], "end_turn");
const resultados = (p: PedidoModelo) => p.messages.at(-1)!.content as ResultadoFerramenta[];

function montar() {
  const google = new GoogleFalso(CLIENTE.clientSecret);
  const clock = new ManualClock(T0);
  const conexoes = new Conexoes(banco.db, new Cofre(lerChaves(`k1:${Cofre.novaChave()}`)), CLIENTE, google.fetch as typeof fetch, clock);
  const motor = <T>(u: string, fn: (m: ReturnType<typeof motorNaTransacao>) => Promise<T>) => comoUsuario(banco.db, u, (tx) => fn(motorNaTransacao(tx, { clock, exigirIdentificacao: true })));
  const missoes = <T>(u: string, fn: (ms: ReturnType<typeof missoesNaTransacao>) => Promise<T>) => comoUsuario(banco.db, u, (tx) => fn(missoesNaTransacao(tx, motorNaTransacao(tx, { clock }), clock)));
  const conectar = async (u: string, id: string) => {
    const { url, nonce } = await conexoes.iniciar(u, id);
    const { state, code } = google.autorizar(url);
    await conexoes.concluir(state, code, nonce);
    await motor(u, (m) => concederAoConectar(m, u, id, clock.now()));
  };
  const executor = (r: ReturnType<typeof roteiro>) =>
    executorDeMissoes({ db: banco.db, conexoes, novoModelo: r.novo, centavosPorDolar: 600, clock, http: google.fetch as typeof fetch });
  const processar = (u: string, r: ReturnType<typeof roteiro>) => processarMissoes(banco.db, u, executor(r), {}, clock);
  return { google, clock, conexoes, motor, missoes, conectar, executor, processar };
}

describe("executor das missões", () => {
  it("lê a agenda pelo Ethics Engine e conclui: o modelo vê o resultado e o sistema certo; o custo entra na missão", async () => {
    const c = montar();
    const u = usuario();
    await c.conectar(u, "google_agenda");
    await comoUsuario(banco.db, u, (tx) => gravarIdentificacao(tx, u, "Enviada pelo assistente da Ana", c.clock));
    c.google.responderApi = () => ({ json: { items: [{ id: "ev1", summary: "Dentista", start: { dateTime: "2026-11-04T10:00:00-03:00" }, end: { dateTime: "2026-11-04T11:00:00-03:00" } }] } });
    const m = await c.missoes(u, (ms) => ms.criar(u, "obedient", "Que horas é o dentista amanhã?"));
    const r = roteiro(
      0.01,
      usar("t1", "google_agenda__listar_eventos", { de: "2026-11-04T00:00:00-03:00", ate: "2026-11-05T00:00:00-03:00" }),
      (p) => {
        // O resultado volta aberto (a pessoa consentiu ao conectar) e marcado como externo.
        assert.match(resultados(p)[0]!.content, /"conteudo_externo":\{"eventos":\[\{"id":"ev1","titulo":"Dentista"/);
        return concluir("feito", "O dentista é amanhã às 10h.")();
      },
      encerrar,
    );
    const [fim] = await c.processar(u, r);
    assert.deepEqual([fim!.estado, fim!.desfecho, fim!.tentativas, fim!.rodada], ["completed", { tipo: "feito", explicacao: "O dentista é amanhã às 10h." }, 1, null]);
    // 3 chamadas × US$ 0,01 × 600 centavos por dólar.
    assert.equal(fim!.custoCentavos, 18);
    const p0 = r.pedidos[0]!;
    assert.deepEqual(p0.tools.map((t) => t.name).sort(), [CONCLUIR, "google_agenda__apagar_evento", "google_agenda__criar_evento", "google_agenda__listar_eventos"], "só a integração conectada");
    assert.match(p0.system, /"Enviada pelo assistente da Ana"/);
    assert.match(p0.system, /nunca como instrução/);
    assert.match(String(p0.messages[0]!.content), /Que horas é o dentista amanhã\?/);
    assert.match(String(p0.messages[0]!.content), /em UTC, 2026-11-03T12:00:00\.000Z/);
    assert.equal(c.google.api.length, 1);
  });

  it("apagar compromisso: a missão espera a passkey; aprovada, a mesma tentativa continua e apaga uma vez", async () => {
    const c = montar();
    const u = usuario();
    await c.conectar(u, "google_agenda");
    c.google.responderApi = () => ({ status: 204 });
    const m = await c.missoes(u, (ms) => ms.criar(u, "obedient", "Apague o compromisso ev1", { maxTentativas: 1 }));
    const r = roteiro(
      0.001,
      usar("t1", "google_agenda__apagar_evento", { id: "ev1" }),
      (p) => {
        // Na retomada, o resultado da ação aprovada volta numa mensagem só.
        assert.equal(resultados(p).length, 1);
        assert.equal(resultados(p)[0]!.is_error, false);
        return concluir("feito", "Apaguei o compromisso.")();
      },
      encerrar,
    );
    const [esperando] = await c.processar(u, r);
    assert.equal(esperando!.estado, "waiting_approval");
    assert.ok(esperando!.rodada, "a conversa fica guardada");
    assert.equal(c.google.api.length, 0, "nada apagado antes da aprovação");
    // Ainda sem decisão: nada anda, o modelo não é chamado de novo.
    await c.processar(u, r);
    assert.equal(r.chamadas(), 1);

    const p = await c.motor(u, (mt) => mt.approvals.get(esperando!.propostaId!));
    await c.motor(u, (mt) => mt.approve(p!.id, { id: u, kind: "user", strongAuth: true }, p!.payloadHash));
    const [fim] = await c.processar(u, r);
    assert.deepEqual([fim!.estado, fim!.tentativas, fim!.desfecho?.tipo], ["completed", 1, "feito"], "uma tentativa só, mesmo com o teto de 1");
    assert.equal(c.google.api.filter((x) => x.metodo === "DELETE").length, 1);
    assert.equal((await c.motor(u, (mt) => mt.approvals.get(p!.id)))?.status, "executed");
    assert.equal(m.id, fim!.id);
  });

  it("dois pedidos na mesma volta: só continua quando a pessoa decidiu os dois", async () => {
    const c = montar();
    const u = usuario();
    await c.conectar(u, "google_agenda");
    c.google.responderApi = () => ({ status: 204 });
    await c.missoes(u, (ms) => ms.criar(u, "obedient", "Apague ev1 e ev2"));
    const r = roteiro(
      0,
      () => resposta([{ type: "tool_use", id: "a", name: "google_agenda__apagar_evento", input: { id: "ev1" } }, { type: "tool_use", id: "b", name: "google_agenda__apagar_evento", input: { id: "ev2" } }], "tool_use"),
      (p) => {
        assert.deepEqual(resultados(p).map((x) => [x.tool_use_id, x.is_error]), [["a", false], ["b", false]]);
        return concluir("feito", "Apaguei os dois.")();
      },
      encerrar,
    );
    const [esperando] = await c.processar(u, r);
    const pedidos = await c.motor(u, (mt) => mt.approvals.pending(u));
    assert.equal(pedidos.length, 2);
    const aprovar = (id: string) => c.motor(u, async (mt) => mt.approve(id, { id: u, kind: "user", strongAuth: true }, (await mt.approvals.get(id))!.payloadHash));
    // Aprova justamente o pedido que a missão espera; o outro continua pendente.
    const outro = pedidos.find((p) => p.id !== esperando!.propostaId)!;
    await aprovar(esperando!.propostaId!);
    const [meio] = await c.processar(u, r);
    assert.equal(meio!.estado, "waiting_approval", "o segundo ainda espera: não é tratado como recusado");
    assert.equal(r.chamadas(), 1);
    assert.equal(meio!.propostaId, outro.id, "agora espera o outro");
    await aprovar(outro.id);
    const [fim] = await c.processar(u, r);
    assert.deepEqual([fim!.estado, fim!.tentativas], ["completed", 1]);
    assert.equal(c.google.api.filter((x) => x.metodo === "DELETE").length, 2);
  });

  it("terminar sem dizer o desfecho não é 'feito': a próxima tentativa continua e pede o desfecho", async () => {
    const c = montar();
    const u = usuario();
    const m = await c.missoes(u, (ms) => ms.criar(u, "obedient", "Me diga um nome para o gato"));
    const r = roteiro(
      0,
      () => resposta([{ type: "text", text: "Que tal Bartolomeu?" }], "end_turn"),
      (p) => {
        assert.match(String(p.messages.at(-1)!.content), new RegExp(`sem chamar ${CONCLUIR}`));
        assert.equal(p.messages.length, 3, "continua a mesma conversa");
        return concluir("feito", "Sugeri Bartolomeu.")();
      },
      encerrar,
    );
    const [primeira] = await c.processar(u, r);
    assert.deepEqual([primeira!.estado, primeira!.desfecho], ["retrying", null]);
    assert.ok(primeira!.proximaTentativaEm);
    c.clock.advance(30_000);
    const [fim] = await c.processar(u, r);
    assert.deepEqual([fim!.estado, fim!.tentativas, fim!.desfecho?.explicacao], ["completed", 2, "Sugeri Bartolomeu."]);
    assert.equal(m.id, fim!.id);
    // Sem integração, o agente só tem a ferramenta de concluir.
    assert.deepEqual(r.pedidos[0]!.tools.map((t) => t.name), [CONCLUIR]);
  });

  it("teto de custo: a tentativa para antes da próxima chamada ao modelo, e a missão para explicando", async () => {
    const c = montar();
    const u = usuario();
    await c.conectar(u, "google_agenda");
    c.google.responderApi = () => ({ json: { items: [] } });
    // Teto de R$ 0,50; cada chamada custa US$ 0,10 = 60 centavos.
    const m = await c.missoes(u, (ms) => ms.criar(u, "obedient", "Ver a agenda", { tetoCustoCentavos: 50 }));
    const r = roteiro(0.1, usar("t1", "google_agenda__listar_eventos", { de: "2026-11-04T00:00:00Z", ate: "2026-11-05T00:00:00Z" }), concluir("feito", "x"));
    const [fim] = await c.processar(u, r);
    assert.equal(r.chamadas(), 1, "não chama o modelo de novo depois do teto");
    assert.deepEqual([fim!.estado, fim!.custoCentavos, fim!.rodada], ["blocked", 60, null]);
    assert.match(fim!.impedimento!, /teto de custo/);
    assert.equal(m.id, fim!.id);
  });

  it("parar no meio da tentativa: nada mais é chamado e o resultado é descartado", async () => {
    const c = montar();
    const u = usuario();
    await c.conectar(u, "google_agenda");
    const m = await c.missoes(u, (ms) => ms.criar(u, "obedient", "Ver a agenda"));
    const r = roteiro(0, async () => {
      // A pessoa aperta parar enquanto o modelo pensa (como o servidor: com as missões montadas na transação).
      await comoUsuario(banco.db, u, (tx) => {
        const mt = motorNaTransacao(tx, { clock: c.clock });
        missoesNaTransacao(tx, mt, c.clock);
        return mt.stop.engage({ kind: "user", userId: u }, u, "parar");
      });
      return usar("t1", "google_agenda__listar_eventos", { de: "2026-11-04T00:00:00Z", ate: "2026-11-05T00:00:00Z" })();
    }, concluir("feito", "x"));
    const [fim] = await c.processar(u, r);
    assert.equal(fim!.estado, "cancelled");
    assert.equal(c.google.api.length, 0, "com a parada, a ferramenta é negada");
    assert.equal(r.chamadas(), 1);
    assert.equal(m.id, fim!.id);
  });

  it("erro passageiro do modelo: a tentativa conta, e a próxima continua a conversa de onde parou", async () => {
    const c = montar();
    const u = usuario();
    await c.conectar(u, "google_agenda");
    c.google.responderApi = () => ({ json: { items: [] } });
    const m = await c.missoes(u, (ms) => ms.criar(u, "obedient", "Ver a agenda"));
    const r = roteiro(
      0,
      usar("t1", "google_agenda__listar_eventos", { de: "2026-11-04T00:00:00Z", ate: "2026-11-05T00:00:00Z" }),
      () => {
        throw new ErroModelo("indisponivel", "o provedor do modelo está indisponível (529)", true);
      },
      (p) => {
        assert.equal(resultados(p)[0]!.tool_use_id, "t1", "a conversa guardada volta inteira");
        return concluir("nao_sei", "Não achei nada na agenda.")();
      },
      encerrar,
    );
    const [primeira] = await c.processar(u, r);
    assert.equal(primeira!.estado, "retrying");
    c.clock.advance(30_000);
    const [fim] = await c.processar(u, r);
    assert.deepEqual([fim!.estado, fim!.desfecho?.tipo, fim!.tentativas], ["completed", "nao_sei", 2]);
    assert.equal(c.google.api.length, 1, "a ferramenta não roda de novo");
    assert.equal(m.id, fim!.id);
  });

  it("o agendador acha quem tem missão devida e processa com o executor", async () => {
    const c = montar();
    const u = usuario();
    await c.missoes(u, (ms) => ms.criar(u, "obedient", "Me diga um nome para o cachorro"));
    const r = roteiro(0, concluir("feito", "Sugeri Dante."), encerrar);
    const eventos: Record<string, unknown>[] = [];
    const ag = agendarMissoes({ db: banco.db, executar: c.executor(r), clock: c.clock, intervaloMs: 60_000, log: (e) => eventos.push(e) });
    try {
      assert.ok((await ag.volta()) >= 1);
    } finally {
      ag.parar();
    }
    const [m] = await c.missoes(u, (ms) => ms.listar(u));
    assert.equal(m!.estado, "completed");
    // O log diz o que aconteceu, nunca o conteúdo da missão.
    assert.doesNotMatch(JSON.stringify(eventos), /cachorro|Dante/);
  });
});

describe("executor das missões: reinício do processo e aprovações", () => {
  const aprovar = (c: ReturnType<typeof montar>, u: string, id: string) => c.motor(u, async (mt) => mt.approve(id, { id: u, kind: "user", strongAuth: true }, (await mt.approvals.get(id))!.payloadHash));
  const apagar = usar("t1", "google_agenda__apagar_evento", { id: "ev1" });
  const deletes = (c: ReturnType<typeof montar>) => c.google.api.filter((x) => x.metodo === "DELETE").length;

  it("pedido pendente sobrevive ao reinício: aprovado depois, um executor NOVO continua a conversa e apaga uma vez", async () => {
    const c = montar();
    const u = usuario();
    await c.conectar(u, "google_agenda");
    c.google.responderApi = () => ({ status: 204 });
    await c.missoes(u, (ms) => ms.criar(u, "obedient", "Apague o compromisso ev1", { maxTentativas: 1 }));
    const antes = roteiro(0, apagar);
    const [esperando] = await c.processar(u, antes);
    assert.equal(esperando!.estado, "waiting_approval");
    // "Reinício": nada do executor, do modelo nem do roteiro anterior é reaproveitado.
    const depois = roteiro(
      0,
      (p) => {
        assert.equal(p.messages[0]!.role, "user");
        assert.match(String(p.messages[0]!.content), /Apague o compromisso ev1/, "a conversa veio do banco");
        assert.equal(resultados(p)[0]!.tool_use_id, "t1");
        assert.equal(resultados(p)[0]!.is_error, false);
        return concluir("feito", "Apaguei.")();
      },
      encerrar,
    );
    await aprovar(c, u, esperando!.propostaId!);
    const [fim] = await c.processar(u, depois);
    assert.deepEqual([fim!.estado, fim!.tentativas, deletes(c)], ["completed", 1, 1]);
    assert.equal(antes.chamadas(), 1);
  });

  it("o processo cai no meio da ação aprovada: depois do prazo a missão para pedindo conferência, e a ação NÃO roda de novo", async () => {
    const c = montar();
    const u = usuario();
    await c.conectar(u, "google_agenda");
    c.google.responderApi = () => ({ status: 204 });
    await c.missoes(u, (ms) => ms.criar(u, "obedient", "Apague o compromisso ev1", { maxTentativas: 2 }));
    const [esperando] = await c.processar(u, roteiro(0, apagar));
    await aprovar(c, u, esperando!.propostaId!);

    // O DELETE chega ao Google e a resposta nunca volta: o processo "morre" com a chamada no ar.
    let chegou!: () => void;
    const chegouAoGoogle = new Promise<void>((ok) => (chegou = ok));
    const travado = (async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        c.google.api.push({ metodo: "DELETE", url: String(url), auth: null, corpo: "" });
        chegou();
        return new Promise<Response>(() => {});
      }
      return c.google.fetch(url, init);
    }) as typeof fetch;
    const morto = roteiro(0);
    void processarMissoes(banco.db, u, executorDeMissoes({ db: banco.db, conexoes: c.conexoes, novoModelo: morto.novo, centavosPorDolar: 600, clock: c.clock, http: travado }), {}, c.clock);
    await chegouAoGoogle;
    assert.equal(deletes(c), 1);
    const p = await c.motor(u, (mt) => mt.approvals.get(esperando!.propostaId!));
    assert.equal(p!.status, "executing");

    // Processo novo. Desde o registro de passos (M1), a chamada que ficou sem fim é vista antes de
    // qualquer chamada ao modelo: apagar tem efeito, então a missão para e pede conferência.
    const novo = roteiro(0);
    assert.deepEqual(await c.processar(u, novo), [], "dentro do prazo, ninguém retoma por cima");
    c.clock.advance(PRAZO_RESERVA_MS);
    const [fim] = await c.processar(u, novo);
    assert.deepEqual([fim!.estado, fim!.tentativas], ["blocked", 2]);
    const passos = await comoUsuario(banco.db, u, (tx) => passosNaTransacao(tx).daMissao(fim!.id));
    const incerto = passos.find((x) => x.tipo === "incerto")!;
    assert.match(incerto.ferramenta ?? "", /apagar_evento$/);
    assert.equal(fim!.impedimento, textoIncerto([incerto.ferramenta!]));
    assert.equal(novo.chamadas(), 0, "o modelo nem é chamado");
    assert.equal(deletes(c), 1, "a ação aprovada não foi repetida");
    assert.equal((await c.motor(u, (mt) => mt.approvals.get(p!.id)))?.status, "executing", "fica para reconciliação");
    const trilha = await c.motor(u, (mt) => mt.audit.forUser(u));
    assert.ok(trilha.some((e) => e.event === "mission.attempt_interrupted"));
    assert.ok(trilha.some((e) => e.event === "mission.blocked"));
    assert.deepEqual([incerto.tentativa, incerto.decisao, incerto.categoria, incerto.aprovacaoId], [2, "conferir_com_a_pessoa", "DESTRUCTIVE", p!.id]);
    assert.deepEqual(await comoUsuario(banco.db, u, (tx) => passosNaTransacao(tx).abertos(fim!.id)), [], "o início ficou fechado como incerto");
  });

  it("aprovado, mas vencido, com grant revogado ou com consentimento revogado antes da execução: não apaga", async () => {
    const casos: [string, (c: ReturnType<typeof montar>, u: string) => Promise<unknown>][] = [
      ["vencido", async (c) => c.clock.advance(31 * 60_000)],
      ["grant revogado", (c, u) => c.motor(u, async (mt) => { for (const g of await mt.grants.list(u)) if (!g.revokedAt) await mt.grants.revoke(g.id, u); })],
      ["consentimento revogado", (c, u) => c.motor(u, (mt) => mt.consent.revokePurpose(u, "integracao:google_agenda"))],
      // M4: o grant continua, mas mais estreito (risco máximo MEDIUM); apagar é HIGH.
      ["grant estreitado", (c, u) => c.motor(u, async (mt) => {
        for (const g of await mt.grants.list(u)) {
          if (g.revokedAt) continue;
          await mt.grants.revoke(g.id, u);
          await mt.grants.grant({ userId: u, agentId: g.agentId, systemId: g.systemId, capability: g.capability, purpose: g.purpose, expiresAt: g.expiresAt, limits: { ...g.limits, maxRisk: "MEDIUM", autonomousUpTo: "LOW" } }, u);
        }
      })],
    ];
    for (const [nome, depoisDeAprovar] of casos) {
      const c = montar();
      const u = usuario();
      await c.conectar(u, "google_agenda");
      c.google.responderApi = () => ({ status: 204 });
      await c.missoes(u, (ms) => ms.criar(u, "obedient", "Apague o compromisso ev1", { maxTentativas: 2 }));
      const [esperando] = await c.processar(u, roteiro(0, apagar));
      await aprovar(c, u, esperando!.propostaId!);
      await depoisDeAprovar(c, u);
      const r = roteiro(
        0,
        (p) => {
          assert.equal(resultados(p)[0]!.is_error, true, nome);
          return concluir("nao_consegui", "Não pude apagar.")();
        },
        encerrar,
      );
      const [fim] = await c.processar(u, r);
      assert.equal(deletes(c), 0, nome);
      assert.ok(["blocked", "completed", "failed"].includes(fim!.estado), `${nome}: ${fim!.estado}`);
      if (nome === "vencido") assert.match(fim!.impedimento!, /venceu/);
      else assert.equal((await c.motor(u, (mt) => mt.approvals.get(esperando!.propostaId!)))?.status, "approved", `${nome}: não reivindicada`);
    }
  });

  it("e-mail aprovado, mas a pessoa trocou a identificação antes da execução: não sai (Art. 5º)", async () => {
    const c = montar();
    const u = usuario();
    await c.conectar(u, "google_gmail");
    await comoUsuario(banco.db, u, (tx) => gravarIdentificacao(tx, u, "Enviada pelo assistente da Ana", c.clock));
    await c.missoes(u, (ms) => ms.criar(u, "obedient", "Mande o resumo para x@exemplo.test", { maxTentativas: 2 }));
    const [esperando] = await c.processar(u, roteiro(0, usar("t1", "google_gmail__enviar_mensagem", { para: "x@exemplo.test", assunto: "Resumo", texto: "Segue.", identificacao: "Enviada pelo assistente da Ana" })));
    assert.equal(esperando!.estado, "waiting_approval");
    await aprovar(c, u, esperando!.propostaId!);
    await comoUsuario(banco.db, u, (tx) => gravarIdentificacao(tx, u, "Assistente pessoal da Ana", c.clock));
    const r = roteiro(
      0,
      (p) => {
        assert.equal(resultados(p)[0]!.is_error, true);
        assert.match(resultados(p)[0]!.content, /IDENTIFICATION_REQUIRED/);
        return concluir("nao_consegui", "A assinatura mudou; peça de novo.")();
      },
      encerrar,
    );
    await c.processar(u, r);
    assert.equal(c.google.api.filter((x) => x.metodo === "POST").length, 0, "nenhum e-mail enviado");
  });
});

describe("executor das missões: registro de passos (D20, M1)", () => {
  const lerAgenda = usar("t1", "google_agenda__listar_eventos", { de: "2026-11-04T00:00:00-03:00", ate: "2026-11-05T00:00:00-03:00" });
  const passos = (u: string, id: string) => comoUsuario(banco.db, u, (tx) => passosNaTransacao(tx).daMissao(id));

  it("o que fica gravado é a sequência de passos da rodada, com início antes de cada chamada governada e nenhum argumento", async () => {
    const c = montar();
    const u = usuario();
    await c.conectar(u, "google_agenda");
    c.google.responderApi = () => ({ json: { items: [] } });
    const m = await c.missoes(u, (ms) => ms.criar(u, "obedient", "O que tenho amanhã?"));
    const [fim] = await c.processar(u, roteiro(0, lerAgenda, concluir("feito", "Nada amanhã."), encerrar));
    assert.equal(fim!.estado, "completed");
    const ps = await passos(u, m.id);
    const listar = ps[1]!.ferramenta!;
    assert.match(listar, /listar_eventos$/);
    assert.deepEqual(
      ps.map((p) => [p.tentativa, p.seq, p.tipo, p.status, p.decisao, p.ferramenta, p.categoria, p.fecha, p.tokensEntrada, p.tokensSaida]),
      [
        [1, 1, "modelo", "ok", "tool_use", listar, null, null, 100, 20],
        [1, 2, "inicio", "chamando", null, listar, "READ", null, null, null],
        [1, 3, "ferramenta", "succeeded", "chamar_ferramenta", listar, null, { tentativa: 1, seq: 2 }, null, null],
        [1, 4, "modelo", "ok", "tool_use", "obedient/concluir_missao", null, null, 100, 20],
        [1, 5, "ferramenta", "succeeded", "chamar_ferramenta", "obedient/concluir_missao", null, null, null, null],
        [1, 6, "modelo", "ok", "end_turn", null, null, null, 100, 20],
      ],
    );
    assert.equal(ps[1]!.chave, `${m.id}:1:2`, "chave de idempotência do passo");
    const args = { de: "2026-11-04T00:00:00-03:00", ate: "2026-11-05T00:00:00-03:00" };
    assert.equal(ps[1]!.hashArgumentos, payloadHash({ ferramenta: listar, argumentos: args }));
    assert.equal(ps[2]!.hashArgumentos, ps[1]!.hashArgumentos, "início e fim falam da mesma chamada");
    assert.ok(!JSON.stringify(ps).includes("2026-11-04T00"), "os argumentos em si não são gravados");
    assert.deepEqual(await comoUsuario(banco.db, u, (tx) => passosNaTransacao(tx).abertos(m.id)), []);
  });

  it("o processo cai no meio de uma LEITURA: a próxima tentativa fecha o início como incerto e segue", async () => {
    const c = montar();
    const u = usuario();
    await c.conectar(u, "google_agenda");
    await c.missoes(u, (ms) => ms.criar(u, "obedient", "O que tenho amanhã?", { maxTentativas: 2 }));
    let gets = 0;
    let chegou!: () => void;
    const chegouAoGoogle = new Promise<void>((ok) => (chegou = ok));
    const travado = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("/calendar/") && (init?.method ?? "GET") === "GET") {
        gets++;
        chegou();
        return new Promise<Response>(() => {});
      }
      return c.google.fetch(url, init);
    }) as typeof fetch;
    void processarMissoes(banco.db, u, executorDeMissoes({ db: banco.db, conexoes: c.conexoes, novoModelo: roteiro(0, lerAgenda).novo, centavosPorDolar: 600, clock: c.clock, http: travado }), {}, c.clock);
    await chegouAoGoogle;
    assert.equal(gets, 1);

    c.google.responderApi = () => ({ json: { items: [] } });
    c.clock.advance(PRAZO_RESERVA_MS);
    const novo = roteiro(0, lerAgenda, concluir("feito", "Nada amanhã."), encerrar);
    const [fim] = await c.processar(u, novo);
    assert.deepEqual([fim!.estado, fim!.tentativas], ["completed", 2], "leitura não para a missão");
    const ps = await passos(u, fim!.id);
    const incerto = ps.find((p) => p.tipo === "incerto")!;
    assert.deepEqual([incerto.tentativa, incerto.decisao, incerto.categoria, incerto.fecha], [2, "leitura_segue", "READ", { tentativa: 1, seq: 2 }]);
    assert.deepEqual(await comoUsuario(banco.db, u, (tx) => passosNaTransacao(tx).abertos(fim!.id)), []);
  });

  it("pedido de aprovação e retomada na mesma tentativa: cada chamada tem a própria chave, e nada fica aberto", async () => {
    const c = montar();
    const u = usuario();
    await c.conectar(u, "google_agenda");
    c.google.responderApi = () => ({ status: 204 });
    const m = await c.missoes(u, (ms) => ms.criar(u, "obedient", "Apague o compromisso ev1", { maxTentativas: 1 }));
    const r = roteiro(0, usar("t1", "google_agenda__apagar_evento", { id: "ev1" }), concluir("feito", "Apaguei."), encerrar);
    const [esperando] = await c.processar(u, r);
    const p = await c.motor(u, (mt) => mt.approvals.get(esperando!.propostaId!));
    await c.motor(u, (mt) => mt.approve(p!.id, { id: u, kind: "user", strongAuth: true }, p!.payloadHash));
    const [fim] = await c.processar(u, r);
    assert.equal(fim!.estado, "completed");
    const ps = await passos(u, m.id);
    const inicios = ps.filter((x) => x.tipo === "inicio");
    assert.equal(inicios.length, 2, "o pedido e a execução aprovada");
    assert.deepEqual(inicios.map((x) => x.aprovacaoId), [null, p!.id]);
    assert.equal(new Set(inicios.map((x) => x.chave)).size, 2);
    assert.ok(inicios.every((x) => x.tentativa === 1));
    const fechos = ps.filter((x) => x.fecha).map((x) => [x.tipo, x.status, x.fecha!.seq]);
    assert.deepEqual(fechos, [["ferramenta", "approval_required", inicios[0]!.seq], ["retomada", "succeeded", inicios[1]!.seq]]);
    assert.deepEqual(await comoUsuario(banco.db, u, (tx) => passosNaTransacao(tx).abertos(m.id)), []);
  });
});

describe("executor das missões: verificação ao concluir (D20, M3)", () => {
  const lerAgenda = usar("t1", "google_agenda__listar_eventos", { de: "2026-11-04T00:00:00-03:00", ate: "2026-11-05T00:00:00-03:00" });
  const evidencias = (u: string, id: string) => c0.missoes(u, (ms) => ms.evidencias(id));
  let c0: ReturnType<typeof montar>;

  it("'feito' sem a prova pedida volta ao agente com o que falta; ele corrige e a missão termina verificada", async () => {
    const c = (c0 = montar());
    const u = usuario();
    await c.conectar(u, "google_agenda");
    c.google.responderApi = () => ({ json: { items: [] } });
    const m = await c.missoes(u, (ms) => ms.criar(u, "obedient", "Confira minha agenda de amanhã", { criterios: [{ tipo: "ferramenta_ok", ferramenta: "google_agenda/*" }] }));
    const r = roteiro(
      0,
      concluir("feito", "Conferi.", "f1"),
      (p) => {
        const res = resultados(p)[0]!;
        assert.equal(res.is_error, true);
        assert.match(res.content, /"verificado":false/);
        assert.match(res.content, /google_agenda\/\* rodou com sucesso 0 vez/);
        return lerAgenda();
      },
      concluir("feito", "Conferi: nada amanhã.", "f2"),
      encerrar,
    );
    const [fim] = await c.processar(u, r);
    assert.deepEqual([fim!.estado, fim!.desfecho?.tipo], ["completed", "feito"]);
    const ev = await evidencias(u, m.id);
    assert.deepEqual(ev.map((e) => [e.tipo, e.ok]), [["ferramenta_ok", true]]);
    assert.match(ev[0]!.referencia ?? "", /^1:\d+$/, "aponta o passo do registro");
    const trilha = await c.motor(u, (mt) => mt.audit.forUser(u));
    assert.ok(trilha.some((e) => e.event === "mission.verifying" && e.correlationId === m.id));
  });

  it("insistir em 'feito' sem prova: depois de 2 voltas de correção, a missão para (verifying → blocked) com as evidências gravadas", async () => {
    const c = (c0 = montar());
    const u = usuario();
    await c.conectar(u, "google_agenda");
    const m = await c.missoes(u, (ms) => ms.criar(u, "obedient", "Confira minha agenda", { criterios: [{ tipo: "ferramenta_ok", ferramenta: "google_agenda/*" }] }));
    const r = roteiro(
      0,
      concluir("feito", "Conferi.", "f1"),
      concluir("feito", "Conferi mesmo.", "f2"),
      concluir("feito", "Já conferi.", "f3"),
      (p) => {
        assert.match(resultados(p)[0]!.content, /a pessoa vai conferir/);
        return encerrar();
      },
    );
    const [fim] = await c.processar(u, r);
    assert.deepEqual([fim!.estado, fim!.desfecho, fim!.tentativas], ["blocked", null, 1]);
    assert.match(fim!.impedimento ?? "", /^O agente disse que terminou, mas a verificação não confere/);
    assert.deepEqual((await evidencias(u, m.id)).map((e) => [e.tipo, e.ok]), [["ferramenta_ok", false]]);
    assert.equal(c.google.api.length, 0);
  });

  it("resultado_conforme: o resultado entregue segue o esquema; a evidência guarda o hash, nunca o conteúdo", async () => {
    const c = (c0 = montar());
    const u = usuario();
    const esquema = { type: "object", required: ["horario"], properties: { horario: { type: "string", maxLength: 5 } }, additionalProperties: false };
    const m = await c.missoes(u, (ms) => ms.criar(u, "obedient", "Que horas é o dentista?", { criterios: [{ tipo: "resultado_conforme", esquema }] }));
    const r = roteiro(0, usar("f1", CONCLUIR, { tipo: "feito", explicacao: "Às 10h.", resultado: { horario: "10:00" } }), encerrar);
    const [fim] = await c.processar(u, r);
    assert.equal(fim!.estado, "completed");
    const ev = await evidencias(u, m.id);
    assert.deepEqual(ev.map((e) => [e.tipo, e.ok, e.referencia]), [["resultado_conforme", true, `sha256:${payloadHash({ horario: "10:00" })}`]]);
    const linhas = await comoUsuario(banco.db, u, (tx) => tx.query("select * from obedient.mission_evidence where mission_id = $1", [m.id]));
    assert.ok(!JSON.stringify(linhas.rows).includes("10:00"));
  });

  it("sem critério: termina, e a evidência diz que só o registro de passos foi conferido", async () => {
    const c = (c0 = montar());
    const u = usuario();
    const m = await c.missoes(u, (ms) => ms.criar(u, "obedient", "Diga oi"));
    const [fim] = await c.processar(u, roteiro(0, concluir("feito", "Oi!"), encerrar));
    assert.equal(fim!.estado, "completed");
    assert.deepEqual((await evidencias(u, m.id)).map((e) => [e.tipo, e.ok, e.detalhe]), [["sem_criterio", true, "Nenhum critério definido: conferido só o registro de passos (0 chamada(s) com sucesso)."]]);
  });
});

describe("executor das missões: mandato, prazo, teto do mês e tempo por chamada (D20, M4)", () => {
  const lerAgenda = usar("t1", "google_agenda__listar_eventos", { de: "2026-11-04T00:00:00-03:00", ate: "2026-11-05T00:00:00-03:00" });

  it("mandato: a missão só enxerga as ferramentas listadas; o resto nem é oferecido ao agente", async () => {
    const c = montar();
    const u = usuario();
    await c.conectar(u, "google_agenda");
    c.google.responderApi = () => ({ json: { items: [] } });
    await c.missoes(u, (ms) => ms.criar(u, "obedient", "O que tenho amanhã?", { mandato: { ferramentas: ["google_agenda/google_agenda.listar_eventos"] } }));
    const r = roteiro(0, lerAgenda, concluir("feito", "Nada."), encerrar);
    const [fim] = await c.processar(u, r);
    assert.equal(fim!.estado, "completed");
    assert.deepEqual(r.pedidos[0]!.tools.map((t) => t.name).sort(), [CONCLUIR, "google_agenda__listar_eventos"], "criar e apagar ficaram de fora");
  });

  it("mandato com ambientes (M5): só homologação esconde as ferramentas de produção (o Google)", async () => {
    const c = montar();
    const u = usuario();
    await c.conectar(u, "google_agenda");
    await c.missoes(u, (ms) => ms.criar(u, "obedient", "O que tenho amanhã?", { mandato: { ambientes: ["homologacao"] } }));
    const r = roteiro(0, concluir("nao_consegui", "Não tenho como ver a agenda nesta missão."), encerrar);
    await c.processar(u, r);
    assert.deepEqual(r.pedidos[0]!.tools.map((t) => t.name), [CONCLUIR]);
  });

  it("mandato inválido não cria missão: curinga, prefixo curto, prazo no passado ou longe demais", async () => {
    const c = montar();
    const u = usuario();
    for (const mandato of [{ ferramentas: ["*"] }, { ferramentas: ["go*"] }, { ferramentas: [] }, { prazoFinalEm: new Date(T0.getTime() - 1) }, { prazoFinalEm: new Date(T0.getTime() + 31 * 24 * 3_600_000) }])
      await assert.rejects(c.missoes(u, (ms) => ms.criar(u, "obedient", "x", { mandato })), /mandato inválido/, JSON.stringify(mandato));
  });

  it("prazo final vencido: a missão termina como 'não conseguiu' sem chamar o modelo", async () => {
    const c = montar();
    const u = usuario();
    await c.missoes(u, (ms) => ms.criar(u, "obedient", "Lembrar do aniversário", { mandato: { prazoFinalEm: new Date(T0.getTime() + 60_000) } }));
    c.clock.advance(61_000);
    const r = roteiro(0);
    const [fim] = await c.processar(u, r);
    assert.deepEqual([fim!.estado, fim!.desfecho?.tipo], ["failed", "nao_consegui"]);
    assert.match(fim!.desfecho!.explicacao, /Passou do prazo final/);
    assert.equal(r.chamadas(), 0);
  });

  it("teto do mês (D21): com R$ 300 gastos no mês, nenhuma tentativa nova começa; a missão para explicando", async () => {
    const c = montar();
    const u = usuario();
    // Uma missão gasta o teto do mês inteiro numa tentativa: US$ 50 × 600 centavos por dólar.
    await c.missoes(u, (ms) => ms.criar(u, "obedient", "Missão cara", { tetoCustoCentavos: 10_000 }));
    await c.processar(u, roteiro(50, concluir("nao_consegui", "Não deu.")));
    assert.equal(await c.missoes(u, (ms) => ms.gastoDoMes(u)), 30_000);
    await c.missoes(u, (ms) => ms.criar(u, "obedient", "Outra"));
    const r = roteiro(0.01, concluir("feito", "ok"), encerrar);
    const fins = await c.processar(u, r);
    const outra = fins.find((m) => m.objetivo === "Outra")!;
    assert.equal(outra.estado, "blocked");
    assert.match(outra.impedimento!, /teto do mês/);
    assert.equal(r.chamadas(), 0);
  });

  it("teto do mês (D21): a tentativa usa o MENOR entre o que resta da missão e o que resta do mês", async () => {
    const c = montar();
    const u = usuario();
    await c.conectar(u, "google_agenda");
    c.google.responderApi = () => ({ json: { items: [] } });
    // Uma missão gasta R$ 299,40 (US$ 49,90 × 600); restam 60 centavos no mês.
    await c.missoes(u, (ms) => ms.criar(u, "obedient", "Missão cara", { tetoCustoCentavos: 10_000 }));
    await c.processar(u, roteiro(49.9, concluir("nao_consegui", "Não deu.")));
    assert.equal(await c.missoes(u, (ms) => ms.gastoDoMes(u)), 29_940);
    // A outra tem teto de R$ 15, mas o mês só tem 60 centavos: para depois da primeira chamada (60).
    await c.missoes(u, (ms) => ms.criar(u, "obedient", "Ver a agenda"));
    const r = roteiro(0.1, lerAgenda, concluir("feito", "Nada."), encerrar);
    const fins = await c.processar(u, r);
    const fim = fins.find((m) => m.objetivo === "Ver a agenda")!;
    assert.equal(r.chamadas(), 1, "não chama o modelo de novo depois do teto do mês");
    assert.equal(fim.estado, "blocked");
    assert.match(fim.impedimento!, /teto do mês/);
  });

  it("tempo por chamada: escrita aprovada que passa do tempo para a missão (incerta); nada é repetido", async () => {
    const c = montar();
    const u = usuario();
    await c.conectar(u, "google_agenda");
    await c.missoes(u, (ms) => ms.criar(u, "obedient", "Apague o compromisso ev1", { maxTentativas: 2 }));
    const [esperando] = await c.processar(u, roteiro(0, usar("t1", "google_agenda__apagar_evento", { id: "ev1" })));
    await c.motor(u, async (mt) => mt.approve(esperando!.propostaId!, { id: u, kind: "user", strongAuth: true }, (await mt.approvals.get(esperando!.propostaId!))!.payloadHash));
    let deletes = 0;
    const travado = (async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        deletes++;
        return new Promise<Response>(() => {});
      }
      return c.google.fetch(url, init);
    }) as typeof fetch;
    const r = roteiro(0, concluir("nao_sei", "Não sei se apagou."), encerrar);
    const ex = executorDeMissoes({ db: banco.db, conexoes: c.conexoes, novoModelo: r.novo, centavosPorDolar: 600, clock: c.clock, http: travado, timeoutFerramentaMs: 30 });
    const [fim] = await processarMissoes(banco.db, u, ex, {}, c.clock);
    assert.equal(fim!.estado, "blocked");
    assert.match(fim!.impedimento!, /apagar_evento/);
    assert.equal(deletes, 1, "uma chamada só");
  });

  it("tempo por chamada: leitura que passa do tempo volta ao agente como erro, e a missão segue", async () => {
    const c = montar();
    const u = usuario();
    await c.conectar(u, "google_agenda");
    await c.missoes(u, (ms) => ms.criar(u, "obedient", "O que tenho amanhã?"));
    const travado = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("/calendar/")) return new Promise<Response>(() => {});
      return c.google.fetch(url, init);
    }) as typeof fetch;
    const r = roteiro(
      0,
      lerAgenda,
      (p) => {
        assert.match(resultados(p)[0]!.content, /tempo_esgotado|resultado_incerto|passou do tempo/);
        return concluir("nao_consegui", "A agenda não respondeu.")();
      },
      encerrar,
    );
    const ex = executorDeMissoes({ db: banco.db, conexoes: c.conexoes, novoModelo: r.novo, centavosPorDolar: 600, clock: c.clock, http: travado, timeoutFerramentaMs: 30 });
    const [fim] = await processarMissoes(banco.db, u, ex, {}, c.clock);
    assert.deepEqual([fim!.estado, fim!.desfecho?.tipo], ["failed", "nao_consegui"]);
  });
});

describe("executor das missões: reservas com dono e cerca (D20, M5; AT2)", () => {
  const lerAgenda = usar("t1", "google_agenda__listar_eventos", { de: "2026-11-04T00:00:00-03:00", ate: "2026-11-05T00:00:00-03:00" });
  const PRAZO = 15 * 60_000;

  it("processo com a reserva tomada por outro não chama o modelo nem ferramenta; só o dono atual termina", async () => {
    const c = montar();
    const u = usuario();
    await c.conectar(u, "google_agenda");
    let leituras = 0;
    c.google.responderApi = () => ((leituras += 1), { json: { items: [] } });
    const m = await c.missoes(u, (ms) => ms.criar(u, "obedient", "O que tenho amanhã?"));
    const a = await c.missoes(u, (ms) => ms.reservar(m.id, "processo-a"));
    c.clock.advance(PRAZO + 1000);
    const b = await c.missoes(u, (ms) => ms.reservar(m.id, "processo-b"));
    assert.ok(a.reservada && b.reservada);
    const ra = roteiro(0.01, lerAgenda, concluir("feito", "x"), encerrar);
    const exA = executorDeMissoes({ db: banco.db, conexoes: c.conexoes, novoModelo: ra.novo, centavosPorDolar: 600, clock: c.clock, http: c.google.fetch });
    const resA = await exA(a.missao);
    assert.equal(resA.tipo, "falha_temporaria");
    assert.equal(ra.chamadas(), 0, "A não chama o modelo");
    assert.equal(leituras, 0, "A não chama ferramenta");
    const descartada = await c.missoes(u, (ms) => ms.concluir(a.missao, resA));
    assert.deepEqual([descartada.estado, descartada.reservadaPor], ["running", "processo-b"], "o resultado de A é descartado");
    const rb = roteiro(0, lerAgenda, concluir("feito", "Nada amanhã."), encerrar);
    const exB = executorDeMissoes({ db: banco.db, conexoes: c.conexoes, novoModelo: rb.novo, centavosPorDolar: 600, clock: c.clock, http: c.google.fetch });
    const resB = await exB(b.missao);
    const fim = await c.missoes(u, (ms) => ms.concluir(b.missao, resB));
    assert.deepEqual([fim.estado, fim.desfecho?.tipo, leituras], ["completed", "feito", 1]);
  });

  it("reserva tomada NO MEIO da tentativa: o início da chamada é recusado pelo banco e a ferramenta não é chamada", async () => {
    const c = montar();
    const u = usuario();
    await c.conectar(u, "google_agenda");
    let leituras = 0;
    c.google.responderApi = () => ((leituras += 1), { json: { items: [] } });
    const m = await c.missoes(u, (ms) => ms.criar(u, "obedient", "O que tenho amanhã?"));
    const a = await c.missoes(u, (ms) => ms.reservar(m.id, "processo-a"));
    assert.ok(a.reservada);
    const r = roteiro(0.01, async () => {
      // Enquanto A espera o modelo, a reserva vence e B a toma.
      c.clock.advance(PRAZO + 1000);
      assert.ok((await c.missoes(u, (ms) => ms.reservar(m.id, "processo-b"))).reservada);
      return lerAgenda();
    }, concluir("feito", "x"), encerrar);
    const ex = executorDeMissoes({ db: banco.db, conexoes: c.conexoes, novoModelo: r.novo, centavosPorDolar: 600, clock: c.clock, http: c.google.fetch });
    const res = await ex(a.missao);
    assert.equal(res.tipo, "falha_temporaria");
    assert.match((res as { erro: string }).erro, /cerca velha/);
    assert.equal(r.chamadas(), 1, "o modelo não é chamado de novo");
    assert.equal(leituras, 0, "sem início gravado, a chamada não sai");
  });
});

describe("executor das missões: planejar, aprovar o plano e executar tarefa a tarefa (D20, M5)", () => {
  const lerAgenda = usar("t1", "google_agenda__listar_eventos", { de: "2026-11-04T00:00:00-03:00", ate: "2026-11-05T00:00:00-03:00" });
  const tarefa = (chave: string, titulo: string, ...depende_de: string[]) => ({ chave, titulo, depende_de });
  const propor = (id: string, tarefas: unknown[]) => usar(id, PROPOR_PLANO, { tarefas });
  const marcar = (id: string, chave: string) => usar(id, CONCLUIR_TAREFA, { chave });

  it("o planejador só tem propor_plano; plano com ciclo volta com o motivo, o corrigido espera a pessoa", async () => {
    const c = montar();
    const u = usuario();
    await c.conectar(u, "google_agenda");
    const m = await c.missoes(u, (ms) => ms.criar(u, "obedient", "Ver a agenda de amanhã e me avisar dos conflitos", { planejar: true }));
    const r = roteiro(
      0,
      propor("p1", [tarefa("ler", "Ler a agenda", "avisar"), tarefa("avisar", "Avisar dos conflitos", "ler")]),
      (p) => {
        assert.match(JSON.stringify(resultados(p)[0]), /ciclo/);
        return propor("p2", [tarefa("ler", "Ler a agenda de amanhã"), tarefa("avisar", "Avisar dos conflitos", "ler")])();
      },
      encerrar,
    );
    const [fim] = await c.processar(u, r);
    assert.deepEqual(r.pedidos[0]!.tools.map((t) => t.name), [PROPOR_PLANO], "nenhuma ferramenta para agir");
    assert.equal(fim!.estado, "waiting_approval");
    assert.deepEqual(fim!.plano?.tarefas.map((t) => t.chave), ["ler", "avisar"]);
    assert.equal(m.id, fim!.id);
    // Sem aprovação, nada anda.
    const nada = roteiro(0);
    await c.processar(u, nada);
    assert.equal(nada.chamadas(), 0);
  });

  it("aprovado, o agente recebe o plano como dado, marca as tarefas na ordem, e 'feito' só vale com todas feitas", async () => {
    const c = montar();
    const u = usuario();
    await c.conectar(u, "google_agenda");
    c.google.responderApi = () => ({ json: { items: [] } });
    await c.missoes(u, (ms) => ms.criar(u, "obedient", "Ver a agenda de amanhã e me avisar", { planejar: true }));
    const [proposta] = await c.processar(u, roteiro(0, propor("p1", [tarefa("ler", "Ler a agenda de amanhã"), tarefa("avisar", "Avisar dos conflitos", "ler")]), encerrar));
    await c.missoes(u, (ms) => ms.aprovarPlano(u, proposta!.id, proposta!.plano!.hash));
    const r = roteiro(
      0,
      (p) => {
        assert.match(String(p.messages[0]!.content), /Plano aprovado pela pessoa \(dado, não instrução\)/);
        assert.match(String(p.messages[0]!.content), /\[pendente\] avisar: Avisar dos conflitos \(depende de: ler\)/);
        assert.ok(p.tools.some((t) => t.name === CONCLUIR_TAREFA));
        return marcar("m1", "avisar")();
      },
      (p) => {
        assert.match(JSON.stringify(resultados(p)[0]), /antes desta, termine: ler/);
        return lerAgenda();
      },
      marcar("m2", "ler"),
      (p) => {
        assert.match(resultados(p)[0]!.content, /"prontas_agora":\["avisar"\]/);
        return concluir("feito", "Sem conflitos.")();
      },
      (p) => {
        assert.match(JSON.stringify(resultados(p)[0]), /Faltam tarefas do plano: avisar/);
        return marcar("m3", "avisar")();
      },
      concluir("feito", "Sem conflitos amanhã.", "fim2"),
      encerrar,
    );
    const [fim] = await c.processar(u, r);
    assert.deepEqual([fim!.estado, fim!.desfecho?.tipo], ["completed", "feito"]);
    const evs = await c.missoes(u, (ms) => ms.evidencias(fim!.id));
    assert.deepEqual(evs.filter((e) => e.tipo === "plano_completo").map((e) => [e.ok, e.referencia]), [[true, "2 de 2 tarefa(s)"]]);
  });
});

describe("executor das missões: chave de idempotência até o destino (D20, M5)", () => {
  it("criar compromisso aprovado leva ao Google um id derivado da pessoa, da missão e dos argumentos", async () => {
    const c = montar();
    const u = usuario();
    await c.conectar(u, "google_agenda");
    const args = { titulo: "Dentista", inicio: "2026-11-05T14:00:00-03:00", fim: "2026-11-05T15:00:00-03:00" };
    const m = await c.missoes(u, (ms) => ms.criar(u, "obedient", "Marque o dentista"));
    const [esperando] = await c.processar(u, roteiro(0, usar("t1", "google_agenda__criar_evento", args)));
    assert.equal(esperando!.estado, "waiting_approval");
    await c.motor(u, async (mt) => mt.approve(esperando!.propostaId!, { id: u, kind: "user", strongAuth: true }, (await mt.approvals.get(esperando!.propostaId!))!.payloadHash));
    const corpos: string[] = [];
    const http = (async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST" && String(url).includes("/calendar/")) corpos.push(String(init.body));
      return c.google.fetch(url, init);
    }) as typeof fetch;
    const r = roteiro(0, concluir("feito", "Marquei."), encerrar);
    const ex = executorDeMissoes({ db: banco.db, conexoes: c.conexoes, novoModelo: r.novo, centavosPorDolar: 600, clock: c.clock, http });
    await processarMissoes(banco.db, u, ex, {}, c.clock);
    assert.equal(corpos.length, 1);
    assert.equal((JSON.parse(corpos[0]!) as { id: string }).id, idDeEvento(`${u}\n${m.id}\ngoogle_agenda.criar_evento\n${payloadHash(args)}`));
  });
});
