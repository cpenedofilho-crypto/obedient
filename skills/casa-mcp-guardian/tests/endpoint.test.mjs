// SPDX-License-Identifier: AGPL-3.0-only
// Endpoint assessment: the same address table as validarEndpoint() in the original, as findings.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assessUrl, hostKind } from "../scripts/lib/endpoint.mjs";
import { fakeSecrets } from "./helpers.mjs";

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
