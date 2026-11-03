// SPDX-License-Identifier: AGPL-3.0-only
//
// A fila de ações do aparelho (public/fila.js): grava primeiro, envia depois, na ordem certa, sem
// perder nada quando a rede cai e sem mandar duas vezes.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error: módulo JS do navegador, checado por tsconfig.app.json
import { ArmazemEmMemoria, Fila, novoOpId } from "../public/fila.js";

type Envio = { tipo: "resultado"; resultado: { ok: boolean; tipo: string; codigo?: string; mensagem?: string } } | { tipo: "temporaria" } | { tipo: "sessao" };

function montar(respostas: (op: { opId: string; acao: { tipo: string } }) => Envio | Promise<Envio>) {
  let t = 1000;
  const enviados: { opId: string; tipo: string }[] = [];
  const armazem = new ArmazemEmMemoria();
  const fila = new Fila(
    armazem,
    async (op: { opId: string; acao: { tipo: string } }) => {
      enviados.push({ opId: op.opId, tipo: op.acao.tipo });
      return respostas(op);
    },
    () => ++t,
  );
  return { fila, enviados, armazem, avancar: (ms: number) => (t += ms) };
}

const ok = (op: { acao: { tipo: string } }): Envio => ({ tipo: "resultado", resultado: { ok: true, tipo: op.acao.tipo } });

describe("fila do aparelho", () => {
  it("opId: 22 caracteres base64url, sem repetir", () => {
    const ids = new Set(Array.from({ length: 2000 }, () => novoOpId()));
    assert.equal(ids.size, 2000);
    for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]{22}$/);
  });

  it("parar e liberar saem antes de tudo; o resto, do mais antigo para o mais novo", async () => {
    const { fila, enviados } = montar(ok);
    await fila.registrar({ tipo: "aprovar", propostaId: "p1", hash: "a".repeat(64) });
    await fila.registrar({ tipo: "revogar", autorizacaoId: "g1" });
    await fila.registrar({ tipo: "parar" });
    await fila.registrar({ tipo: "recusar", propostaId: "p2" });
    await fila.drenar();
    assert.deepEqual(enviados.map((e) => e.tipo), ["parar", "aprovar", "revogar", "recusar"]);
    assert.equal((await fila.pendentes()).length, 0);
  });

  it("sem rede: nada se perde, para no primeiro erro e retoma com o MESMO opId", async () => {
    let rede = false;
    const { fila, enviados } = montar((op) => (rede ? ok(op) : { tipo: "temporaria" }));
    const a = await fila.registrar({ tipo: "parar" });
    await fila.registrar({ tipo: "aprovar", propostaId: "p1", hash: "a".repeat(64) });
    assert.deepEqual(await fila.drenar(), { enviadas: 0, parouPor: "rede" });
    assert.equal(enviados.length, 1, "não insiste no resto enquanto a rede está fora");
    assert.equal((await fila.pendentes()).length, 2);
    rede = true;
    assert.deepEqual(await fila.drenar(), { enviadas: 2, parouPor: "fim" });
    assert.deepEqual(enviados.map((e) => e.opId).filter((id) => id === a.opId).length, 2, "o reenvio usa o mesmo opId (o servidor deduplica)");
  });

  it("envio que lança exceção conta como falta de rede", async () => {
    const { fila } = montar(() => {
      throw new Error("Failed to fetch");
    });
    await fila.registrar({ tipo: "parar" });
    assert.deepEqual(await fila.drenar(), { enviadas: 0, parouPor: "rede" });
    assert.equal((await fila.pendentes())[0].tentativas, 1);
  });

  it("sessão vencida para a fila sem perder a ação", async () => {
    const { fila } = montar(() => ({ tipo: "sessao" }));
    await fila.registrar({ tipo: "liberar" });
    assert.deepEqual(await fila.drenar(), { enviadas: 0, parouPor: "sessao" });
    assert.equal((await fila.pendentes()).length, 1);
  });

  it("recusa do servidor é definitiva: guarda a mensagem e não reenvia", async () => {
    const { fila, enviados } = montar((op) => ({ tipo: "resultado", resultado: { ok: false, tipo: op.acao.tipo, codigo: "PROPOSAL_EXPIRED", mensagem: "O pedido venceu" } }));
    await fila.registrar({ tipo: "aprovar", propostaId: "p1", hash: "a".repeat(64) });
    await fila.drenar();
    await fila.drenar();
    assert.equal(enviados.length, 1);
    const [r] = await fila.resolvidas();
    assert.equal(r.estado, "recusada");
    assert.equal(r.resultado.mensagem, "O pedido venceu");
  });

  it("duas drenagens ao mesmo tempo enviam cada ação uma vez", async () => {
    const { fila, enviados } = montar(async (op) => {
      await new Promise((r) => setTimeout(r, 5));
      return ok(op);
    });
    for (let i = 0; i < 5; i++) await fila.registrar({ tipo: "recusar", propostaId: `p${i}` });
    await Promise.all([fila.drenar(), fila.drenar(), fila.drenar()]);
    assert.equal(enviados.length, 5);
  });

  it("limpar apaga desfechos antigos e nunca o que está pendente", async () => {
    let rede = true;
    const { fila, avancar } = montar((op) => (rede ? ok(op) : { tipo: "temporaria" }));
    await fila.registrar({ tipo: "parar" });
    await fila.drenar();
    rede = false;
    await fila.registrar({ tipo: "liberar" });
    await fila.drenar();
    avancar(2 * 24 * 3600 * 1000);
    await fila.limpar();
    assert.equal((await fila.resolvidas()).length, 0);
    assert.equal((await fila.pendentes()).length, 1);
  });
});
