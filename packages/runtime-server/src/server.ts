// SPDX-License-Identifier: AGPL-3.0-only
// Minimal, non-operational HTTP readiness service. No agent tools or payments exposed.
import { createServer, type Server } from "node:http";

export function createReadinessServer(): Server {
  return createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (req.method === "GET" && req.url === "/health/live") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
}
export function startReadinessServer(): Server {
  const raw = process.env.PORT ?? "8080";
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid PORT");
  const host = process.env.HOST ?? "127.0.0.1";
  const server = createReadinessServer();
  server.listen(port, host);
  const shutdown = () => server.close();
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  return server;
}
