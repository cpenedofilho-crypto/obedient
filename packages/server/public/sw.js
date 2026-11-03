// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Service worker: mantém o app ABRINDO sem rede. Só isso.
//
// O que NÃO está aqui, de propósito (mesma decisão do Ronda): cache de dados da API. O painel e a
// fila de ações moram no IndexedDB, sob controle do app. Cachear resposta de API aqui criaria uma
// segunda fonte de verdade offline, e um pedido aprovado poderia "voltar" para a tela.

const VERSAO = "obedient-casca-1";
const CASCA = ["/", "/index.html", "/app.js", "/fila.js", "/armazem-idb.js", "/passkey.js", "/estilo.css", "/manifest.webmanifest", "/icone.svg", "/icone-192.png", "/icone-512.png"];

self.addEventListener("install", (ev) => {
  ev.waitUntil(caches.open(VERSAO).then((c) => c.addAll(CASCA)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (ev) => {
  ev.waitUntil(
    caches
      .keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== VERSAO).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (ev) => {
  const url = new URL(ev.request.url);
  if (ev.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  // Rede primeiro (a versão nova chega na próxima abertura); sem rede, a casca guardada.
  ev.respondWith(
    fetch(ev.request)
      .then((r) => {
        if (r.ok && CASCA.includes(url.pathname)) {
          const copia = r.clone();
          void caches.open(VERSAO).then((c) => c.put(ev.request, copia));
        }
        return r;
      })
      .catch(async () => (await caches.match(ev.request)) ?? (ev.request.mode === "navigate" ? await caches.match("/index.html") : undefined) ?? Response.error()),
  );
});
