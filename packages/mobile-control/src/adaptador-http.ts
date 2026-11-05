// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// A porta AdaptadorMovel sobre o serviço do aparelho (casa-de-ia, executores/mobile-control): quatro
// rotas POST internas, com token. O que volta do aparelho é conferido antes de virar captura:
// formato, tipos, tamanho. Erro do serviço vira erro legível, sem a resposta bruta nem o token.

import type { AdaptadorMovel, CapturaBruta, Comando, ElementoBruto } from "./tipos.ts";

export const MAX_ELEMENTOS_HTTP = 300;
const MAX_TEXTO_HTTP = 500;

export interface OpcoesAdaptadorHttp {
  /** Base do serviço, ex.: http://127.0.0.1:8765 (rede interna). */
  url: string;
  token: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const numero = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100_000;

export function lerCaptura(bruto: unknown): CapturaBruta {
  if (!bruto || typeof bruto !== "object") throw new Error("o aparelho devolveu uma tela inválida");
  const r = bruto as { app?: unknown; elementos?: unknown };
  if (r.app !== null && typeof r.app !== "string") throw new Error("o aparelho devolveu um app inválido");
  if (!Array.isArray(r.elementos) || r.elementos.length > MAX_ELEMENTOS_HTTP) throw new Error("o aparelho devolveu elementos inválidos");
  const elementos: ElementoBruto[] = r.elementos.map((e: unknown) => {
    const x = e as Record<string, unknown>;
    const c = x?.caixa as Record<string, unknown> | undefined;
    if (!x || typeof x.texto !== "string" || x.texto.length > MAX_TEXTO_HTTP || !c || ![c.x, c.y, c.w, c.h].every(numero) || typeof x.clicavel !== "boolean") throw new Error("o aparelho devolveu um elemento inválido");
    return {
      // Senha nunca vem com texto; se viesse, não passaria daqui.
      texto: x.senha === true ? "" : x.texto,
      origem: x.origem === "pixels" ? "pixels" : "tree",
      caixa: { x: c.x as number, y: c.y as number, w: c.w as number, h: c.h as number },
      clicavel: x.clicavel,
      campo: x.campo === true,
      senha: x.senha === true,
    };
  });
  return { app: (r.app as string | null) ?? null, elementos };
}

export class AdaptadorHttp implements AdaptadorMovel {
  private readonly base: string;
  private readonly http: typeof fetch;
  constructor(private readonly o: OpcoesAdaptadorHttp) {
    const u = new URL(o.url);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("o serviço do aparelho precisa ser http ou https");
    if (o.token.length < 32) throw new Error("o token do serviço do aparelho precisa de pelo menos 32 caracteres");
    this.base = u.origin;
    this.http = o.fetch ?? fetch;
  }

  private async post(rota: string, corpo: Record<string, unknown>): Promise<unknown> {
    let r: Response;
    try {
      r = await this.http(`${this.base}${rota}`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.o.token}`, "content-type": "application/json" },
        body: JSON.stringify(corpo),
        redirect: "error",
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 30_000),
      });
    } catch {
      throw new Error("o serviço do aparelho não respondeu");
    }
    let dados: unknown = null;
    try {
      dados = await r.json();
    } catch {
      // resposta sem JSON
    }
    if (!r.ok) {
      const erro = dados && typeof dados === "object" && typeof (dados as { erro?: unknown }).erro === "string" ? (dados as { erro: string }).erro.slice(0, 200) : "sem detalhe";
      throw new Error(`o aparelho recusou (${r.status}): ${erro}`);
    }
    return dados;
  }

  async iniciar(dispositivoId: string) {
    await this.post("/v1/iniciar", { dispositivo_id: dispositivoId });
  }
  async capturar(dispositivoId: string) {
    return lerCaptura(await this.post("/v1/capturar", { dispositivo_id: dispositivoId }));
  }
  async executar(dispositivoId: string, comando: Comando) {
    await this.post("/v1/executar", { dispositivo_id: dispositivoId, comando });
  }
  async encerrar(dispositivoId: string) {
    await this.post("/v1/encerrar", { dispositivo_id: dispositivoId });
  }
}
