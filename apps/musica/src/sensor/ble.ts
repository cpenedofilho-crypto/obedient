// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Sensor de frequência cardíaca por Bluetooth LE (Heart Rate Service 0x180D, medição 0x2A37). Serve
// para cinta, relógio em "broadcast" (Garmin, Polar), WHOOP e qualquer aparelho que siga o padrão.
// A leitura dos bytes é do motor (@obedient/music-engine, lerMedicaoFc); aqui fica só a conversa com o
// rádio, atrás da porta GerenteBle (implementada sobre o react-native-ble-plx em plataforma/ble-plx.ts).
//
// Comportamento: procura SÓ aparelhos que anunciam o 0x180D (o iOS exige o filtro em segundo plano);
// conecta no aparelho que a pessoa escolheu; se cair, tenta de novo algumas vezes, com espera crescente.
// Pacote que não se lê vira amostra sem bpm (descartada pelo filtro), nunca um número inventado.
import type { AmostraSinal, SensorAdapter } from "@obedient/music-contracts";
import { lerMedicaoFc } from "@obedient/music-engine";
import { base64ParaBytes } from "./base64.ts";

export const SERVICO_FC = "0000180d-0000-1000-8000-00805f9b34fb";
export const MEDICAO_FC = "00002a37-0000-1000-8000-00805f9b34fb";

export interface AparelhoBle { id: string; nome: string | null }

export interface GerenteBle {
  ligado(): Promise<boolean>;
  /** Procura aparelhos com estes serviços. Devolve a função que para a busca. */
  procurar(servicos: string[], aoAchar: (a: AparelhoBle) => void): () => void;
  conectar(id: string): Promise<void>;
  /** Recebe cada valor (base64). Devolve a função que para. aoFim é chamado se a conexão cair. */
  monitorar(id: string, servico: string, caracteristica: string, aoValor: (base64: string) => void, aoFim: (erro: Error | null) => void): () => void;
  desconectar(id: string): Promise<void>;
}

export async function procurarCintas(g: GerenteBle, duracaoMs: number, espera: (ms: number) => Promise<void>): Promise<AparelhoBle[]> {
  if (!(await g.ligado())) return [];
  const achados = new Map<string, AparelhoBle>();
  const parar = g.procurar([SERVICO_FC], (a) => achados.set(a.id, a));
  try { await espera(duracaoMs); } finally { parar(); }
  return [...achados.values()];
}

export const TENTATIVAS_RECONEXAO = 5;

export class SensorBle implements SensorAdapter {
  readonly fonte = "ble_hrs" as const;

  constructor(
    readonly id: string,
    private readonly gerente: GerenteBle,
    private readonly relogio: () => number,
    private readonly espera: (ms: number) => Promise<void>,
  ) {}

  async *amostras(sinal: AbortSignal): AsyncIterable<AmostraSinal> {
    const fila: AmostraSinal[] = [];
    let acordar: (() => void) | null = null;
    let caiu = false;
    const avisar = () => { acordar?.(); acordar = null; };
    sinal.addEventListener("abort", avisar);

    let tentativas = 0;
    try {
      while (!sinal.aborted) {
        caiu = false;
        try {
          await this.gerente.conectar(this.id);
        } catch {
          if (++tentativas > TENTATIVAS_RECONEXAO) return;
          await this.espera(1000 * 2 ** (tentativas - 1));
          continue;
        }
        tentativas = 0;
        const parar = this.gerente.monitorar(this.id, SERVICO_FC, MEDICAO_FC, (b64) => {
          fila.push(this.amostraDe(b64));
          avisar();
        }, () => { caiu = true; avisar(); });

        try {
          while (!sinal.aborted && !caiu) {
            while (fila.length) {
              yield fila.shift()!;
              if (sinal.aborted) return;
            }
            if (caiu) break;
            await new Promise<void>((r) => { acordar = r; });
          }
        } finally {
          parar();
        }
        while (fila.length && !sinal.aborted) yield fila.shift()!;
        if (sinal.aborted) return;
        if (++tentativas > TENTATIVAS_RECONEXAO) return;
        await this.espera(1000 * 2 ** (tentativas - 1));
      }
    } finally {
      sinal.removeEventListener("abort", avisar);
      await this.gerente.desconectar(this.id).catch(() => undefined);
    }
  }

  private amostraDe(b64: string): AmostraSinal {
    const t = this.relogio();
    let bytes: Uint8Array;
    try { bytes = base64ParaBytes(b64); } catch { return { t, fonte: this.fonte }; }
    const r = lerMedicaoFc(bytes);
    if (!r.ok) return { t, fonte: this.fonte };
    const { bpm, rrMs, contato } = r.medicao;
    return { t, fonte: this.fonte, bpm, ...(rrMs.length ? { rrMs } : {}), ...(contato === undefined ? {} : { contato }) };
  }
}
