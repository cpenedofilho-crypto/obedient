// SPDX-License-Identifier: AGPL-3.0-only
// Protege as instruções de engenharia contra remoção acidental.
// Não substitui revisão de código, Ethics Engine ou branch protection.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ler = (arquivo: string) => readFileSync(new URL(`../../${arquivo}`, import.meta.url), "utf8");

test("documentos normativos e instruções de agentes permanecem presentes", () => {
  const constituicao = ler("CONSTITUTION.md");
  const norma = ler("docs/engineering/OBEDIENT_ENGINEERING_STANDARD.md");
  const agentes = ler("AGENTS.md");
  const claude = ler("CLAUDE.md");
  assert.ok(constituicao.length > 100, "Constituição ausente ou vazia");
  assert.match(norma, /Objetivo inegociável/);
  assert.match(norma, /Sem motores duplicados/);
  assert.match(norma, /Autoridade verificável/);
  assert.match(norma, /Gates para alterações/);
  assert.match(agentes, /CONSTITUTION\.md/);
  assert.match(agentes, /OBEDIENT_ENGINEERING_STANDARD\.md/);
  assert.match(claude, /AGENTS\.md/);
  assert.match(claude, /OBEDIENT_ENGINEERING_STANDARD\.md/);
});

test("norma não permite que documentação conceda autoridade", () => {
  const norma = ler("docs/engineering/OBEDIENT_ENGINEERING_STANDARD.md");
  assert.match(norma, /não concede permissões/i);
  assert.match(norma, /Ethics Engine/);
  assert.match(norma, /Antes do deploy/);
});
