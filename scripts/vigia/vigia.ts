// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Vigia do servidor (A4, destino dos alertas): confere de fora /health, /ready e os medidores de
// alerta do /metrics. Imprime o que achou e sai com 1 se algo pede atenção. Quem avisa a pessoa é o
// workflow .github/workflows/vigia.yml (abre um issue atribuído a ela, e fecha quando volta ao normal).
//
//   OBEDIENT_URL=https://… [OBEDIENT_METRICAS_TOKEN=…] node scripts/vigia/vigia.ts
//
// Sem dependência: roda com o Node 22 puro. Só lê números e estados; nada de conteúdo das pessoas.

export interface Achado {
  ok: boolean;
  linhas: string[];
}

/** Os alertas acesos no texto do Prometheus: obedient_alerta{tipo="…"} 1. */
export function alertasAcesos(texto: string): string[] {
  const acesos: string[] = [];
  for (const linha of texto.split("\n")) {
    const m = /^obedient_alerta\{tipo="([a-z_]+)"\}\s+([0-9.]+)\s*$/.exec(linha.trim());
    if (m && Number(m[2]) > 0) acesos.push(m[1]!);
  }
  return acesos;
}

const EXPLICA: Record<string, string> = {
  parada_geral: "a parada geral está ligada",
  reserva_vencida: "uma missão tem a reserva vencida (um processo pode ter caído)",
  bloqueadas_acumuladas: "10 ou mais missões esperando a pessoa",
  teto_do_mes: "alguém atingiu o teto do mês",
};

type Http = (url: string, init?: RequestInit) => Promise<Response>;

export async function vigiar(base: string, token: string | undefined, http: Http = fetch): Promise<Achado> {
  const linhas: string[] = [];
  let ok = true;
  const pedir = async (caminho: string, init?: RequestInit) => {
    try {
      return await http(new URL(caminho, base).toString(), { ...init, redirect: "manual", signal: AbortSignal.timeout(15_000) });
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e));
    }
  };

  const h = await pedir("/health");
  if (h instanceof Error || h.status !== 200) {
    ok = false;
    linhas.push(`- **/health não responde** (${h instanceof Error ? h.name : `HTTP ${h.status}`}): o serviço pode estar fora do ar.`);
  } else {
    const corpo = (await h.json().catch(() => ({}))) as { vivo?: unknown; versao?: unknown };
    if (corpo.vivo !== true) {
      // 200 com outra coisa (a página do app, por exemplo): é uma versão sem /health, ou outro serviço.
      ok = false;
      linhas.push("- **/health respondeu, mas não é o OBEDIENT esperado** (sem `{\"vivo\":true}`): versão antiga no ar ou endereço errado.");
      return { ok, linhas };
    }
    linhas.push(`- /health ok${typeof corpo.versao === "string" && /^[0-9a-f]{7,12}$/.test(corpo.versao) ? `, versão \`${corpo.versao}\`` : ""}.`);
  }

  const r = await pedir("/ready");
  if (r instanceof Error || r.status !== 200) {
    ok = false;
    let motivo = r instanceof Error ? r.name : `HTTP ${r.status}`;
    if (!(r instanceof Error)) {
      const corpo = (await r.json().catch(() => ({}))) as { motivo?: unknown };
      if (corpo.motivo === "migrations" || corpo.motivo === "banco") motivo += `, motivo: ${corpo.motivo}`;
    }
    linhas.push(`- **/ready não está pronto** (${motivo}). Migrations: rode \`cli.ts migrar\`. Banco: confira o Postgres.`);
  } else {
    linhas.push("- /ready ok.");
  }

  if (!token) {
    linhas.push("- /metrics não conferido (sem OBEDIENT_METRICAS_TOKEN no repositório).");
  } else {
    const m = await pedir("/metrics", { headers: { authorization: `Bearer ${token}` } });
    if (m instanceof Error || m.status !== 200) {
      ok = false;
      linhas.push(`- **/metrics não respondeu** (${m instanceof Error ? m.name : `HTTP ${m.status}`}). 401: o token do repositório não é o do servidor. 404: o servidor está sem token.`);
    } else {
      const acesos = alertasAcesos(await m.text());
      if (acesos.length) {
        ok = false;
        for (const a of acesos) linhas.push(`- **alerta aceso: ${a}** (${EXPLICA[a] ?? "veja docs/operations/runbook.md"}).`);
      } else {
        linhas.push("- /metrics ok, nenhum alerta aceso.");
      }
    }
  }
  return { ok, linhas };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const base = process.env.OBEDIENT_URL?.trim();
  if (!base || !base.startsWith("https://")) {
    console.error("defina OBEDIENT_URL (https)");
    process.exit(2);
  }
  const achado = await vigiar(base, process.env.OBEDIENT_METRICAS_TOKEN?.trim() || undefined);
  console.log(achado.linhas.join("\n"));
  process.exit(achado.ok ? 0 : 1);
}
