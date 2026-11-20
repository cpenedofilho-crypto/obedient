// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Saúde, prontidão e métricas (decisão D20, marco M5; G8).
//
//   • GET /health: o processo responde, e com qual versão do código (M7: o commit que o deploy
//     publicou, para conferir de fora que o deploy chegou). Não toca o banco;
//   • GET /ready: o banco responde e todas as migrations do código estão aplicadas, com o mesmo
//     conteúdo. 503 com o motivo curto se não; nunca a mensagem de erro do banco;
//   • GET /metrics: formato de texto do Prometheus, só números somados sobre todas as pessoas. Fecha
//     por padrão: sem OBEDIENT_METRICAS_TOKEN configurado a rota nem existe (404), e com ele exige
//     Authorization: Bearer <token>, comparado em tempo constante.
//
// Os "alertas" são medidores 0/1 com limiares fixos; quem avisa alguém é a infraestrutura que lê as
// métricas (decisão A4, marco M7), não este processo.

import { createHash, timingSafeEqual } from "node:crypto";
import type { Clock } from "@obedient/core";
import { type Database, type Metricas, comoOperador, conferirMigracoes, lerMetricas } from "@obedient/store-postgres";

export interface ConfigSaude {
  /** Token das métricas; ausente = rota desligada. */
  tokenMetricas?: string;
  /** Versão do código em execução (versaoDoAmbiente). Ausente: /health não a mostra. */
  versao?: string | null;
}

/**
 * A versão do código, do ambiente: OBEDIENT_VERSAO, se o dono a definir, ou o commit que o Railway
 * informa ao publicar (RAILWAY_GIT_COMMIT_SHA). Só hexadecimal de 7 a 40, cortado em 12: qualquer outra
 * coisa é ignorada, para o /health nunca repetir texto arbitrário do ambiente.
 */
export function versaoDoAmbiente(env: Record<string, string | undefined> = process.env): string | null {
  for (const k of ["OBEDIENT_VERSAO", "RAILWAY_GIT_COMMIT_SHA"]) {
    const v = env[k]?.trim().toLowerCase();
    if (v && /^[0-9a-f]{7,40}$/.test(v)) return v.slice(0, 12);
  }
  return null;
}

/** Acima disto de missões paradas esperando a pessoa, o medidor de alerta acende. */
export const ALERTA_BLOQUEADAS = 10;

interface RespostaSaude {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const json = (status: number, dados: unknown): RespostaSaude => ({ status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, body: JSON.stringify(dados) });
const texto = (status: number, corpo: string): RespostaSaude => ({ status, headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" }, body: corpo });

const hash = (s: string) => createHash("sha256").update(s).digest();
/** Compara em tempo constante (pelo hash, que tem o mesmo tamanho dos dois lados). */
export function tokenConfere(recebido: string | undefined, esperado: string): boolean {
  const m = /^Bearer\s+(.+)$/i.exec(recebido?.trim() ?? "");
  if (!m || !esperado.trim()) return false;
  return timingSafeEqual(hash(m[1]!.trim()), hash(esperado.trim()));
}

const rotulo = (v: string) => v.replace(/[^a-z_]/g, "_").slice(0, 40);

/** O texto do Prometheus. Rótulos só de listas fechadas (estado, tipo de passo, tipo de alerta). */
export function textoPrometheus(m: Metricas): string {
  const linhas: string[] = [];
  const medidor = (nome: string, ajuda: string, valores: [Record<string, string> | null, number][]) => {
    linhas.push(`# HELP ${nome} ${ajuda}`, `# TYPE ${nome} gauge`);
    for (const [rot, v] of valores) {
      const r = rot ? `{${Object.entries(rot).map(([k, x]) => `${k}="${rotulo(x)}"`).join(",")}}` : "";
      linhas.push(`${nome}${r} ${Number.isFinite(v) ? v : 0}`);
    }
  };
  medidor("obedient_missoes", "Missões por estado.", Object.entries(m.missoesPorEstado).sort().map(([e, n]) => [{ estado: e }, n]));
  medidor("obedient_reservas_vencidas", "Missões com reserva vencida (processo que pode ter caído).", [[null, m.reservasVencidas]]);
  medidor("obedient_aprovacoes_pendentes", "Pedidos de aprovação esperando a pessoa.", [[null, m.aprovacoesPendentes]]);
  medidor("obedient_passos_24h", "Passos gravados nas últimas 24 h, por tipo (recusada = negação; incerto = retomada).", Object.entries(m.passos24hPorTipo).sort().map(([t, n]) => [{ tipo: t }, n]));
  medidor("obedient_gasto_mes_centavos", "Gasto das missões no mês corrente (Brasil), em centavos.", [[null, m.gastoMesCentavos]]);
  medidor("obedient_pessoas_no_teto_mes", "Pessoas que atingiram o teto do mês.", [[null, m.pessoasNoTetoMes]]);
  const bloqueadas = m.missoesPorEstado.blocked ?? 0;
  medidor("obedient_alerta", "Alertas (1 = aceso).", [
    [{ tipo: "parada_geral" }, m.paradaGeral ? 1 : 0],
    [{ tipo: "reserva_vencida" }, m.reservasVencidas > 0 ? 1 : 0],
    [{ tipo: "bloqueadas_acumuladas" }, bloqueadas >= ALERTA_BLOQUEADAS ? 1 : 0],
    [{ tipo: "teto_do_mes" }, m.pessoasNoTetoMes > 0 ? 1 : 0],
  ]);
  return `${linhas.join("\n")}\n`;
}

/** Atende /health, /ready e /metrics; devolve null para qualquer outro caminho. */
export async function rotaDeSaude(db: Database, cfg: ConfigSaude, clock: Clock, metodo: string, caminho: string, autorizacao: string | undefined): Promise<RespostaSaude | null> {
  if (metodo !== "GET") return null;
  if (caminho === "/health") return json(200, { vivo: true, ...(cfg.versao ? { versao: cfg.versao } : {}) });
  if (caminho === "/ready") {
    try {
      const { pendentes, divergentes } = await comoOperador(db, (tx) => conferirMigracoes(tx));
      if (pendentes.length || divergentes.length) return json(503, { pronto: false, motivo: "migrations", pendentes, divergentes });
      return json(200, { pronto: true });
    } catch {
      return json(503, { pronto: false, motivo: "banco" });
    }
  }
  if (caminho === "/metrics") {
    if (!cfg.tokenMetricas?.trim()) return texto(404, "não existe\n");
    if (!tokenConfere(autorizacao, cfg.tokenMetricas)) return { ...texto(401, "não autorizado\n"), headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "www-authenticate": "Bearer" } };
    try {
      return texto(200, textoPrometheus(await comoOperador(db, (tx) => lerMetricas(tx, clock.now()))));
    } catch {
      return texto(503, "banco indisponível\n");
    }
  }
  return null;
}
