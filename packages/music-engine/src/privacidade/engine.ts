// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Privacy Engine do motor de música. Não é um segundo gestor de consentimento: usa o ConsentManager
// do Ethics Engine (autoridade única, CONSTITUTION.md Art. 4º) e só dá a ele a finalidade e as
// categorias certas.
//
//   - Ler o sinal (frequência cardíaca) = finalidade "adaptacao_musical", categorias health e
//     biometric, consentimento ESPECÍFICO (LGPD art. 11, I). Sem isso o motor não lê nada.
//   - Mandar o resumo agregado da sessão para fora do aparelho = finalidade própria e opcional
//     ("musica_agregados"), separada: recusar não tira a música adaptativa.
//   - Revogar vale na hora: quem estiver ouvindo (a sessão) é avisado e para de ler o sensor.

import type { ConsentManager } from "@obedient/ethics-engine";
import { CATEGORIAS_SINAL, FINALIDADE_ADAPTACAO } from "@obedient/music-contracts";

export const FINALIDADE_AGREGADOS = "musica_agregados";
export const CATEGORIA_AGREGADOS = "usage";

export class MotorDePrivacidade {
  private readonly ouvintes = new Set<() => void>();

  constructor(
    private readonly consentimentos: ConsentManager,
    private readonly userId: string,
  ) {}

  /** A pessoa aceitou o texto (versão registrada pelo app) na tela de consentimento destacada. */
  async concederSinal(): Promise<void> {
    for (const categoria of CATEGORIAS_SINAL) await this.consentimentos.give(this.userId, FINALIDADE_ADAPTACAO, categoria, { specific: true });
  }

  async revogarSinal(): Promise<void> {
    await this.consentimentos.revokePurpose(this.userId, FINALIDADE_ADAPTACAO);
    for (const ouvinte of [...this.ouvintes]) ouvinte();
  }

  async sinalPermitido(): Promise<boolean> {
    return (await this.consentimentos.check(this.userId, FINALIDADE_ADAPTACAO, CATEGORIAS_SINAL)).ok;
  }

  async concederAgregados(): Promise<void> {
    await this.consentimentos.give(this.userId, FINALIDADE_AGREGADOS, CATEGORIA_AGREGADOS, { specific: true });
  }

  async revogarAgregados(): Promise<void> {
    await this.consentimentos.revokePurpose(this.userId, FINALIDADE_AGREGADOS);
  }

  async agregadosPermitidos(): Promise<boolean> {
    return (await this.consentimentos.check(this.userId, FINALIDADE_AGREGADOS, [CATEGORIA_AGREGADOS])).ok;
  }

  /** Avisa quando o consentimento do sinal for revogado. Devolve a função que cancela o aviso. */
  aoRevogarSinal(ouvinte: () => void): () => void {
    this.ouvintes.add(ouvinte);
    return () => this.ouvintes.delete(ouvinte);
  }
}
