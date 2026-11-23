// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SyntheticDesktop } from "./synthetic.ts";

function setup() {
  let time = 1000;
  const engine = new SyntheticDesktop(() => time);
  engine.register({ id: "vm-a", tenantId: "a", environment: "isolated", allowedApps: ["demo.app"], active: true });
  return { engine, tick: (ms: number) => { time += ms; } };
}
const yes = async () => true;
describe("desktop synthetic: fail closed", () => {
  it("isolates tenants", () => {
    const { engine } = setup();
    assert.throws(() => engine.start("b", "vm-a"), /device_unavailable/);
    const s = engine.start("a", "vm-a");
    assert.throws(() => engine.observe("b", s.id), /session_not_found/);
  });
  it("requires explicit approval and prevents replay", async () => {
    const { engine } = setup();
    const s = engine.start("a", "vm-a");
    const obs = engine.observe("a", s.id);
    const p = engine.propose("a", s.id, obs.id, { operation: "app.launch", target: "demo.app" });
    await assert.rejects(engine.execute("a", p.id, async () => false), /approval_required/);
    await assert.rejects(engine.execute("a", p.id, yes), /proposal_unavailable/);
  });
  it("rejects a changed screen and stale observation", async () => {
    const { engine } = setup();
    const s = engine.start("a", "vm-a");
    const first = engine.observe("a", s.id);
    const p = engine.propose("a", s.id, first.id, { operation: "app.launch", target: "demo.app" });
    engine.observe("a", s.id);
    await assert.rejects(engine.execute("a", p.id, yes), /screen_changed/);
  });
  it("rejects expired proposals", async () => {
    const { engine, tick } = setup();
    const s = engine.start("a", "vm-a");
    const obs = engine.observe("a", s.id);
    const p = engine.propose("a", s.id, obs.id, { operation: "app.launch", target: "demo.app" });
    tick(60_000);
    await assert.rejects(engine.execute("a", p.id, yes), /screen_changed/);
  });
  it("never exports a real file", async () => {
    const { engine } = setup();
    const s = engine.start("a", "vm-a");
    const first = engine.observe("a", s.id);
    const p1 = engine.propose("a", s.id, first.id, { operation: "app.launch", target: "demo.app" });
    assert.equal((await engine.execute("a", p1.id, yes)).status, "synthetic_only");
    const obs = engine.observe("a", s.id);
    const p2 = engine.propose("a", s.id, obs.id, { operation: "file.export", target: "synthetic.pdf" });
    const result = await engine.execute("a", p2.id, yes);
    assert.equal(result.artifact?.name, "synthetic.pdf");
    assert.equal(result.artifact?.sha256.length, 64);
  });
  it("revocation stops future operations", async () => {
    const { engine } = setup();
    const s = engine.start("a", "vm-a");
    const obs = engine.observe("a", s.id);
    const p = engine.propose("a", s.id, obs.id, { operation: "app.launch", target: "demo.app" });
    engine.stop("a", s.id);
    await assert.rejects(engine.execute("a", p.id, yes), /proposal_unavailable/);
  });
});
