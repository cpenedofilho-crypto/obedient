// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
// Grava os WAV do catálogo de demonstração no cache do app na primeira vez e devolve o endereço de cada
// um. Nada é baixado: o som é gerado no aparelho (catalogo/wav.ts).
import { Directory, File, Paths } from "expo-file-system";
import { CATALOGO_DEMO } from "../catalogo/demo.ts";
import { gerarWav } from "../catalogo/wav.ts";

export async function prepararArquivosDemo(): Promise<Map<string, string>> {
  const pasta = new Directory(Paths.cache, "musica-demo");
  if (!pasta.exists) pasta.create({ intermediates: true, idempotent: true });
  const uris = new Map<string, string>();
  for (const { faixa, padrao } of CATALOGO_DEMO) {
    const arquivo = new File(pasta, `${faixa.id}.wav`);
    if (!arquivo.exists) {
      arquivo.create({ overwrite: true });
      await arquivo.write(gerarWav(padrao));
    }
    uris.set(faixa.id, arquivo.uri);
  }
  return uris;
}
