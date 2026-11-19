// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { test } from "node:test";
import { encaminharPedido, validarPedido, type EscopoDesenvolvimento, type PedidoDesenvolvimento } from "./index.ts";

const escopo: EscopoDesenvolvimento = {
  repositorio: "cpenedofilho-crypto/obedient",
  ambiente: "sandbox",
  operacoes: ["repo.read", "branch.create", "file.write", "tests.run", "database.migrate"],
  expiraEm: "2027-01-01T00:00:00.000Z",
  limiteCustoCentavos: 500,
};
const pedido: PedidoDesenvolvimento = {
  missaoId: "mission-1234",
  operacao: "repo.read",
  repositorio: escopo.repositorio,
  ambiente: "sandbox",
  chaveIdempotencia: "mission-1234:read",
};
const agora = new Date("2026-11-19T00:00:00.000Z");

test("permite apenas pré-validação de operação explicitamente delegada", () => {
  assert.deepEqual(validarPedido(escopo, pedido, agora), { permitido: true });
});
test("nega outro repositório", () => {
  assert.equal(validarPedido(escopo, { ...pedido, repositorio: "outro/projeto" }, agora).permitido, false);
});
test("nega outro ambiente", () => {
  assert.equal(validarPedido(escopo, { ...pedido, ambiente: "producao" }, agora).permitido, false);
});
test("nega operação não delegada", () => {
  assert.equal(validarPedido(escopo, { ...pedido, operacao: "pull_request.create" }, agora).permitido, false);
});
test("nega escopo expirado", () => {
  assert.equal(validarPedido(escopo, pedido, new Date("2027-01-01T00:00:00.000Z")).permitido, false);
});
test("nega migration mesmo se constar no escopo inicial", () => {
  assert.deepEqual(validarPedido(escopo, { ...pedido, operacao: "database.migrate" }, agora), {
    permitido: false, motivo: "operacao_critica_nao_implementada",
  });
});
test("nega identificador de idempotência inválido", () => {
  assert.equal(validarPedido(escopo, { ...pedido, chaveIdempotencia: "x" }, agora).permitido, false);
});

test("nega até operações delegadas quando o ambiente é produção", () => {
  const prod = { ...escopo, ambiente: "producao" } as const;
  assert.deepEqual(validarPedido(prod, { ...pedido, ambiente: "producao" }, agora), {
    permitido: false, motivo: "producao_nao_habilitada",
  });
});
test("nega promoção de deploy em homologação", () => {
  const homologacao = { ...escopo, ambiente: "homologacao", operacoes: ["deployment.promote"] } as const;
  assert.equal(validarPedido(homologacao, { ...pedido, ambiente: "homologacao", operacao: "deployment.promote" }, agora).permitido, false);
});

test("não invoca porta externa quando o escopo é negado", async () => {
  let chamadas = 0;
  const resultado = await encaminharPedido(escopo, { ...pedido, ambiente: "producao" }, agora, async () => {
    chamadas++;
    return "executado";
  });
  assert.equal(resultado.status, "denied");
  assert.equal(chamadas, 0);
});
test("encaminha apenas pedido válido à porta injetada", async () => {
  let chamadas = 0;
  const resultado = await encaminharPedido(escopo, pedido, agora, async (recebido) => {
    chamadas++;
    assert.deepEqual(recebido, pedido);
    return { status: "denied", motivo: "sem_grant" };
  });
  assert.deepEqual(resultado, { status: "delegated", resultado: { status: "denied", motivo: "sem_grant" } });
  assert.equal(chamadas, 1);
});
