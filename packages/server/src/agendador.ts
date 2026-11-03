// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// O agendador: de tempos em tempos, pergunta ao banco QUEM tem missão para andar (tentativa vencida,
// ou pedido de aprovação já decidido) e processa as missões dessas pessoas, uma de cada vez.
//
//   • a pergunta roda com o papel do operador, que não lê missão nenhuma: a função do banco devolve
//     só o id da pessoa (0006);
//   • cada missão é processada com o papel da própria pessoa (processarMissoes), na RLS dela;
//   • uma volta não começa enquanto a anterior não terminou; uma pessoa que falha não segura as outras.
//     O log diz o que falhou, nunca o conteúdo da missão.

import type { Clock } from "@obedient/core";
import type { Executor as ExecutorDeMissao } from "@obedient/missions";
import { type Database, type OpcoesMotor, comoOperador, pessoasComMissaoDevida } from "@obedient/store-postgres";
import { processarMissoes } from "./processador.ts";

export const INTERVALO_PADRAO_MS = 30_000;
export const PESSOAS_POR_VOLTA = 100;

export interface Agendador {
  /** Uma volta agora (o intervalo chama esta mesma função). Devolve quantas pessoas processou. */
  volta(): Promise<number>;
  parar(): void;
}

export function agendarMissoes(o: {
  db: Database;
  executar: ExecutorDeMissao;
  opcoesMotor?: OpcoesMotor;
  clock: Clock;
  intervaloMs?: number;
  log?: (evento: Record<string, unknown>) => void;
}): Agendador {
  const log = o.log ?? ((e) => console.log(JSON.stringify(e)));
  let rodando: Promise<number> | null = null;
  const umaVolta = async (): Promise<number> => {
    let pessoas: string[];
    try {
      pessoas = await comoOperador(o.db, (tx) => pessoasComMissaoDevida(tx, o.clock.now(), PESSOAS_POR_VOLTA));
    } catch (e) {
      log({ evento: "agendador.consulta_falhou", erro: e instanceof Error ? e.message : String(e) });
      return 0;
    }
    for (const u of pessoas) {
      try {
        const feitas = await processarMissoes(o.db, u, o.executar, o.opcoesMotor ?? {}, o.clock);
        log({ evento: "agendador.processou", missoes: feitas.length, estados: feitas.map((m) => m.estado) });
      } catch (e) {
        log({ evento: "agendador.pessoa_falhou", erro: e instanceof Error ? e.message : String(e) });
      }
    }
    return pessoas.length;
  };
  const volta = () => {
    // Volta em andamento: espera ela, não começa outra por cima.
    if (!rodando) rodando = umaVolta().finally(() => (rodando = null));
    return rodando;
  };
  const t = setInterval(() => void volta(), o.intervaloMs ?? INTERVALO_PADRAO_MS);
  t.unref?.();
  return { volta, parar: () => clearInterval(t) };
}
