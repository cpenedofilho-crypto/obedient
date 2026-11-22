// SPDX-License-Identifier: AGPL-3.0-only
// O shim de node:crypto do app dá o mesmo resultado que o node:crypto de verdade.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as real from "node:crypto";
import { createHash, randomUUID, timingSafeEqual } from "./node-crypto.ts";

describe("node:crypto shim", () => {
  it("sha256 hex matches Node for empty, ASCII, UTF-8 and block-boundary inputs", () => {
    const entradas = ["", "abc", "consentimento específico ♥", "a".repeat(55), "a".repeat(56), "a".repeat(64), "x".repeat(1000)];
    for (const t of entradas) assert.equal(createHash("sha256").update(t, "utf8").digest("hex"), real.createHash("sha256").update(t, "utf8").digest("hex"), t.slice(0, 20));
  });
  it("chunked updates equal a single update", () => {
    assert.equal(createHash("sha256").update("ab").update("c").digest("hex"), real.createHash("sha256").update("abc").digest("hex"));
  });
  it("randomUUID is a v4 UUID", () => {
    assert.match(randomUUID(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it("timingSafeEqual compares and refuses different lengths like Node", () => {
    assert.equal(timingSafeEqual(Uint8Array.from([1, 2]), Uint8Array.from([1, 2])), true);
    assert.equal(timingSafeEqual(Uint8Array.from([1, 2]), Uint8Array.from([1, 3])), false);
    assert.throws(() => timingSafeEqual(Uint8Array.from([1]), Uint8Array.from([1, 2])));
  });
  it("refuses algorithms the app does not ship", () => {
    assert.throws(() => createHash("md5"));
  });
});
