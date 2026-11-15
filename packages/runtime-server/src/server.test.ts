// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { createReadinessServer } from "./server.ts";
test("liveness only; no execution endpoints", async () => {
  const server = createReadinessServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const addr = server.address();
    assert.ok(addr && typeof addr !== "string");
    const url = `http://127.0.0.1:${addr.port}`;
    const live = await fetch(url + "/health/live");
    assert.equal(live.status, 200);
    assert.deepEqual(await live.json(), { status: "ok" });
    assert.equal(live.headers.get("cache-control"), "no-store");
    assert.equal((await fetch(url + "/agents/execute", { method: "POST" })).status, 404);
    assert.equal((await fetch(url + "/payments", { method: "POST" })).status, 404);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
