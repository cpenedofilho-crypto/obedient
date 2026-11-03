// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// O que cada integração pede ao Google e o que ela permite ao agente. Escopo MÍNIMO: só o que as
// ferramentas declaradas usam. Risco e categoria de cada ferramenta são declarados AQUI (o modelo
// nunca escolhe), e passam pela validação do SDK (READ com risco alto é recusado).

import { type ToolDeclaration, validateToolDeclaration } from "@obedient/sdk";

export interface Integracao {
  id: "google_agenda" | "google_gmail" | "google_drive";
  nome: string;
  /** O que a pessoa lê antes de conectar: o que o agente vai poder fazer, em português. */
  explicacao: string;
  escopos: readonly string[];
  ferramentas: readonly ToolDeclaration[];
}

const G = "https://www.googleapis.com/auth/";

export const INTEGRACOES: readonly Integracao[] = [
  {
    id: "google_agenda",
    nome: "Google Agenda",
    explicacao: "Ver seus compromissos e criar compromissos novos. Apagar um compromisso sempre pede a sua confirmação com passkey.",
    // calendar.events: ler e escrever eventos. Não dá acesso a configurações nem a outras agendas além dos eventos.
    escopos: [`${G}calendar.events`],
    ferramentas: [
      { system: "google_agenda", name: "google_agenda.listar_eventos", description: "Lista os compromissos de um período", risk: "LOW", category: "READ", dataCategories: ["agenda", "contacts"] },
      { system: "google_agenda", name: "google_agenda.criar_evento", description: "Cria um compromisso", risk: "MEDIUM", category: "WRITE", dataCategories: ["agenda"] },
      { system: "google_agenda", name: "google_agenda.apagar_evento", description: "Apaga um compromisso", risk: "HIGH", category: "DESTRUCTIVE", dataCategories: ["agenda"] },
    ],
  },
  {
    id: "google_gmail",
    nome: "Gmail",
    explicacao: "Ler seus e-mails e mandar e-mail em seu nome, sempre com a sua assinatura. Mandar e-mail sempre pede a sua aprovação.",
    // gmail.readonly + gmail.send: ler e enviar. Sem gmail.modify: o agente não apaga nem arquiva nada.
    escopos: [`${G}gmail.readonly`, `${G}gmail.send`],
    ferramentas: [
      { system: "google_gmail", name: "google_gmail.buscar_mensagens", description: "Busca e-mails e lê o conteúdo", risk: "LOW", category: "READ", dataCategories: ["contacts", "comunicacoes"] },
      { system: "google_gmail", name: "google_gmail.enviar_mensagem", description: "Manda um e-mail em seu nome", risk: "HIGH", category: "COMMUNICATION", dataCategories: ["contacts", "comunicacoes"] },
    ],
  },
  {
    id: "google_drive",
    nome: "Google Drive",
    explicacao: "Criar documentos e ler os que ele mesmo criou. Ele não vê os outros arquivos do seu Drive.",
    // drive.file: só arquivos criados ou abertos por este app. O resto do Drive fica invisível.
    escopos: [`${G}drive.file`],
    ferramentas: [
      { system: "google_drive", name: "google_drive.listar_arquivos", description: "Lista os arquivos que o agente criou", risk: "LOW", category: "READ", dataCategories: ["documentos"] },
      { system: "google_drive", name: "google_drive.criar_documento", description: "Cria um documento de texto", risk: "MEDIUM", category: "WRITE", dataCategories: ["documentos"] },
    ],
  },
];

// Cada declaração passa na validação do SDK, e nenhuma ferramenta pede escopo de fora da integração.
for (const i of INTEGRACOES)
  for (const f of i.ferramentas) {
    const p = validateToolDeclaration(f);
    if (p.length) throw new Error(`${f.name}: ${p.join("; ")}`);
    if (f.system !== i.id || !f.name.startsWith(`${i.id}.`)) throw new Error(`${f.name}: ferramenta fora da integração ${i.id}`);
  }

export function integracao(id: string): Integracao {
  const i = INTEGRACOES.find((x) => x.id === id);
  if (!i) throw new Error(`integração desconhecida: ${id}`);
  return i;
}
