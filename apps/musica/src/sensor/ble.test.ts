// SPDX-License-Identifier: AGPL-3.0-only
// Sensor BLE com um rádio falso: filtro por serviço, leitura dos pacotes, reconexão e parada.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AmostraSinal } from "@obedient/music-contracts";
import { base64ParaBytes, bytesParaBase64 } from "./base64.ts";
import { type AparelhoBle, type GerenteBle, MEDICAO_FC, procurarCintas, SensorBle, SERVICO_FC, TENTATIVAS_RECONEXAO } from "./ble.ts";

const pacote = (bpm: number, rr?: number) => bytesParaBase64(Uint8Array.from(rr === undefined ? [0x06, bpm] : [0x16, bpm, rr & 0xff, rr >> 8]));

class RadioFalso implements GerenteBle {
  conexoes = 0;
  desconexoes = 0;
  falharConexoes = 0;
  servicosProcurados: string[] = [];
  private aoValor: ((b: string) => void) | null = null;
  private aoFim: ((e: Error | null) => void) | null = null;
  async ligado() { return true; }
  procurar(servicos: string[], aoAchar: (a: AparelhoBle) => void) {
    this.servicosProcurados = servicos;
    aoAchar({ id: "cinta-1", nome: "Cinta" });
    aoAchar({ id: "cinta-1", nome: "Cinta" });
    return () => undefined;
  }
  async conectar() {
    if (this.falharConexoes > 0) { this.falharConexoes--; throw new Error("fora de alcance"); }
    this.conexoes++;
  }
  monitorar(_id: string, s: string, c: string, aoValor: (b: string) => void, aoFim: (e: Error | null) => void) {
    assert.equal(s, SERVICO_FC);
    assert.equal(c, MEDICAO_FC);
    this.aoValor = aoValor;
    this.aoFim = aoFim;
    return () => { this.aoValor = null; };
  }
  async desconectar() { this.desconexoes++; }
  enviar(b64: string) { this.aoValor?.(b64); }
  cair() { this.aoFim?.(new Error("desconectou")); }
}

const semEspera = async () => undefined;
const tick = () => new Promise((r) => setImmediate(r));

async function coletar(sensor: SensorBle, ctrl: AbortController, n: number): Promise<AmostraSinal[]> {
  const saida: AmostraSinal[] = [];
  for await (const a of sensor.amostras(ctrl.signal)) {
    saida.push(a);
    if (saida.length >= n) ctrl.abort();
  }
  return saida;
}

describe("base64", () => {
  it("round-trips any bytes and refuses garbage", () => {
    for (const b of [[], [0], [1, 2], [0x16, 72, 0, 4], Array.from({ length: 20 }, (_, i) => i * 13)])
      assert.deepEqual([...base64ParaBytes(bytesParaBase64(Uint8Array.from(b)))], b);
    assert.throws(() => base64ParaBytes("@@@"));
  });
});

describe("procurarCintas", () => {
  it("scans only for the Heart Rate Service and de-duplicates", async () => {
    const r = new RadioFalso();
    assert.deepEqual(await procurarCintas(r, 10, semEspera), [{ id: "cinta-1", nome: "Cinta" }]);
    assert.deepEqual(r.servicosProcurados, [SERVICO_FC]);
  });
});

describe("SensorBle", () => {
  it("turns packets into samples (bpm, RR, contact) and bad packets into samples without bpm", async () => {
    const r = new RadioFalso();
    let t = 0;
    const sensor = new SensorBle("cinta-1", r, () => (t += 1000), semEspera);
    const ctrl = new AbortController();
    const coleta = coletar(sensor, ctrl, 3);
    await tick();
    r.enviar(pacote(72));
    r.enviar(pacote(80, 1024));
    r.enviar("@@@");
    const a = await coleta;
    assert.deepEqual(a, [
      { t: 1000, fonte: "ble_hrs", bpm: 72, contato: true },
      { t: 2000, fonte: "ble_hrs", bpm: 80, rrMs: [1000], contato: true },
      { t: 3000, fonte: "ble_hrs" },
    ]);
    assert.equal(r.desconexoes, 1);
  });

  it("reconnects after a drop and keeps reading", async () => {
    const r = new RadioFalso();
    const sensor = new SensorBle("cinta-1", r, () => 0, semEspera);
    const ctrl = new AbortController();
    const coleta = coletar(sensor, ctrl, 2);
    await tick();
    r.enviar(pacote(90));
    await tick();
    r.cair();
    await tick(); await tick();
    r.enviar(pacote(91));
    const a = await coleta;
    assert.deepEqual(a.map((x) => x.bpm), [90, 91]);
    assert.equal(r.conexoes, 2);
  });

  it("gives up after the retry limit instead of looping forever", async () => {
    const r = new RadioFalso();
    r.falharConexoes = TENTATIVAS_RECONEXAO + 1;
    const esperas: number[] = [];
    const sensor = new SensorBle("cinta-1", r, () => 0, async (ms) => { esperas.push(ms); });
    const a = await coletar(sensor, new AbortController(), 1);
    assert.equal(a.length, 0);
    assert.deepEqual(esperas, [1000, 2000, 4000, 8000, 16000]);
  });

  it("abort stops immediately and disconnects", async () => {
    const r = new RadioFalso();
    const sensor = new SensorBle("cinta-1", r, () => 0, semEspera);
    const ctrl = new AbortController();
    const coleta = coletar(sensor, ctrl, 99);
    await tick();
    ctrl.abort();
    assert.deepEqual(await coleta, []);
    assert.equal(r.desconexoes, 1);
  });
});
