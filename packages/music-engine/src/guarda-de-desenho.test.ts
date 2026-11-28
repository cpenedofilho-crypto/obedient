// SPDX-License-Identifier: AGPL-3.0-only
// Guarda do desenho (D31). O motor foi desenhado para NÃO ter certas peças, por patente, termos de
// serviço e LGPD (docs/governance/music-engine-f0.md). Este teste reprova se alguma aparecer no código
// (comentários não contam). Mudar isto exige nova decisão e novo parecer, não só editar a lista.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = fileURLToPath(new URL("../..", import.meta.url)); // packages/
const PACOTES = ["music-contracts", "music-engine"];

function arquivos(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? arquivos(p) : /\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p) ? [p] : [];
  });
}

/** Tira comentários de linha e de bloco (o código não tem "//" dentro de string). */
function semComentarios(fonte: string): string {
  return fonte.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const PROIBIDOS: readonly [RegExp, string][] = [
  [/humor|mood|psicol|psych|emoc|emotion|(?<!con)sentiment/i, "entrada de humor ou estado psicológico (US 12,681,987)"],
  [/classificador|classifier|modelo_?aprendido|neural|tensorflow|onnx|tflite/i, "classificador aprendido (US 12,681,987)"],
  [/cadencia|cadence|passada|stride/i, "seleção por cadência (família Spotify)"],
  [/timestretch|time_stretch|taxaReproducao|playbackRate|pitch|tempoDaFaixa/i, "alteração do áudio (Google, Valencell, Nike)"],
  [/spotify|apple_?music|musickit/i, "serviço de streaming (D31)"],
  [/grupo|group|multiusuario|sincroniz/i, "sessão de grupo sincronizada (reivindicações 6 e 12)"],
];

describe("design guard (D31)", () => {
  it("the guard itself catches what it should and spares consent", () => {
    const bate = (s: string) => PROIBIDOS.some(([re]) => re.test(s));
    for (const s of ["moodScore", "estadoPsicologico", "cadenciaSpm", "playbackRate", "spotifyId", "sessaoDeGrupo", "classificadorFc"]) assert.ok(bate(s), s);
    for (const s of ["consentimentoVigente", "zonaAlvo", "energia", "fronteirasMs"]) assert.ok(!bate(s), s);
  });

  for (const pacote of PACOTES) {
    it(`${pacote} has no forbidden pieces`, () => {
      for (const arquivo of arquivos(join(raiz, pacote, "src"))) {
        const codigo = semComentarios(readFileSync(arquivo, "utf8"));
        for (const [re, motivo] of PROIBIDOS) assert.doesNotMatch(codigo, re, `${arquivo}: ${motivo}`);
      }
    });

    it(`${pacote} has no runtime dependencies outside the workspace`, () => {
      const pkg = JSON.parse(readFileSync(join(raiz, pacote, "package.json"), "utf8")) as { dependencies?: Record<string, string>; license: string };
      assert.equal(pkg.license, "AGPL-3.0-only");
      for (const nome of Object.keys(pkg.dependencies ?? {})) assert.match(nome, /^@obedient\//);
    });
  }

  it("the device app (apps/musica, F3) has no forbidden pieces either", () => {
    const app = join(raiz, "..", "apps", "musica");
    for (const pasta of ["src", "shims"])
      for (const arquivo of arquivos(join(app, pasta))) {
        const codigo = semComentarios(readFileSync(arquivo, "utf8"));
        for (const [re, motivo] of PROIBIDOS) assert.doesNotMatch(codigo, re, `${arquivo}: ${motivo}`);
      }
    const raizApp = semComentarios(readFileSync(join(app, "App.tsx"), "utf8"));
    for (const [re, motivo] of PROIBIDOS) assert.doesNotMatch(raizApp, re, `App.tsx: ${motivo}`);
  });

  it("imports only workspace packages and node builtins", () => {
    for (const pacote of PACOTES)
      for (const arquivo of arquivos(join(raiz, pacote, "src"))) {
        const imports = [...readFileSync(arquivo, "utf8").matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
        for (const i of imports) assert.ok(i.startsWith(".") || i.startsWith("@obedient/") || i.startsWith("node:"), `${arquivo}: ${i}`);
      }
  });
});
