// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { assinarComprovante } from "@obedient/integration-gateway";
import { DESKTOP_EXECUTE_TOOL, requireSignedApproval, type DesktopProof } from "./signed-approval.ts";
const keys = generateKeyPairSync("ed25519");
const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const args: DesktopProof = { proposal_id: "proposal-000001", session_id: "session-000001", screen_hash: "hash-a", resumo: "export synthetic.pdf" };
const request = { proposalId: args.proposal_id, sessionId: args.session_id, screenHash: args.screen_hash, summary: args.resumo };
describe("desktop signed approval", () => {
  it("accepts a valid signed proof", async () => {
    const proof = assinarComprovante({ chavePrivada: privateKey, ferramenta: DESKTOP_EXECUTE_TOOL, argumentos: args, approvalId: "approval-000001", agora: 1000 });
    assert.equal(await requireSignedApproval({ publicKey, proof, arguments: args, now: 2000 })(request), true);
  });
  it("rejects missing and forged proof", async () => {
    assert.equal(await requireSignedApproval({ publicKey, proof: undefined, arguments: args, now: 2000 })(request), false);
    const proof = assinarComprovante({ chavePrivada: privateKey, ferramenta: DESKTOP_EXECUTE_TOOL, argumentos: args, approvalId: "approval-000001", agora: 1000 });
    assert.equal(await requireSignedApproval({ publicKey, proof: { ...proof, assinatura: "bad" }, arguments: args, now: 2000 })(request), false);
  });
  it("rejects argument changes and expiry", async () => {
    const proof = assinarComprovante({ chavePrivada: privateKey, ferramenta: DESKTOP_EXECUTE_TOOL, argumentos: args, approvalId: "approval-000001", agora: 1000 });
    assert.equal(await requireSignedApproval({ publicKey, proof, arguments: { ...args, resumo: "altered" }, now: 2000 })(request), false);
    assert.equal(await requireSignedApproval({ publicKey, proof, arguments: args, now: 400_000 })(request), false);
  });
});
