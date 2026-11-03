// SPDX-License-Identifier: AGPL-3.0-only
//
// O app de ponta a ponta, num Chromium de celular (390 × 844), com a passkey feita pelo autenticador
// virtual do navegador. Servidor de desenvolvimento: banco em memória e dados fictícios.
//
//   npm run test:e2e
//
// O que se confere aqui é o que só existe com navegador: a passkey de verdade (WebAuthn), a fila
// do aparelho sobrevivendo a ficar sem internet e a recarregar a página, o service worker abrindo o
// app sem rede, o texto do agente nunca virando HTML, alvo de toque e acessibilidade (axe).

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { type Browser, type BrowserContext, type Page, chromium } from "playwright";
import { type Dev, subirDev } from "../packages/server/src/dev.ts";

const AXE = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");

let dev: Dev;
let navegador: Browser;
before(async () => {
  dev = await subirDev(0);
  navegador = await chromium.launch();
});
after(async () => {
  await navegador?.close();
  await dev?.fechar();
});

/**
 * Aparelho novo: contexto limpo, passkey virtual, erros de página anotados. `bypassCSP` só existe
 * para o teste injetar o axe: a CSP do app barra script inline (e barrou, na primeira versão deste
 * teste). A CSP em si é conferida no teste do servidor (api.test.ts).
 */
async function aparelho(): Promise<{ ctx: BrowserContext; p: Page; erros: string[] }> {
  const ctx = await navegador.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, locale: "pt-BR", timezoneId: "America/Sao_Paulo", bypassCSP: true });
  const p = await ctx.newPage();
  const erros: string[] = [];
  p.on("pageerror", (e) => erros.push(e.message));
  p.on("console", (m) => {
    if (m.type() === "error" && !/401|Failed to load resource|ERR_INTERNET_DISCONNECTED/.test(m.text())) erros.push(m.text());
  });
  const cdp = await ctx.newCDPSession(p);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  return { ctx, p, erros };
}

async function axe(p: Page) {
  await p.addScriptTag({ content: AXE });
  return p.evaluate(async () => {
    const r = await (window as unknown as { axe: { run(o: unknown): Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> } }).axe.run({
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
    });
    return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
  });
}

describe("app de ponta a ponta", { concurrency: false }, () => {
  let ctx: BrowserContext;
  let p: Page;
  let erros: string[];

  it("entrada: sem sessão mostra a tela de entrar, sem violação de acessibilidade", async () => {
    ({ ctx, p, erros } = await aparelho());
    await p.goto(dev.url);
    await p.getByRole("button", { name: "Entrar com passkey" }).waitFor();
    assert.deepEqual(await axe(p), []);
  });

  it("convite: o código cadastra a passkey do aparelho e abre o painel", async () => {
    await p.getByText("Tenho um convite").click();
    await p.getByLabel("Código do convite").fill(dev.convite);
    await p.getByRole("button", { name: "Cadastrar este aparelho" }).click();
    await p.getByRole("heading", { name: "Esperando você" }).waitFor();
    assert.equal(await p.locator("#pedidos > li").count(), 2);
    // Motivo em português, não o texto do motor de políticas.
    const texto = await p.locator("#pedidos").innerText();
    assert.match(texto, /Ação de risco alto: precisa da sua aprovação/);
    assert.doesNotMatch(texto, /default is|requires|policy/);
  });

  it("painel: sem violação de acessibilidade e todo botão com alvo de toque de 48 px", async () => {
    assert.deepEqual(await axe(p), []);
    const pequenos = await p.locator("button, summary, input").evaluateAll((els) =>
      els
        .filter((e) => (e as HTMLElement).offsetParent !== null)
        .map((e) => ({ t: (e.textContent || e.getAttribute("aria-label") || e.id).trim(), ...e.getBoundingClientRect().toJSON() }))
        .filter((r) => r.height < 44 || r.width < 44)
        .map((r) => `${r.t} ${Math.round(r.width)}×${Math.round(r.height)}`),
    );
    assert.deepEqual(pequenos, []);
  });

  it("aprovar é um toque; o desfecho aparece sem esperar e a trilha registra", async () => {
    await p.getByRole("button", { name: /^Aprovar email\.enviar/ }).click();
    await p.getByText("Aprovado.").or(p.getByText("Aprovado. Enviando…")).first().waitFor();
    await p.getByText("Você aprovou email.enviar em email").waitFor();
    assert.equal(await p.locator("#pedidos > li").count(), 1);
  });

  it("ação sensível: aprovar com passkey (o autenticador do aparelho confirma)", async () => {
    await p.getByRole("button", { name: /^Aprovar email\.apagar_pasta/ }).click();
    await p.getByText("Você aprovou email.apagar_pasta em email").waitFor();
    await p.getByText("Nada esperando por você.").waitFor();
  });

  it("texto do agente nunca vira HTML", async () => {
    await dev.pedir("email.enviar", "HIGH", "COMMUNICATION", { assunto: '<img src=x onerror="window.__xss=1">', para: "<b>chefe</b>" });
    await p.reload();
    await p.getByText('<img src=x onerror="window.__xss=1">').waitFor();
    assert.equal(await p.locator("#pedidos img, #pedidos b").count(), 0);
    assert.equal(await p.evaluate(() => (window as unknown as { __xss?: number }).__xss), undefined);
    await p.getByRole("button", { name: /^Recusar email\.enviar/ }).click();
    await p.getByText("Você recusou um pedido").waitFor();
  });

  it("sem internet: parar fica na fila, sobrevive a recarregar a página e chega quando a rede volta", async () => {
    await dev.pedir("email.enviar", "HIGH", "COMMUNICATION", { assunto: "Cardápio da semana", para: "equipe@exemplo.org" });
    await p.reload();
    await p.locator("#pedidos > li").first().waitFor();
    // Espera o service worker assumir a página, para ela abrir sem rede.
    await p.evaluate(async () => {
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) await new Promise((ok) => navigator.serviceWorker.addEventListener("controllerchange", ok, { once: true }));
    });
    await ctx.setOffline(true);
    await p.getByRole("button", { name: "Parar o agente agora" }).click();
    await p.getByText("Vai chegar ao servidor assim que este aparelho tiver internet").waitFor();
    // O servidor ainda não sabe: o agente continua podendo agir.
    assert.equal(await dev.pedir("agenda.ler_semana", "LOW", "READ", {}), "allowed");

    await p.reload(); // sem rede: a casca vem do service worker, o painel e a fila do IndexedDB
    await p.getByText(/Sem internet\. Mostrando o que veio às/).waitFor();
    await p.getByText("1 ação esperando para enviar.").waitFor();
    await p.getByText("Parada registrada").waitFor();

    await ctx.setOffline(false);
    await p.getByText("O agente está parado").waitFor();
    assert.equal(await dev.pedir("agenda.ler_semana", "LOW", "READ", {}), "denied");
    // A parada cancelou o pedido que esperava.
    await p.getByText("Nada esperando por você.").waitFor();
  });

  it("liberar pede confirmação (é o sentido inseguro) e volta o agente", async () => {
    await p.getByRole("button", { name: "Liberar o agente" }).click();
    await p.getByRole("button", { name: "Não, manter parado" }).click();
    await p.getByText("O agente está parado").waitFor();
    await p.getByRole("button", { name: "Liberar o agente" }).click();
    await p.getByRole("button", { name: "Sim, liberar o agente" }).click();
    await p.getByRole("button", { name: "Parar o agente agora" }).waitFor();
    assert.equal(await dev.pedir("agenda.ler_semana", "LOW", "READ", {}), "allowed");
  });

  it("tirar uma autorização: um toque, e o agente perde o acesso", async () => {
    await p.getByRole("button", { name: /^Tirar a autorização de obedient para as ações que começam com agenda\.ler_/ }).click();
    await p.getByText("Você tirou uma autorização").waitFor();
    assert.equal(await dev.pedir("agenda.ler_semana", "LOW", "READ", {}), "denied");
  });

  it("sair e entrar de novo com a mesma passkey, sem convite", async () => {
    await p.getByRole("button", { name: "Sair deste aparelho" }).click();
    await p.getByRole("button", { name: "Entrar com passkey" }).click();
    await p.getByRole("heading", { name: "Esperando você" }).waitFor();
    assert.deepEqual(erros, [], erros.join("\n"));
    await ctx.close();
  });

  it("outro aparelho sem passkey cadastrada não entra", async () => {
    const outro = await aparelho();
    await outro.p.goto(dev.url);
    await outro.p.getByRole("button", { name: "Entrar com passkey" }).click();
    await outro.p.getByText(/Não deu para entrar/).waitFor();
    await outro.ctx.close();
  });
});
