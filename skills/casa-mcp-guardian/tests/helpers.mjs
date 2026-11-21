// SPDX-License-Identifier: AGPL-3.0-only
// Test helpers. Fake credentials are generated at run time (never committed: the repository's secret
// scanner would flag them, and a committed "fake" is indistinguishable from a real one).
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CLI = join(SKILL_DIR, "scripts", "mcp-guardian.mjs");

const alnum = (n) => randomBytes(n * 2).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, n);

/** Credentials with real-world shapes and random bodies. */
export function fakeSecrets() {
  return {
    anthropic: `sk-ant-${alnum(48)}`,
    github: `ghp_${alnum(36)}`,
    aws: `AKIA${alnum(16).toUpperCase().replace(/[^A-Z0-9]/g, "Q").padEnd(16, "Q").slice(0, 16)}`,
    jwt: `eyJ${alnum(20)}.eyJ${alnum(24)}.${alnum(30)}`,
    plain: `pw${alnum(10)}9x`, // no known shape: only its key name gives it away
    urlPass: `p${alnum(14)}`,
  };
}

/**
 * Deterministic synthetic secrets of UNKNOWN format (no known prefix): a fixed-seed generator, so the
 * tests never flake. Kinds: hex, base64url, lower+digits, mixed case+digits, letters only.
 * @param {number} seed
 */
export function syntheticTokens(seed = 1, len = 40) {
  let x = seed >>> 0 || 1;
  const next = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; };
  const pick = (/** @type {string} */ abc) => Array.from({ length: len }, () => abc[next() % abc.length]).join("");
  const L = "abcdefghijklmnopqrstuvwxyz", U = L.toUpperCase(), D = "0123456789";
  return {
    hex: pick("0123456789abcdef"), base64url: pick(L + U + D + "-_"), alnum: pick(L + D), mixed: pick(L + U + D), letters: pick(L + U),
  };
}

/** Temporary folder with the given files (relative path -> string or object). */
export function tempProject(files) {
  const dir = mkdtempSync(join(tmpdir(), "mcp-guardian-test-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}

/** Every substring of length `n` of `secret` (a leak of part of a credential is still a leak). */
export function fragments(secret, n = 8) {
  const out = [];
  for (let i = 0; i + n <= secret.length; i++) out.push(secret.slice(i, i + n));
  return out;
}

export const ESC = String.fromCharCode(27);
export const ZWSP = String.fromCharCode(0x200b);
export const RLO = String.fromCharCode(0x202e);
export const BEL = String.fromCharCode(7);
