// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Vocabulário de eventos do OBEDIENT. O tenant (organizationId) é o usuário dono da instância.
// Os eventos dizem o FATO; nunca carregam dado pessoal (a rede de regras.ts recusa) nem o conteúdo de
// uma proposta (só ids e o hash do payload aprovado).
//
// Acrescentar um tipo = acrescentar uma linha aqui e um caso em vocabulario-obedient.test.ts.

import { criarVocabulario } from "./vocabulario.ts";

export const VOCABULARIO_OBEDIENT = criarVocabulario({
  // obedient: o núcleo (Ethics Engine, motor de missões). dots: o supervisor subordinado.
  // integration: sistemas externos conectados pelo integration-gateway. user: ação direta da pessoa.
  fontes: ["obedient", "dots", "integration", "user"],
  entidades: ["user", "mission", "grant", "proposal", "agent_run", "integration"],
  entidadesInternas: ["user", "mission", "grant", "proposal", "agent_run"],
  somenteInternas: ["user"],
  tipos: [
    // Missões (Fase 6): o motor de missões publica; ninguém mais.
    { tipo: "mission.created", entidades: ["mission"], fontes: ["obedient"], descricao: "Missão nova, a partir de um pedido do usuário." },
    { tipo: "mission.blocked", entidades: ["mission"], fontes: ["obedient"], descricao: "Missão parada em impedimento explicado ao usuário (Art. 7º)." },
    { tipo: "mission.completed", entidades: ["mission"], fontes: ["obedient"], descricao: "Missão concluída." },

    // Aprovação humana (Arts. 1º e 12): só ids, hash e desfecho; nunca o conteúdo.
    { tipo: "proposal.created", entidades: ["proposal"], fontes: ["obedient"], descricao: "Ação sensível virou proposta à espera do usuário." },
    { tipo: "proposal.approved", entidades: ["proposal"], fontes: ["obedient"], descricao: "Usuário aprovou a proposta (hash do payload mostrado)." },
    { tipo: "proposal.rejected", entidades: ["proposal"], fontes: ["obedient"], descricao: "Usuário recusou, ou a parada de emergência cancelou." },
    { tipo: "proposal.executed", entidades: ["proposal"], fontes: ["obedient"], descricao: "Proposta executada uma única vez." },

    // Autoridade delegada (Art. 3º).
    { tipo: "grant.granted", entidades: ["grant"], fontes: ["obedient"], descricao: "Usuário concedeu autoridade a um agente." },
    { tipo: "grant.revoked", entidades: ["grant"], fontes: ["obedient"], descricao: "Autoridade revogada (com a cadeia de subdelegações)." },

    // Direito de interrupção (Art. 9º). Só o núcleo publica: agente nenhum anuncia parada ou liberação.
    { tipo: "emergency_stop.engaged", entidades: ["user"], fontes: ["obedient"], descricao: "Parada de emergência acionada." },
    { tipo: "emergency_stop.released", entidades: ["user"], fontes: ["obedient"], descricao: "Parada liberada pelo próprio usuário." },

    // DOTS (subordinado, só leitura nesta fase): avisa que há algo esperando a pessoa no sistema de origem.
    { tipo: "dots.attention.needed", entidades: ["integration"], fontes: ["dots"], descricao: "O DOTS achou pendência que precisa de decisão humana no sistema de origem." },

    // Integrações externas.
    { tipo: "integration.event.received", entidades: ["integration"], fontes: ["integration"], descricao: "Sistema externo avisou de um fato (sem dado pessoal)." },
    { tipo: "integration.connected", entidades: ["integration"], fontes: ["obedient"], descricao: "Usuário conectou uma integração." },
    { tipo: "integration.disconnected", entidades: ["integration"], fontes: ["obedient", "user"], descricao: "Integração desconectada." },
  ],
});
