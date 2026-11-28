// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Linha de comando da ingestão (D31, F4). Dois passos, de propósito separados:
//
//   npm run musica:ingerir -- rascunho <manifesto.json> <saida.json>
//     Lê o manifesto da entrega, analisa cada WAV mestre, confere a licença e grava o rascunho para
//     revisão. Não fala com rede nenhuma.
//
//   npm run musica:ingerir -- enviar <rascunho.json> --growth-os https://... --confirmo-publicar
//     Publica no catálogo do Growth OS (POST /api/musica/catalogo), faixa a faixa, e sobe o arquivo de
//     distribuição pelo endereço assinado que o Growth OS devolve (conferindo antes que o arquivo é o mesmo
//     do rascunho). Recusa o arquivo
//     inteiro se alguma faixa tiver problema. O token da pessoa com musica:catalogo_gerir vem de
//     GROWTH_OS_TOKEN (nunca de argumento, para não ficar no histórico do terminal).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { coberturaPorFaixa, corpoParaGrowthOs, type EntradaManifesto, montarRascunho, type Rascunho, sha256 } from "./manifesto.ts";

export interface Saida { log(m: string): void; erro(m: string): void }

export async function executar(args: string[], env: Record<string, string | undefined>, saida: Saida, f: typeof fetch = fetch, agora = new Date()): Promise<number> {
  const [comando, ...resto] = args;
  if (comando === "rascunho") {
    const [manifesto, destino] = resto;
    if (!manifesto || !destino) return uso(saida);
    const base = dirname(resolve(manifesto));
    const entradas = JSON.parse(readFileSync(manifesto, "utf8")) as EntradaManifesto[];
    const rascunhos = entradas
      .map((e) => montarRascunho(e, { ler: (c) => new Uint8Array(readFileSync(resolve(base, c))) }, agora.toISOString()))
      .map((r) => ({ ...r, caminhoDistribuicao: resolve(base, r.caminhoDistribuicao) }));
    writeFileSync(destino, `${JSON.stringify(rascunhos, null, 2)}\n`);
    const comProblema = rascunhos.filter((r) => r.problemas.length);
    saida.log(`${rascunhos.length} faixa(s) analisada(s); ${comProblema.length} com problema.`);
    for (const r of comProblema) saida.log(`  ${r.faixa.id}: ${r.problemas.join(", ")}`);
    saida.log(`Cobertura por energia: ${JSON.stringify(coberturaPorFaixa(rascunhos))}`);
    return comProblema.length ? 1 : 0;
  }
  if (comando === "enviar") {
    const arquivo = resto[0];
    const i = resto.indexOf("--growth-os");
    const base = i >= 0 ? resto[i + 1] : undefined;
    if (!arquivo || !base) return uso(saida);
    if (!resto.includes("--confirmo-publicar")) {
      saida.erro("Publicar muda o catálogo da organização. Rode de novo com --confirmo-publicar.");
      return 2;
    }
    if (!/^https:\/\/[^/]+$/.test(base)) { saida.erro("--growth-os precisa ser https://dominio"); return 2; }
    const token = env.GROWTH_OS_TOKEN;
    if (!token) { saida.erro("Defina GROWTH_OS_TOKEN com o token de quem tem musica:catalogo_gerir."); return 2; }
    const rascunhos = JSON.parse(readFileSync(arquivo, "utf8")) as Rascunho[];
    const ruins = rascunhos.filter((r) => r.problemas.length);
    if (ruins.length) { saida.erro(`Nada enviado: ${ruins.length} faixa(s) com problema no rascunho.`); return 1; }
    let falhas = 0;
    for (const r of rascunhos) {
      const resp = await f(`${base}/api/musica/catalogo`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(env.GROWTH_OS_ORGANIZACAO ? { "x-organizacao": env.GROWTH_OS_ORGANIZACAO } : {}) },
        body: JSON.stringify(corpoParaGrowthOs(r)),
      });
      if (!resp.ok) { falhas++; saida.erro(`  ${r.faixa.id}: HTTP ${resp.status} ${await resp.text().catch(() => "")}`.slice(0, 300)); continue; }
      saida.log(`  ${r.faixa.id}: ${resp.status === 201 ? "criada" : "atualizada"}`);
      // Com armazenamento configurado no Growth OS, a resposta traz um endereço assinado para subir o arquivo.
      const corpo = (await resp.json().catch(() => ({}))) as { envio?: { url?: string } | null };
      const destino = corpo.envio?.url;
      if (!destino) { saida.log(`    arquivo não enviado: o Growth OS não devolveu endereço de envio (armazenamento não configurado?)`); continue; }
      const bytes = new Uint8Array(readFileSync(r.caminhoDistribuicao));
      if (sha256(bytes) !== r.arquivo.sha256 || bytes.length !== r.arquivo.bytes) { falhas++; saida.erro(`    ${r.faixa.id}: o arquivo mudou desde o rascunho; gere o rascunho de novo`); continue; }
      const up = await f(destino, { method: "PUT", headers: { "content-type": r.arquivo.formato, "x-upsert": "false" }, body: bytes });
      const texto = up.ok ? "" : await up.text().catch(() => "");
      if (up.ok || /already exists|Duplicate/i.test(texto)) saida.log(`    arquivo enviado (${r.arquivo.bytes} bytes)`);
      else { falhas++; saida.erro(`    ${r.faixa.id}: envio do arquivo HTTP ${up.status} ${texto}`.slice(0, 300)); }
    }
    return falhas ? 1 : 0;
  }
  return uso(saida);
}

function uso(s: Saida): number {
  s.erro("uso: rascunho <manifesto.json> <saida.json> | enviar <rascunho.json> --growth-os https://... --confirmo-publicar");
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  executar(process.argv.slice(2), process.env, { log: console.log, erro: console.error }).then((c) => { process.exitCode = c; });
}
