// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
// Pasta dos arquivos do catálogo real (F4) na área de documentos do app, e o download por fetch.
import { Directory, File, Paths } from "expo-file-system";
import type { Baixar, PastaDeArquivos } from "../catalogo/arquivos.ts";
import { BYTES_MAXIMOS_POR_ARQUIVO } from "../catalogo/remoto.ts";

export function pastaDoCatalogo(): PastaDeArquivos {
  const pasta = new Directory(Paths.document, "musica-catalogo");
  const garantir = () => { if (!pasta.exists) pasta.create({ intermediates: true, idempotent: true }); };
  return {
    async listar() { garantir(); return pasta.list().filter((x): x is File => x instanceof File).map((f) => f.name); },
    async ler(nome) { const f = new File(pasta, nome); return f.exists ? f.bytes() : null; },
    async gravar(nome, bytes) { garantir(); const f = new File(pasta, nome); f.create({ overwrite: true }); await f.write(bytes); },
    async apagar(nome) { const f = new File(pasta, nome); if (f.exists) f.delete(); },
    uri(nome) { return new File(pasta, nome).uri; },
  };
}

export const baixarComFetch: Baixar = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download falhou: HTTP ${r.status}`);
  const tamanho = Number(r.headers.get("content-length") ?? "0");
  if (tamanho > BYTES_MAXIMOS_POR_ARQUIVO) throw new Error("arquivo grande demais");
  return new Uint8Array(await r.arrayBuffer());
};
