// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
// @ts-check
//
// IndexedDB do app: a fila de ações e a última cópia do painel (para abrir sem rede). Só o dia que
// importa fica aqui; histórico não é guardado no aparelho.

const NOME = "obedient";
const VERSAO = 1;

/** @returns {Promise<IDBDatabase>} */
function abrir() {
  return new Promise((ok, falha) => {
    const r = indexedDB.open(NOME, VERSAO);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains("fila")) db.createObjectStore("fila", { keyPath: "opId" });
      if (!db.objectStoreNames.contains("copia")) db.createObjectStore("copia");
    };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => falha(r.error);
  });
}

/**
 * @template T
 * @param {string} loja
 * @param {IDBTransactionMode} modo
 * @param {(s: IDBObjectStore) => IDBRequest<T>} fazer
 * @returns {Promise<T>}
 */
async function emLoja(loja, modo, fazer) {
  const db = await abrir();
  return new Promise((ok, falha) => {
    const t = db.transaction(loja, modo);
    const req = fazer(t.objectStore(loja));
    t.oncomplete = () => ok(req.result);
    t.onerror = () => falha(t.error);
    t.onabort = () => falha(t.error);
  });
}

/** @type {import("./fila.js").Armazem} */
export const armazemIdb = {
  get: (id) => emLoja("fila", "readonly", (s) => s.get(id)),
  put: async (op) => {
    await emLoja("fila", "readwrite", (s) => s.put(op));
  },
  all: () => emLoja("fila", "readonly", (s) => s.getAll()),
  delete: async (id) => {
    await emLoja("fila", "readwrite", (s) => s.delete(id));
  },
};

/** Última cópia do painel que veio do servidor, com a hora em que veio. */
export const copiaDoPainel = {
  /** @returns {Promise<{ painel: any, em: number } | undefined>} */
  ler: () => emLoja("copia", "readonly", (s) => s.get("painel")),
  /** @param {any} painel */
  gravar: async (painel) => {
    await emLoja("copia", "readwrite", (s) => s.put({ painel, em: Date.now() }, "painel"));
  },
  apagar: async () => {
    await emLoja("copia", "readwrite", (s) => s.delete("painel"));
  },
};
