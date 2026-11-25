// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.

/** Análise determinística de jogos finitos em forma normal; não executa ações. */
export interface Jogo {
  jogadores: readonly { nome: string; estrategias: readonly string[] }[];
  /** Cada perfil contém o índice de uma estratégia por jogador e um payoff por jogador. */
  resultados: readonly { perfil: readonly number[]; payoffs: readonly number[] }[];
}

export interface Eliminacao {
  jogador: number;
  estrategia: number;
  dominadaPor: number;
  rodada: number;
}

export interface Analise {
  /** Todos os perfis de equilíbrio em estratégias puras (podem não existir). */
  nash: number[][];
  /** Perfis eficientes de Pareto entre todos os resultados originalmente viáveis. */
  pareto: number[][];
  /** Eliminações de dominância estrita por estratégias puras, com evidência da ordem. */
  eliminacoes: Eliminacao[];
  estrategiasRestantes: number[][];
}

const chave = (perfil: readonly number[]) => perfil.join(",");

export function analisarJogo(jogo: Jogo): Analise {
  const n = jogo.jogadores?.length;
  if (!Number.isInteger(n) || n < 2 || n > 4) throw new Error("São necessários de 2 a 4 jogadores");
  const tamanhos = jogo.jogadores.map((j) => {
    if (!j.nome?.trim() || j.estrategias.length < 2 || j.estrategias.length > 10 ||
      j.estrategias.some((s) => !s.trim()) || new Set(j.estrategias).size !== j.estrategias.length) {
      throw new Error("Jogador ou estratégias inválidos");
    }
    return j.estrategias.length;
  });
  const total = tamanhos.reduce((a, b) => a * b, 1);
  if (total > 4096 || jogo.resultados.length !== total) throw new Error("Matriz incompleta ou excessiva");

  const mapa = new Map<string, readonly number[]>();
  for (const r of jogo.resultados) {
    if (r.perfil.length !== n || r.payoffs.length !== n ||
      r.perfil.some((v, i) => !Number.isInteger(v) || v < 0 || v >= tamanhos[i]!) ||
      r.payoffs.some((v) => !Number.isFinite(v))) throw new Error("Resultado inválido");
    const k = chave(r.perfil);
    if (mapa.has(k)) throw new Error("Perfil duplicado");
    mapa.set(k, r.payoffs);
  }
  const perfis: number[][] = [];
  const enumerar = (prefixo: number[]) => {
    if (prefixo.length === n) { perfis.push(prefixo); return; }
    for (let s = 0; s < tamanhos[prefixo.length]!; s++) enumerar([...prefixo, s]);
  };
  enumerar([]);
  if (perfis.some((p) => !mapa.has(chave(p)))) throw new Error("Perfil ausente");
  const payoff = (p: readonly number[], i: number) => mapa.get(chave(p))![i]!;

  const nash = perfis.filter((p) => p.every((s, i) =>
    Array.from({ length: tamanhos[i]! }, (_, alternativa) => alternativa)
      .every((alternativa) => payoff(p, i) >= payoff(p.map((x, j) => j === i ? alternativa : x), i))));

  const pareto = perfis.filter((p) => !perfis.some((q) =>
    q.every((_, i) => payoff(q, i) >= payoff(p, i)) &&
    q.some((_, i) => payoff(q, i) > payoff(p, i))));

  const ativos = tamanhos.map((t) => Array.from({ length: t }, (_, i) => i));
  const eliminacoes: Eliminacao[] = [];
  let rodada = 0;
  // Remoção sequencial com ordem estável; cada eliminação é estritamente justificada
  // frente a TODOS os perfis ainda possíveis dos adversários.
  while (true) {
    let encontrou = false;
    for (let i = 0; i < n && !encontrou; i++) {
      for (const s of ativos[i]!) {
        for (const t of ativos[i]!) {
          if (s === t) continue;
          const contextos = perfis.filter((p) => p.every((v, j) => j === i || ativos[j]!.includes(v)));
          const dominada = contextos.every((p) => payoff(p.map((v, j) => j === i ? t : v), i) >
            payoff(p.map((v, j) => j === i ? s : v), i));
          if (dominada) {
            ativos[i] = ativos[i]!.filter((v) => v !== s);
            eliminacoes.push({ jogador: i, estrategia: s, dominadaPor: t, rodada: ++rodada });
            encontrou = true;
            break;
          }
        }
        if (encontrou) break;
      }
    }
    if (!encontrou) break;
  }
  return { nash, pareto, eliminacoes, estrategiasRestantes: ativos };
}
