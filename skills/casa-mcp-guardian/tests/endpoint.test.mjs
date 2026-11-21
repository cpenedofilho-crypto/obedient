// SPDX-License-Identifier: AGPL-3.0-only
// Endpoint assessment: the same address table as validarEndpoint() in the original, as findings.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assessUrl, hostKind } from "../scripts/lib/endpoint.mjs";
import { fakeSecrets, syntheticTokens } from "./helpers.mjs";

const codes = (u) => assessUrl(u).findings.map((f) => f.code);

describe("host kind (normalized by the URL parser)", () => {
  it("loopback, metadata and private addresses, in every spelling", () => {
    for (const u of ["http://127.0.0.1:3000/mcp", "https://localhost/mcp", "https://[::1]/mcp", "https://2130706433/mcp", "https://0x7f000001/mcp", "https://0177.0.0.1/mcp", "https://a.b.localhost/mcp"])
      assert.equal(hostKind(new URL(u).hostname), "loopback", u);
    for (const u of ["https://169.254.169.254/latest", "https://[::ffff:169.254.169.254]/latest", "https://[64:ff9b::a9fe:a9fe]/mcp", "https://[2002:a9fe:a9fe::1]/mcp", "https://[fe80::1]/mcp"])
      assert.equal(hostKind(new URL(u).hostname), "metadata", u);
    for (const u of ["https://10.0.0.5/mcp", "https://192.168.1.1/mcp", "https://172.20.0.1/mcp", "https://100.64.0.1/mcp", "https://198.18.0.1/mcp", "https://192.0.2.10/mcp", "https://224.0.0.1/mcp", "https://[fd12:3456::1]/mcp", "https://[ff02::1]/mcp", "https://[2001:db8::1]/mcp", "https://[::]/mcp"])
      assert.equal(hostKind(new URL(u).hostname), "private", u);
    for (const u of ["https://100.128.0.1/mcp", "https://198.20.0.1/mcp", "https://172.32.0.1/mcp", "https://8.8.8.8/mcp", "https://[2606:4700::1111]/mcp", "https://mcp.example.com/mcp"])
      assert.equal(hostKind(new URL(u).hostname), null, u);
  });
});

describe("findings", () => {
  it("public https: nothing to report", () => assert.deepEqual(codes("https://mcp.example.com/mcp"), []));
  it("plaintext to a public host; plaintext to localhost is fine", () => {
    assert.deepEqual(codes("http://mcp.example.com/mcp"), ["URL_PLAINTEXT"]);
    assert.deepEqual(codes("http://127.0.0.1:3000/mcp"), ["URL_LOOPBACK"]);
  });
  it("metadata is CRITICAL, private is MEDIUM", () => {
    assert.ok(codes("https://169.254.169.254/").includes("URL_METADATA_HOST"));
    assert.equal(assessUrl("https://169.254.169.254/").findings[0]?.severity, "CRITICAL");
    assert.deepEqual(codes("https://10.1.2.3/mcp"), ["URL_PRIVATE_HOST"]);
  });
  it("credentials in the URL and credential-like query parameters; none of them in the display", () => {
    const pass = fakeSecrets().urlPass;
    const a = assessUrl(`https://user:${pass}@mcp.example.com/mcp?api_key=${pass}&x=1`);
    assert.deepEqual(a.findings.map((f) => f.code), ["URL_CREDENTIALS", "URL_SECRET_PARAM"]);
    assert.ok(!a.display.includes(pass) && !a.display.includes("user"), a.display);
    assert.ok(!JSON.stringify(a).includes(pass));
  });
  it("odd protocol and garbage", () => {
    assert.ok(codes("ftp://mcp.example.com").includes("URL_PROTOCOL"));
    assert.deepEqual(codes("not a url"), ["URL_INVALID"]);
    assert.equal(assessUrl("not a url").display, "[unparseable URL]");
  });
});

describe("the path is never shown; a token in it is a finding (T8.1)", () => {
  it("display is protocol//host/ only, with markers for path and query", () => {
    assert.equal(assessUrl("https://mcp.example.com/mcp").display, "https://mcp.example.com/[path omitted]");
    assert.equal(assessUrl("https://mcp.example.com/").display, "https://mcp.example.com/");
    assert.equal(assessUrl("https://mcp.example.com").display, "https://mcp.example.com/");
    assert.equal(assessUrl("https://mcp.example.com:8443/v1/sse?x=1#frag").display, "https://mcp.example.com:8443/[path omitted]?[query omitted]");
  });
  it("webhook-style tokens of unknown format are found on the original path and never shown", () => {
    for (let seed = 1; seed <= 25; seed++) {
      for (const [kind, t] of Object.entries(syntheticTokens(seed, 40))) {
        if (kind === "letters") continue; // letters-only: see the next test
        for (const u of [`https://hooks.example.com/services/T0/B0/${t}`, `https://discord.example.com/api/webhooks/1/${t}`, `https://h.example.com/${t}/mcp`, `https://h.example.com/x/${encodeURIComponent(t)}`]) {
          const a = assessUrl(u);
          assert.ok(a.findings.some((f) => f.code === "URL_SECRET_PATH"), `${kind} seed ${seed}`);
          assert.equal(a.display.includes(t.slice(0, 8)) || a.display.includes(t.slice(-8)), false);
          assert.ok(a.findings.every((f) => !f.detail.includes(t.slice(4, 12))));
        }
      }
    }
  });
  it("a letters-only token may not be found, but is never shown either", () => {
    for (let seed = 1; seed <= 25; seed++) {
      const t = syntheticTokens(seed, 40).letters;
      const a = assessUrl(`https://hooks.example.com/services/${t}`);
      assert.equal(a.display, "https://hooks.example.com/[path omitted]");
    }
  });
  it("ordinary paths are not flagged", () => {
    for (const u of ["https://mcp.example.com/mcp", "https://api.example.com/v1/sse", "https://api.example.com/api/v2/servers/github", "https://a.example.com/my_production_server_2024/mcp", "https://a.example.com/listAllIssuesForRepository", "https://a.example.com/2024-11-17/report", "https://a.example.com/getHTMLContent/index.html"])
      assert.ok(!codes(u).includes("URL_SECRET_PATH"), u);
  });
});

