// SPDX-License-Identifier: AGPL-3.0-only
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SyntheticDesktop } from "@obedient/desktop-control/synthetic";
import { CAMPO_COMPROVANTE, assinarComprovante, classificar } from "@obedient/integration-gateway";
import { createSyntheticDesktopMcp } from "./index.ts";

const pair = generateKeyPairSync("ed25519");
const privateKey = pair.privateKey.export({ format: "pkcs8", type: "pem" }).toString();
const publicKey = pair.publicKey.export({ format: "spki", type: "pem" }).toString();
const tool = "desktop_executar_acao_alta";
async function setup(key?: string) {
  const engine = new SyntheticDesktop();
  engine.register({ id: "demo-vm", tenantId: "org-a", environment: "isolated", allowedApps: ["demo.app"], active: true });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const server = createSyntheticDesktopMcp(engine, "org-a", key);
  await server.connect(serverTransport);
  const client = new Client({ name: "desktop-test", version: "0.1.0" });
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown>, meta?: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) });
    const c = r.content as { type: string; text: string }[];
    return { error: Boolean(r.isError), value: JSON.parse(c[0]!.text) };
  };
  return { client, server, call };
}
describe("desktop MCP synthetic", () => {
  it("declares execution as HIGH risk to the Gateway", async () => {
    const { client } = await setup(publicKey);
    const { tools } = await client.listTools();
    const execute = tools.find(t => t.name === tool)!;
    assert.equal(classificar({ name: execute.name, annotations: execute.annotations ?? {} }).nivel, "HIGH");
  });
  it("requires signed proof, matches proposal and blocks replay", async () => {
    const { call } = await setup(publicKey);
    const s = (await call("desktop_iniciar_sessao", { device_id: "demo-vm" })).value;
    const o = (await call("desktop_observar_tela", { session_id: s.id })).value.conteudo_externo;
    const p = (await call("desktop_propor_acao", { session_id: s.id, observation_id: o.id, operacao: "app.launch", alvo: "demo.app" })).value;
    const args = { proposta_id: p.id, resumo: p.summary, session_id: s.id, screen_hash: o.screenHash };
    assert.equal((await call(tool, args)).error, true);
    const proof = assinarComprovante({ chavePrivada: privateKey, ferramenta: tool, argumentos: args, approvalId: "approval-000001" });
    const meta = { [CAMPO_COMPROVANTE]: proof };
    assert.equal((await call(tool, args, meta)).error, false);
    assert.equal((await call(tool, args, meta)).error, true);
  });
  it("fails closed when no public key is configured", async () => {
    const { call } = await setup();
    const s = (await call("desktop_iniciar_sessao", { device_id: "demo-vm" })).value;
    const o = (await call("desktop_observar_tela", { session_id: s.id })).value.conteudo_externo;
    const p = (await call("desktop_propor_acao", { session_id: s.id, observation_id: o.id, operacao: "app.launch", alvo: "demo.app" })).value;
    assert.equal((await call(tool, { proposta_id: p.id, resumo: p.summary, session_id: s.id, screen_hash: o.screenHash })).error, true);
  });
});
