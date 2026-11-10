// SPDX-License-Identifier: AGPL-3.0-only
//
// Conexões OAuth contra um Google falso (o `fetch` é trocado): escopo mínimo, PKCE, state de uso
// único preso ao navegador, credencial cifrada e presa à pessoa, renovação, revogação.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { ManualClock } from "@obedient/core";
import { comoUsuario } from "@obedient/store-postgres";
import { bancoDeTeste, type BancoDeTeste } from "../../store-postgres/src/banco-de-teste.ts";
import { Cofre, lerChaves } from "./cofre.ts";
import { Conexoes, GOOGLE, tirarConexoes } from "./conexoes.ts";
import { GoogleFalso } from "./google-falso.ts";
import { integracao } from "./catalogo.ts";

const T0 = new Date("2026-11-03T12:00:00Z");
const CLIENTE = { clientId: "cliente.apps.googleusercontent.com", clientSecret: "segredo-de-teste", redirectUri: "https://obedient.exemplo.test/api/conexoes/retorno" };

let banco: BancoDeTeste;
before(async () => {
  banco = await bancoDeTeste();
});
after(() => banco.fechar());

const cofre = new Cofre(lerChaves(`k1:${Cofre.novaChave()}`));
let n = 0;
const usuario = (nome: string) => `${nome}-c${++n}`;
function montar() {
  const google = new GoogleFalso(CLIENTE.clientSecret);
  const clock = new ManualClock(T0);
  return { google, clock, conexoes: new Conexoes(banco.db, cofre, CLIENTE, google.fetch as typeof fetch, clock) };
}
const codigo = (e: unknown) => (e as { code?: string }).code;

async function conectar(c: ReturnType<typeof montar>, u: string, id = "google_agenda") {
  const { url, nonce } = await c.conexoes.iniciar(u, id);
  const { state, code } = c.google.autorizar(url);
  return c.conexoes.concluir(state, code, nonce);
}

describe("conexões OAuth (Fase 7)", () => {
  it("pede só os escopos da integração, com PKCE e acesso permanente", async () => {
    const c = montar();
    const { url } = await c.conexoes.iniciar(usuario("ana"), "google_drive");
    const u = new URL(url);
    assert.equal(u.searchParams.get("scope"), "https://www.googleapis.com/auth/drive.file");
    assert.equal(u.searchParams.get("include_granted_scopes"), "false");
    assert.equal(u.searchParams.get("redirect_uri"), CLIENTE.redirectUri);
    assert.ok((u.searchParams.get("code_challenge") ?? "").length >= 43);
  });

  it("conecta: a credencial fica cifrada no banco e o app só vê nome, escopos e data", async () => {
    const c = montar();
    const ana = usuario("ana");
    assert.deepEqual(await conectar(c, ana), { userId: ana, integracao: "google_agenda" });
    assert.deepEqual(await c.conexoes.listar(ana), [{ integracao: "google_agenda", escopos: ["https://www.googleapis.com/auth/calendar.events"], conectadaEm: T0.toISOString() }]);
    const bruto = await comoUsuario(banco.db, ana, (tx) => tx.query<{ cifra: Buffer }>("select cifra from obedient.connections where user_id = $1", [ana]));
    assert.doesNotMatch(Buffer.from(bruto.rows[0]!.cifra).toString("latin1"), /refresh-|acesso-/);
    assert.match(await c.conexoes.tokenDeAcesso(ana, "google_agenda"), /^acesso-/);
  });

  it("o state vale uma vez, por 10 minutos, e só no navegador que começou", async () => {
    const c = montar();
    const ana = usuario("ana");
    const { url, nonce } = await c.conexoes.iniciar(ana, "google_agenda");
    const { state, code } = c.google.autorizar(url);
    // Outro navegador (sem o cookie certo) com o mesmo state: nada conecta (CSRF de login OAuth).
    await assert.rejects(c.conexoes.concluir(state, code, "nonce-de-outro-navegador"), (e) => codigo(e) === "UNAUTHENTICATED");
    assert.deepEqual(await c.conexoes.concluir(state, code, nonce), { userId: ana, integracao: "google_agenda" });
    // A mesma volta de novo, do MESMO navegador (recarga, pré-carregamento): "conectado", sem trocar
    // código por token outra vez. De outro navegador, continua recusada.
    const trocas = c.google.chamadas.length;
    assert.deepEqual(await c.conexoes.concluir(state, code, nonce), { userId: ana, integracao: "google_agenda", repetida: true });
    assert.equal(c.google.chamadas.length, trocas, "nada foi pedido de novo ao Google");
    await assert.rejects(c.conexoes.concluir(state, code, "nonce-de-outro-navegador"), /não vale mais/);
    // Desconectada, a volta repetida não diz mais "conectado".
    await comoUsuario(banco.db, ana, (tx) => tirarConexoes(tx, ana, "teste", "google_agenda"));
    await assert.rejects(c.conexoes.concluir(state, code, nonce), /não vale mais/);
    const outro = await c.conexoes.iniciar(ana, "google_gmail");
    const a2 = c.google.autorizar(outro.url);
    c.clock.advance(11 * 60 * 1000);
    await assert.rejects(c.conexoes.concluir(a2.state, a2.code, outro.nonce), /não vale mais/);
  });

  it("o Google sem todas as permissões, ou com permissões a mais, não conecta", async () => {
    const c = montar();
    const ana = usuario("ana");
    c.google.escopoDevolvido = () => "https://www.googleapis.com/auth/gmail.readonly";
    await assert.rejects(conectar(c, ana, "google_gmail"), (e) => codigo(e) === "CONSENT_REQUIRED");
    c.google.escopoDevolvido = (p) => `${p} https://www.googleapis.com/auth/drive`;
    await assert.rejects(conectar(c, ana, "google_gmail"), /além das pedidas/);
    assert.deepEqual(await c.conexoes.listar(ana), []);
  });

  it("renova o token quando está para vencer; acesso revogado no Google desfaz a conexão", async () => {
    const c = montar();
    const ana = usuario("ana");
    await conectar(c, ana);
    const t1 = await c.conexoes.tokenDeAcesso(ana, "google_agenda");
    c.clock.advance(59 * 60 * 1000 + 1);
    const t2 = await c.conexoes.tokenDeAcesso(ana, "google_agenda");
    assert.notEqual(t1, t2);
    assert.match(t2, /^renovado-/);
    assert.equal(await c.conexoes.tokenDeAcesso(ana, "google_agenda"), t2, "o renovado foi guardado");
    c.google.refreshValido.clear();
    c.clock.advance(2 * 3600 * 1000);
    await assert.rejects(c.conexoes.tokenDeAcesso(ana, "google_agenda"), /conecte de novo/);
    assert.deepEqual(await c.conexoes.listar(ana), []);
  });

  it("desconectar revoga no Google; sem rede, fica na fila e revoga depois", async () => {
    const c = montar();
    const ana = usuario("ana");
    await conectar(c, ana);
    assert.equal(await c.conexoes.desconectar(ana, "google_agenda"), true);
    assert.equal(c.google.revogados.length, 1);
    assert.match(c.google.revogados[0]!, /^refresh-/);

    await conectar(c, ana);
    const original = c.google.fetch;
    c.google.fetch = async (url, init) => (String(url) === GOOGLE.revogacao ? Promise.reject(new TypeError("sem rede")) : original(url, init));
    const semRede = new Conexoes(banco.db, cofre, CLIENTE, c.google.fetch as typeof fetch, c.clock);
    await semRede.desconectar(ana, "google_agenda");
    assert.deepEqual(await semRede.listar(ana), [], "a conexão sai na hora, mesmo sem rede");
    assert.deepEqual(await c.conexoes.revogarPendentes(ana), { revogadas: 1, pendentes: 0 });
  });

  it("parar e apagar tiram todas as conexões na transação de quem chama", async () => {
    const c = montar();
    const ana = usuario("ana");
    await conectar(c, ana, "google_agenda");
    await conectar(c, ana, "google_drive");
    const tiradas = await comoUsuario(banco.db, ana, (tx) => tirarConexoes(tx, ana, "parada de emergência"));
    assert.deepEqual(tiradas.sort(), ["google_agenda", "google_drive"]);
    assert.deepEqual(await c.conexoes.listar(ana), []);
    await assert.rejects(c.conexoes.tokenDeAcesso(ana, "google_agenda"), (e) => codigo(e) === "GRANT_NOT_FOUND");
    assert.deepEqual(await c.conexoes.revogarPendentes(ana), { revogadas: 2, pendentes: 0 });
  });

  it("uma pessoa não lê nem usa a conexão de outra; cifra copiada para outra pessoa não abre", async () => {
    const c = montar();
    const ana = usuario("ana");
    const bia = usuario("bia");
    await conectar(c, ana);
    assert.deepEqual(await c.conexoes.listar(bia), []);
    await assert.rejects(c.conexoes.tokenDeAcesso(bia, "google_agenda"), (e) => codigo(e) === "GRANT_NOT_FOUND");
    // Mesmo que alguém copiasse a cifra da Ana para a linha da Bia, ela não abre (a cifra é presa à pessoa).
    const daAna = await comoUsuario(banco.db, ana, (tx) => tx.query<{ cifra: Buffer; chave_id: string }>("select cifra, chave_id from obedient.connections where user_id = $1", [ana]));
    const { cifra, chave_id } = daAna.rows[0]!;
    assert.throws(() => cofre.decifrar({ chaveId: chave_id, dados: Buffer.from(cifra) }, bia, "google_agenda"), /adulterada ou de outra pessoa/);
    assert.throws(() => cofre.decifrar({ chaveId: chave_id, dados: Buffer.from(cifra) }, ana, "google_gmail"), /adulterada ou de outra pessoa/);
  });

  it("o papel do app não lê o state de ninguém (só o papel de entrada)", async () => {
    const ana = usuario("ana");
    await montar().conexoes.iniciar(ana, "google_agenda");
    await assert.rejects(comoUsuario(banco.db, ana, (tx) => tx.query("select * from obedient.oauth_states")), /permission denied/);
  });

  it("toda ferramenta declarada pertence à integração e a integração pede só os seus escopos", () => {
    for (const id of ["google_agenda", "google_gmail", "google_drive"]) {
      const i = integracao(id);
      assert.ok(i.ferramentas.every((f) => f.name.startsWith(`${id}.`)));
      assert.ok(i.escopos.every((e) => e.startsWith("https://www.googleapis.com/auth/")));
    }
    assert.ok(!integracao("google_gmail").escopos.some((e) => /gmail\.modify|mail\.google\.com/.test(e)), "nada de apagar e-mail");
    assert.ok(!integracao("google_drive").escopos.some((e) => /auth\/drive$|drive\.readonly/.test(e)), "nada de ver o Drive inteiro");
  });
});

describe("cofre", () => {
  it("chave errada, rotação e cifra adulterada", () => {
    const antiga = Cofre.novaChave();
    const c1 = new Cofre(lerChaves(`k1:${antiga}`));
    const x = c1.cifrar("segredo", "ana", "google_agenda");
    const c2 = new Cofre(lerChaves(`k2:${Cofre.novaChave()},k1:${antiga}`));
    assert.equal(c2.decifrar(x, "ana", "google_agenda"), "segredo", "chave antiga continua abrindo");
    assert.equal(c2.cifrar("y", "ana", "google_agenda").chaveId, "k2", "a primeira é a que cifra");
    const adulterada = { ...x, dados: Buffer.from(x.dados) };
    adulterada.dados[adulterada.dados.length - 1]! ^= 1;
    assert.throws(() => c2.decifrar(adulterada, "ana", "google_agenda"));
    assert.throws(() => new Cofre(lerChaves(`k3:${Cofre.novaChave()}`)).decifrar(x, "ana", "google_agenda"), /reconecte/);
    assert.throws(() => lerChaves("k1:curta"), /32 bytes/);
    assert.throws(() => new Cofre([]), /sem chave/);
  });
});
