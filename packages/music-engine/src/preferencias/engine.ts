// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Preference Engine: valida o que a pessoa DECLAROU e filtra o catálogo pelo que ela permitiu.
// Não aprende nem infere gosto (nada sai do aparelho e nada vira modelo). A faixa de energia por zona
// tem um padrão que a pessoa pode trocar zona a zona.

import type { FaixaCatalogo, FaixaEnergia, Preferencias, Zona } from "@obedient/music-contracts";
import { MODOS_ADAPTACAO, ORIGENS_FAIXA, ZONAS } from "@obedient/music-contracts";

/** Energia sugerida por zona, quando a pessoa não escolheu outra. Sobreposição proposital. */
export const ENERGIA_PADRAO: Readonly<Record<Zona, FaixaEnergia>> = {
  repouso: { min: 0.0, max: 0.35 },
  z1: { min: 0.2, max: 0.45 },
  z2: { min: 0.35, max: 0.6 },
  z3: { min: 0.5, max: 0.75 },
  z4: { min: 0.65, max: 0.9 },
  z5: { min: 0.8, max: 1.0 },
};

export const PREFERENCIAS_PADRAO: Preferencias = {
  generos: [],
  energiaPorZona: {},
  bloqueadas: [],
  permiteExplicito: false,
  modo: "ligada",
};

export function faixaDeEnergia(zona: Zona, p: Preferencias): FaixaEnergia {
  return p.energiaPorZona[zona] ?? ENERGIA_PADRAO[zona];
}

export function validarPreferencias(p: Preferencias): string[] {
  const erros: string[] = [];
  if (!(MODOS_ADAPTACAO as readonly string[]).includes(p.modo)) erros.push("modo_invalido");
  for (const [zona, f] of Object.entries(p.energiaPorZona)) {
    if (!(ZONAS as readonly string[]).includes(zona)) erros.push(`zona_desconhecida:${zona}`);
    else if (!f || !(f.min >= 0 && f.max <= 1 && f.min <= f.max)) erros.push(`energia_invalida:${zona}`);
  }
  if (p.generos.length > 50) erros.push("generos_demais");
  if (p.bloqueadas.length > 5000) erros.push("bloqueadas_demais");
  return erros;
}

/**
 * Valida uma faixa do catálogo na ingestão e de novo antes de tocar. A faixa só entra se a licença
 * permitir uso comercial, tiver evidência registrada e estiver vigente. Ver
 * docs/governance/music-engine-f0.md, "Catálogo próprio".
 */
export function validarFaixa(f: FaixaCatalogo, agoraIso: string): string[] {
  const erros: string[] = [];
  if (!f.id) erros.push("sem_id");
  if (!(ORIGENS_FAIXA as readonly string[]).includes(f.origem)) erros.push("origem_nao_permitida");
  if (!(f.energia >= 0 && f.energia <= 1)) erros.push("energia_fora_da_faixa");
  if (!(f.duracaoMs > 0)) erros.push("duracao_invalida");
  for (let i = 0; i < f.fronteirasMs.length; i++) {
    const b = f.fronteirasMs[i]!;
    if (!(b >= 0 && b <= f.duracaoMs) || (i > 0 && b <= f.fronteirasMs[i - 1]!)) {
      erros.push("fronteiras_invalidas");
      break;
    }
  }
  if (!f.licenca.permiteComercial) erros.push("licenca_sem_uso_comercial");
  if (!f.licenca.instrumento.trim()) erros.push("licenca_sem_instrumento");
  if (!f.licenca.evidencia.trim()) erros.push("licenca_sem_evidencia");
  if (f.licenca.validaAte !== null && !(f.licenca.validaAte > agoraIso)) erros.push("licenca_vencida");
  return erros;
}

/** O que pode tocar para esta pessoa agora: licença válida, não bloqueada, gênero e conteúdo permitidos. */
export function elegiveis(catalogo: readonly FaixaCatalogo[], p: Preferencias, agoraIso: string): FaixaCatalogo[] {
  const bloqueadas = new Set(p.bloqueadas);
  const generos = new Set(p.generos);
  return catalogo.filter(
    (f) =>
      validarFaixa(f, agoraIso).length === 0 &&
      !bloqueadas.has(f.id) &&
      (p.permiteExplicito || !f.explicita) &&
      (generos.size === 0 || generos.has(f.genero)),
  );
}
