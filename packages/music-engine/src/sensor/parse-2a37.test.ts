// SPDX-License-Identifier: AGPL-3.0-only
// Leitura da Heart Rate Measurement (0x2A37): cada combinação de flags.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { lerMedicaoFc } from "./parse-2a37.ts";

const ok = (bytes: number[]) => {
  const r = lerMedicaoFc(Uint8Array.from(bytes));
  assert.ok(r.ok, JSON.stringify(r));
  return r.medicao;
};

describe("lerMedicaoFc (0x2A37)", () => {
  it("reads uint8 bpm with no optional fields", () => {
    assert.deepEqual(ok([0x00, 72]), { bpm: 72, contato: undefined, energiaKj: undefined, rrMs: [] });
  });

  it("reads uint16 little-endian bpm", () => {
    assert.equal(ok([0x01, 0x2c, 0x01]).bpm, 300);
  });

  it("reports skin contact only when the sensor supports it", () => {
    assert.equal(ok([0x06, 80]).contato, true); // suportado + detectado
    assert.equal(ok([0x04, 80]).contato, false); // suportado, sem contato
    assert.equal(ok([0x02, 80]).contato, undefined); // bit 1 sem bit 2 não vale
  });

  it("reads energy and several RR intervals converting 1/1024 s to ms", () => {
    // flags: energia (0x08) + RR (0x10); bpm 60; energia 0x0102 = 258 kJ; RR 1024 e 512
    const m = ok([0x18, 60, 0x02, 0x01, 0x00, 0x04, 0x00, 0x02]);
    assert.equal(m.energiaKj, 258);
    assert.deepEqual(m.rrMs, [1000, 500]);
  });

  it("refuses short packets and odd RR bytes instead of guessing", () => {
    assert.deepEqual(lerMedicaoFc(Uint8Array.from([0x00])), { ok: false, codigo: "pacote_curto" });
    assert.deepEqual(lerMedicaoFc(Uint8Array.from([0x01, 0x40])), { ok: false, codigo: "pacote_curto" });
    assert.deepEqual(lerMedicaoFc(Uint8Array.from([0x08, 60, 0x01])), { ok: false, codigo: "pacote_curto" });
    assert.deepEqual(lerMedicaoFc(Uint8Array.from([0x10, 60, 0x00, 0x04, 0x01])), { ok: false, codigo: "rr_impar" });
  });
});
