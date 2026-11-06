// SPDX-License-Identifier: AGPL-3.0-only
// Comprovante de aprovação (auditoria A2A de 06/11/2026, R6): o Gateway assina, o destino confere.

import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assinarComprovante, verificarComprovante } from "./index.ts";

const par = generateKeyPairSync("ed25519");
const PRIV_PEM = par.privateKey.export({ format: "pem", type: "pkcs8" }) as string;
const PUB_PEM = par.publicKey.export({ format: "pem", type: "spki" }) as string;
const PUB_DER = (par.publicKey.export({ format: "der", type: "spki" }) as Buffer).toString("base64");
const T = 1_800_000_000_000;
const args = { resumo: "Tocar em \"Enviar\"", proposta_id: "id-00000001" };
const assinado = (over = {}) => assinarComprovante({ chavePrivada: PRIV_PEM, ferramenta: "f", argumentos: args, approvalId: "aprov-0001", agora: T, ...over });

describe("comprovante de aprovação", () => {
  it("ida e volta, com a chave em PEM ou DER base64, e a ordem das chaves não importa", () => {
    const c = assinado();
    for (const chavePublica of [PUB_PEM, PUB_DER]) {
      assert.deepEqual(verificarComprovante({ chavePublica, ferramenta: "f", argumentos: { proposta_id: args.proposta_id, resumo: args.resumo }, comprovante: c, agora: T + 1000 }), { ok: true, approvalId: "aprov-0001" });
    }
  });

  it("cada campo adulterado derruba a assinatura ou o conteúdo", () => {
    const c = assinado();
    const v = (comprovante: unknown, over = {}) => verificarComprovante({ chavePublica: PUB_PEM, ferramenta: "f", argumentos: args, comprovante, agora: T + 1000, ...over });
    assert.deepEqual(v(undefined), { ok: false, motivo: "ausente" });
    assert.deepEqual(v({ ...c, v: 2 }), { ok: false, motivo: "formato" });
    assert.deepEqual(v(c, { ferramenta: "g" }), { ok: false, motivo: "ferramenta" });
    assert.deepEqual(v(c, { argumentos: { ...args, resumo: "outro" } }), { ok: false, motivo: "argumentos" });
    assert.deepEqual(v(c, { agora: c.exp }), { ok: false, motivo: "vencido" });
    assert.deepEqual(v({ ...c, approval_id: "aprov-0002" }), { ok: false, motivo: "assinatura" });
    assert.deepEqual(v({ ...c, exp: c.exp + 1 }), { ok: false, motivo: "assinatura" });
    assert.deepEqual(v(c, { chavePublica: "lixo" }), { ok: false, motivo: "chave" });
  });

  it("não aceita vencimento longe demais nem chave que não seja Ed25519", () => {
    const longe = assinado({ validadeMs: 10 * 60 * 60_000 });
    assert.ok(longe.exp - T <= 15 * 60_000, "a validade é limitada a 15 min");
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    assert.throws(() => assinado({ chavePrivada: rsa.privateKey.export({ format: "pem", type: "pkcs8" }) }), /Ed25519/);
    assert.throws(() => assinado({ approvalId: "x" }), /approval_id/);
  });
});
