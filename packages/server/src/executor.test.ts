// SPDX-License-Identifier: AGPL-3.0-only
//
// O executor das missões de ponta a ponta no servidor, com o banco, o Google falso e um modelo
// roteirizado (nada sai para a rede):
//   ler a agenda e concluir; apagar compromisso pede passkey, a missão espera e, aprovada, a MESMA
//   tentativa continua e apaga uma vez; terminar sem desfecho não é "feito"; teto de custo; parar no
//   meio da tentativa; erro passageiro do modelo continua a conversa; o agendador acha a missão.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { ManualClock } from "@obedient/core";
import { ErroModelo, type PedidoModelo, type RespostaModelo, type ResultadoFerramenta } from "@obedient/agent-orchestrator";
import { Cofre, Conexoes, concederAoConectar, lerChaves } from "@obedient/integrations";
import { comoUsuario, gravarIdentificacao, missoesNaTransacao, motorNaTransacao } from "@obedient/store-postgres";
import { GoogleFalso } from "../../integrations/src/google-falso.ts";
import { bancoDeTeste, type BancoDeTeste } from "../../store-postgres/src/banco-de-teste.ts";
import { agendarMissoes } from "./agendador.ts";
import { CONCLUIR, executorDeMissoes, type ModeloComGasto } from "./executor.ts";
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
/** O Google falso devolve o compromisso no GET (apagar confere título e início) e 204 no DELETE. */
const eventoFalso = (u: URL, metodo: string) =>
  metodo === "GET" ? { json: { id: u.pathname.split("/").at(-1), summary: "Consulta", start: { dateTime: "2026-11-05T14:00:00-03:00" } } } : { status: 204 };
const apagar = (id: string) => ({ id, titulo: "Consulta", inicio: "2026-11-05T14:00:00-03:00" });

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
    c.google.responderApi = eventoFalso;
    const m = await c.missoes(u, (ms) => ms.criar(u, "obedient", "Apague o compromisso ev1", { maxTentativas: 1 }));
    const r = roteiro(
      0.001,
      usar("t1", "google_agenda__apagar_evento", apagar("ev1")),
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
    c.google.responderApi = eventoFalso;
    await c.missoes(u, (ms) => ms.criar(u, "obedient", "Apague ev1 e ev2"));
    const r = roteiro(
      0,
      () => resposta([{ type: "tool_use", id: "a", name: "google_agenda__apagar_evento", input: apagar("ev1") }, { type: "tool_use", id: "b", name: "google_agenda__apagar_evento", input: apagar("ev2") }], "tool_use"),
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
    assert.deepEqual([primeira!.estado, primeira!.desfecho], ["running", null]);
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
    assert.equal(primeira!.estado, "running");
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
