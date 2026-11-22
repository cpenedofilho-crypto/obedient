// SPDX-License-Identifier: AGPL-3.0-only
// Mixer de dois canais: agenda na fronteira, corte, crossfade só de volume, parada e fim da faixa.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { type Agenda, type CanalAudio, CROSSFADE_MS, Mixer } from "./mixer.ts";

class CanalFalso implements CanalAudio {
  log: string[] = [];
  vol = 1;
  fim: (() => void) | null = null;
  constructor(readonly nome: string) {}
  async carregar(uri: string) { this.log.push(`carregar ${uri}`); }
  tocar() { this.log.push("tocar"); }
  pausar() { this.log.push("pausar"); }
  volume(v: number) { this.vol = v; }
  aoTerminar(f: () => void) { this.fim = f; }
}

class AgendaFalsa implements Agenda {
  t = 0;
  tarefas: { em: number; f: () => void; ativa: boolean }[] = [];
  agora() { return this.t; }
  depois(ms: number, f: () => void) {
    const tarefa = { em: this.t + ms, f, ativa: true };
    this.tarefas.push(tarefa);
    return () => { tarefa.ativa = false; };
  }
  avancar(ms: number) {
    this.t += ms;
    for (const x of this.tarefas.filter((x) => x.ativa && x.em <= this.t).sort((a, b) => a.em - b.em)) { x.ativa = false; x.f(); }
  }
}

function montar() {
  const a = new CanalFalso("a"), b = new CanalFalso("b");
  const agenda = new AgendaFalsa();
  const sugestoes: string[] = [];
  const mixer = new Mixer([a, b], async (id) => (id === "sem-arquivo" ? null : `file://${id}.wav`), agenda, (id) => sugestoes.push(id));
  return { a, b, agenda, mixer, sugestoes };
}

describe("Mixer", () => {
  it("first track starts at the scheduled time at full volume", async () => {
    const { a, b, agenda, mixer } = montar();
    await mixer.tocar("f1", { emMs: 5000, crossfade: true });
    agenda.avancar(4999);
    assert.ok(!b.log.includes("tocar"));
    agenda.avancar(1);
    assert.deepEqual(b.log, ["carregar file://f1.wav", "tocar"]);
    assert.equal(b.vol, 1);
    assert.deepEqual(a.log, ["pausar"]);
  });

  it("crossfade ramps volume only, then pauses the old channel", async () => {
    const { a, b, agenda, mixer } = montar();
    await mixer.tocar("f1", { emMs: 0, crossfade: false });
    agenda.avancar(0);
    await mixer.tocar("f2", { emMs: 1000, crossfade: true });
    agenda.avancar(1000);
    assert.equal(a.vol, 0);
    agenda.avancar(CROSSFADE_MS / 2);
    assert.ok(a.vol > 0.4 && a.vol < 0.6, String(a.vol));
    assert.ok(b.vol > 0.4 && b.vol < 0.6, String(b.vol));
    agenda.avancar(CROSSFADE_MS);
    assert.equal(a.vol, 1);
    assert.equal(b.vol, 0);
    assert.equal(b.log.at(-1), "pausar");
  });

  it("cut switches at once", async () => {
    const { a, b, agenda, mixer } = montar();
    await mixer.tocar("f1", { emMs: 0, crossfade: false });
    agenda.avancar(0);
    await mixer.tocar("f2", { emMs: 0, crossfade: false });
    agenda.avancar(0);
    assert.equal(b.log.at(-1), "pausar");
    assert.equal(a.log.at(-1), "tocar");
  });

  it("refuses a track with no file on the device; suggestion only notifies", async () => {
    const { mixer, sugestoes, a, b } = montar();
    await assert.rejects(mixer.tocar("sem-arquivo", { emMs: 0, crossfade: false }));
    await mixer.sugerir("f9");
    assert.deepEqual(sugestoes, ["f9"]);
    assert.equal(a.log.length + b.log.length, 0);
  });

  it("stop cancels scheduled switches and pauses both channels", async () => {
    const { a, b, agenda, mixer } = montar();
    await mixer.tocar("f1", { emMs: 10_000, crossfade: false });
    await mixer.parar();
    agenda.avancar(20_000);
    assert.ok(!b.log.includes("tocar"));
    assert.equal(a.log.at(-1), "pausar");
  });

  it("reports when the active track ends by itself", async () => {
    const { b, agenda, mixer } = montar();
    const fins: string[] = [];
    mixer.quandoAcabar((id) => fins.push(id));
    await mixer.tocar("f1", { emMs: 0, crossfade: false });
    agenda.avancar(0);
    b.fim?.();
    assert.deepEqual(fins, ["f1"]);
  });
});
