// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { CloudSimulator } from "./cloud-simulator.ts";
import { APP_DEMO } from "./adaptador-falso.ts";

test("isolated device lifecycle and independent screens", async () => {
  const sim = new CloudSimulator(["a", "b"]);
  await assert.rejects(sim.iniciar("unknown"));
  await assert.rejects(sim.capturar("a"));
  await sim.iniciar("a");
  await sim.iniciar("b");
  await assert.rejects(sim.iniciar("a"));
  await sim.executar("a", { tipo: "abrir_app", app: APP_DEMO });
  assert.equal((await sim.capturar("a")).app, APP_DEMO);
  assert.equal((await sim.capturar("b")).app, "launcher");
  await assert.rejects(sim.executar("a", { tipo: "abrir_app", app: "com.whatsapp" }));
  await sim.encerrar("a");
  await sim.encerrar("a");
  await assert.rejects(sim.capturar("a"));
  assert.equal((await sim.capturar("b")).app, "launcher");
});

test("provider failures are visible and do not silently succeed", async () => {
  const sim = new CloudSimulator(["a"]);
  sim.failNext("start");
  await assert.rejects(sim.iniciar("a"));
  await assert.rejects(sim.capturar("a"));
  await sim.iniciar("a");
  sim.failNext("capture");
  await assert.rejects(sim.capturar("a"));
  sim.failNext("execute");
  await assert.rejects(sim.executar("a", { tipo: "abrir_app", app: APP_DEMO }));
  assert.equal((await sim.capturar("a")).app, "launcher");
  sim.failNext("stop");
  await assert.rejects(sim.encerrar("a"));
  assert.equal((await sim.capturar("a")).app, "launcher");
  await sim.encerrar("a");
  await assert.rejects(sim.capturar("a"));
});
