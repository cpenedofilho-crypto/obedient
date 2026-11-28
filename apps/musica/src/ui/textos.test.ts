// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FASES, MOTIVOS, ZONAS } from "@obedient/music-contracts";
import { FASE, MOTIVO, ZONA } from "./textos.ts";

describe("textos", () => {
  it("every engine reason, zone and phase has a sentence for the person", () => {
    for (const m of MOTIVOS) assert.ok(MOTIVO[m]?.length > 10, m);
    for (const z of ZONAS) assert.ok(ZONA[z], z);
    for (const f of FASES) assert.ok(FASE[f], f);
  });
});
