// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyDesktopAction, validateDesktopProposal, type DesktopObservation, type DesktopProposal } from "./index.ts";

const observation: DesktopObservation = {
  id: "obs-000001", sessionId: "session-000001", screenHash: "hash-a",
  capturedAt: 100, elements: [{ id: "e1", role: "button", label: "Exportar" }],
};
const proposal: DesktopProposal = {
  id: "proposal-000001", sessionId: observation.sessionId,
  observationId: observation.id, screenHash: observation.screenHash,
  operation: "file.export", risk: "HIGH", summary: "Exportar arquivo fictício",
  expiresAt: 500,
};
describe("desktop-control: contrato de segurança", () => {
  it("nega proposta expirada", () => assert.equal(validateDesktopProposal(proposal, observation, 500), "expired"));
  it("nega sessão diferente", () => assert.equal(validateDesktopProposal(proposal, { ...observation, sessionId: "session-000002" }, 200), "wrong_session"));
  it("nega tela alterada", () => assert.equal(validateDesktopProposal(proposal, { ...observation, screenHash: "hash-b" }, 200), "screen_changed"));
  it("nega observação antiga", () => assert.equal(validateDesktopProposal(proposal, { ...observation, id: "obs-000002" }, 200), "screen_changed"));
  it("aceita somente contrato consistente", () => assert.equal(validateDesktopProposal(proposal, observation, 200), "ok"));
  it("classifica escrita como alto risco", () => {
    assert.equal(classifyDesktopAction("element.type"), "HIGH");
    assert.equal(classifyDesktopAction("file.export"), "HIGH");
  });
});
