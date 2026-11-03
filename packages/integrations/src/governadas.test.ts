// SPDX-License-Identifier: AGPL-3.0-only
//
// As ferramentas do Google passando pelo Ethics Engine, do jeito que o laço do agente vai usá-las
// (chamarComEthics), com o banco de verdade e o Google falso:
//   sem conexão, nada; conectar concede só aquela integração; ler roda sozinho; apagar compromisso
//   pede passkey e executa uma vez com o payload aprovado; mandar e-mail exige a assinatura e
//   aprovação; desconectar tira tudo.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { ManualClock, payloadHash } from "@obedient/core";
import { type AbrirMotor, chamarComEthicsEmEtapas, situacaoPeloEthics } from "@obedient/agent-orchestrator";
import { comoUsuario, gravarIdentificacao, motorNaTransacao } from "@obedient/store-postgres";
import { bancoDeTeste, type BancoDeTeste } from "../../store-postgres/src/banco-de-teste.ts";
import { AGENTE, concederAoConectar, executorGoogle, itensGovernados, nomeParaModelo, retirarAutoridade } from "./autoridade.ts";
import { Cofre, lerChaves } from "./cofre.ts";
import { Conexoes, tirarConexoes } from "./conexoes.ts";
import { GoogleFalso } from "./google-falso.ts";

const T0 = new Date("2026-11-03T12:00:00Z");
const CLIENTE = { clientId: "id", clientSecret: "segredo", redirectUri: "https://obedient.exemplo.test/api/conexoes/retorno" };
let banco: BancoDeTeste;
before(async () => {
  banco = await bancoDeTeste();
});
after(() => banco.fechar());

let n = 0;
const usuario = () => `ana-g${++n}`;

function montar() {
  const google = new GoogleFalso(CLIENTE.clientSecret);
  const clock = new ManualClock(T0);
  const conexoes = new Conexoes(banco.db, new Cofre(lerChaves(`k1:${Cofre.novaChave()}`)), CLIENTE, google.fetch as typeof fetch, clock);
  const motor = <T>(u: string, fn: (m: ReturnType<typeof motorNaTransacao>) => Promise<T>) => comoUsuario(banco.db, u, (tx) => fn(motorNaTransacao(tx, { clock, exigirIdentificacao: true })));
  /** Conectar como o servidor faz: OAuth + conceder a autoridade da integração. */
  const conectar = async (u: string, id: string) => {
    const { url, nonce } = await conexoes.iniciar(u, id);
    const { state, code } = google.autorizar(url);
    await conexoes.concluir(state, code, nonce);
    await motor(u, (m) => concederAoConectar(m, u, id, clock.now()));
  };
  /**
   * Uma chamada de ferramenta como o servidor faz: cada etapa de banco numa transação curta
   * (autorizar; reivindicar; concluir) e a chamada ao Google FORA de qualquer transação.
   */
  const chamar = (u: string, ferramenta: string, args: Record<string, unknown>, approvalId?: string) => {
    const abrir: AbrirMotor = (fn) => comoUsuario(banco.db, u, (tx) => fn(motorNaTransacao(tx, { clock, exigirIdentificacao: true })));
    const item = itensGovernados(["google_agenda", "google_gmail", "google_drive"]).find((x) => x.ferramenta === ferramenta)!;
    return chamarComEthicsEmEtapas(abrir, { userId: u, agentId: AGENTE }, executorGoogle(conexoes, u, google.fetch as typeof fetch))(item, args, approvalId);
  };
  return { google, clock, conexoes, motor, conectar, chamar };
}

describe("ferramentas do Google pelo Ethics Engine", () => {
  it("sem conexão: negado, e nada chega ao Google", async () => {
    const c = montar();
    const u = usuario();
    const r = await c.chamar(u, "google_agenda.listar_eventos", { de: "2026-11-04T00:00:00Z", ate: "2026-11-05T00:00:00Z" });
    assert.equal(r.status, "denied");
    assert.equal(c.google.api.length, 0);
  });

  it("conectar a Agenda: ler roda sozinho; o Gmail continua fechado", async () => {
    const c = montar();
    const u = usuario();
    await c.conectar(u, "google_agenda");
    c.google.responderApi = () => ({ json: { items: [{ id: "ev1", summary: "Dentista", start: { dateTime: "2026-11-04T10:00:00Z" }, end: { dateTime: "2026-11-04T11:00:00Z" } }] } });
    const r = await c.chamar(u, "google_agenda.listar_eventos", { de: "2026-11-04T00:00:00Z", ate: "2026-11-05T00:00:00Z" });
    assert.equal(r.status, "succeeded", JSON.stringify(r));
    assert.deepEqual((r.resultado as { conteudo_externo: { eventos: { titulo: string }[] } }).conteudo_externo.eventos.map((e) => e.titulo), ["Dentista"]);
    assert.match(c.google.api[0]!.auth!, /^Bearer acesso-/);
    const gmail = await c.chamar(u, "google_gmail.buscar_mensagens", { busca: "x" });
    assert.equal(gmail.status, "denied");
    assert.equal(c.google.api.length, 1);
  });

  it("apagar compromisso: pede passkey; aprovado, executa uma vez com o payload aprovado", async () => {
    const c = montar();
    const u = usuario();
    await c.conectar(u, "google_agenda");
    c.google.responderApi = () => ({ status: 204 });
    const args = { id: "ev1" };
    const r = await c.chamar(u, "google_agenda.apagar_evento", args);
    assert.equal(r.status, "approval_required");
    assert.equal(c.google.api.length, 0, "nada apagado antes da aprovação");
    const p = await c.motor(u, (m) => m.approvals.get(r.approvalId!));
    assert.equal(p?.approver, "user_strong_auth");
    await assert.rejects(c.motor(u, (m) => m.approve(r.approvalId!, { id: u, kind: "user", strongAuth: false }, p!.payloadHash)), /reautenticação/);
    await c.motor(u, (m) => m.approve(r.approvalId!, { id: u, kind: "user", strongAuth: true }, p!.payloadHash));
    // Outro id com o mesmo approvalId: recusado (o payload é o que a pessoa viu).
    assert.equal((await c.chamar(u, "google_agenda.apagar_evento", { id: "outro" }, r.approvalId!)).motivo, "payload_diferente_do_aprovado");
    const feito = await c.chamar(u, "google_agenda.apagar_evento", args, r.approvalId!);
    assert.equal(feito.status, "succeeded", JSON.stringify(feito));
    assert.equal(c.google.api.filter((x) => x.metodo === "DELETE").length, 1);
    assert.equal((await c.chamar(u, "google_agenda.apagar_evento", args, r.approvalId!)).status, "denied", "segunda vez não executa");
    assert.equal(c.google.api.filter((x) => x.metodo === "DELETE").length, 1);
    assert.equal((await comoUsuario(banco.db, u, (tx) => situacaoPeloEthics(motorNaTransacao(tx, { clock: c.clock }))(r.approvalId!))).tipo, "ja_executada");
  });

  it("mandar e-mail: só com a assinatura configurada, e sempre com aprovação", async () => {
    const c = montar();
    const u = usuario();
    await c.conectar(u, "google_gmail");
    const email = { para: "fornecedor@exemplo.org", assunto: "Pedido", texto: "Confirmo 12 caixas." };
    assert.equal((await c.chamar(u, "google_gmail.enviar_mensagem", { ...email, identificacao: "qualquer" })).status, "denied", "sem assinatura configurada");
    await comoUsuario(banco.db, u, (tx) => gravarIdentificacao(tx, u, "Enviada pelo assistente da Ana", c.clock));
    assert.equal((await c.chamar(u, "google_gmail.enviar_mensagem", { ...email, identificacao: "Ana" })).status, "denied", "assinatura diferente");
    const r = await c.chamar(u, "google_gmail.enviar_mensagem", { ...email, identificacao: "Enviada pelo assistente da Ana" });
    assert.equal(r.status, "approval_required");
    assert.equal(c.google.api.length, 0);
    const hash = payloadHash({ systemId: "google_gmail", tool: "google_gmail.enviar_mensagem", args: { ...email, identificacao: "Enviada pelo assistente da Ana" } });
    await c.motor(u, (m) => m.approve(r.approvalId!, { id: u, kind: "user", strongAuth: false }, hash));
    const feito = await c.chamar(u, "google_gmail.enviar_mensagem", { ...email, identificacao: "Enviada pelo assistente da Ana" }, r.approvalId!);
    assert.equal(feito.status, "succeeded", JSON.stringify(feito));
    const enviado = Buffer.from(JSON.parse(c.google.api[0]!.corpo).raw, "base64url").toString("utf8");
    assert.match(Buffer.from(enviado.split("\r\n\r\n")[1]!, "base64").toString("utf8"), /-- \nEnviada pelo assistente da Ana\n$/);
  });

  it("desconectar (ou parar) tira o grant e o consentimento: nada mais roda", async () => {
    const c = montar();
    const u = usuario();
    await c.conectar(u, "google_drive");
    c.google.responderApi = () => ({ json: { files: [] } });
    assert.equal((await c.chamar(u, "google_drive.listar_arquivos", {})).status, "succeeded");
    await comoUsuario(banco.db, u, async (tx) => {
      const m = motorNaTransacao(tx, { clock: c.clock });
      for (const id of await tirarConexoes(tx, u, "teste")) await retirarAutoridade(m, u, id);
    });
    const r = await c.chamar(u, "google_drive.listar_arquivos", {});
    assert.equal(r.status, "denied");
    assert.match(r.motivo!, /nenhum grant vigente/);
    const grants = await c.motor(u, (m) => m.grants.list(u));
    assert.ok(grants.every((g) => g.revokedAt));
    assert.equal((await c.motor(u, (m) => m.consent.check(u, "integracao:google_drive", ["documentos"]))).ok, false);
  });

  it("o grant de cada conexão é só da integração, com prazo e finalidade, e reconectar não acumula", async () => {
    const c = montar();
    const u = usuario();
    await c.conectar(u, "google_agenda");
    await c.conectar(u, "google_agenda");
    const vigentes = (await c.motor(u, (m) => m.grants.list(u))).filter((g) => !g.revokedAt);
    assert.equal(vigentes.length, 1);
    const g = vigentes[0]!;
    assert.deepEqual([g.agentId, g.systemId, g.capability, g.limits.autonomousUpTo], [AGENTE, "google_agenda", "google_agenda.*", "LOW"]);
    assert.equal(g.expiresAt.getTime() - T0.getTime(), 30 * 24 * 3600 * 1000);
    assert.match(g.purpose, /compromissos/);
  });

  it("os nomes que o modelo vê seguem o formato da API de modelos", () => {
    for (const i of itensGovernados(["google_agenda", "google_gmail", "google_drive"])) {
      assert.match(i.definicao.name, /^[a-zA-Z0-9_-]{1,64}$/);
      assert.equal(i.definicao.name, nomeParaModelo(i.ferramenta));
    }
  });
});
