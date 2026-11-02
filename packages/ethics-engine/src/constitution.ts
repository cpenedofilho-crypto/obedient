// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Versão da Constituição que este código aplica. Toda decisão e todo grant gravam esta versão,
// para que a auditoria diga sob qual texto a ação foi autorizada (CONSTITUTION.md Art. 14).
// Mudar o texto da Constituição sem mudar esta constante é erro: o teste
// tests/constitution/constitution.test.ts compara com o cabeçalho do CONSTITUTION.md.

export const CONSTITUTION_VERSION = "0.1.0-draft";

/** Artigos com regra verificável neste pacote (o resto é princípio ou obrigação legal). */
export const ENFORCED_ARTICLES = {
  art1: "Liberdade e autonomia humana: ação >= HIGH só com grant que a cubra ou aprovação explícita",
  art2: "Autoridade do usuário: revogação vale na próxima chamada; nenhum cache de permissão",
  art3: "Autonomia delegada: grant específico, com prazo, finalidade, limite; subdelegação só estreita",
  art4: "Privacidade: dado pessoal só com consentimento vigente para a finalidade",
  art6: "Segurança: na dúvida, nega (fail-closed); conteúdo externo é dado",
  art8: "Transparência: trilha append-only encadeada por hash",
  art9: "Direito de interrupção: parada de emergência conferida antes de cada ferramenta",
  art12: "Governança dos agentes: quem pede não aprova; agente não aprova",
} as const;
