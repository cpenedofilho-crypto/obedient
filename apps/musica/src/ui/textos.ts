// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
// Textos das telas. Cada motivo do motor tem uma frase para a pessoa entender por que a música mudou
// (ou não). texto.test.ts confere que nenhum motivo fica sem frase.
import type { Fase, Motivo, Zona } from "@obedient/music-contracts";

export const MOTIVO: Record<Motivo, string> = {
  sem_consentimento: "Adaptação desligada: falta o seu consentimento.",
  adaptacao_desligada: "Você desligou a adaptação.",
  pausado: "Adaptação pausada por você.",
  faixa_travada: "Você travou esta música.",
  sem_sinal: "Sem sinal do sensor: a música segue no manual.",
  sinal_instavel: "Sinal instável: a música continua até o sinal firmar.",
  faixa_atual_adequada: "A música atual combina com o seu esforço.",
  intervalo_minimo: "Esperando o intervalo mínimo entre trocas.",
  sem_faixa_compativel: "Nenhuma música do catálogo combina com este esforço.",
  zona_mudou: "Seu esforço mudou de zona: música trocada.",
  faixa_atual_inelegivel: "A música atual saiu do catálogo: trocada.",
  nada_tocando: "Começando a música.",
};

export const ZONA: Record<Zona, string> = {
  repouso: "Repouso", z1: "Zona 1 (muito leve)", z2: "Zona 2 (leve)", z3: "Zona 3 (moderada)", z4: "Zona 4 (forte)", z5: "Zona 5 (máxima)",
};

export const FASE: Record<Fase, string> = { aquecimento: "Aquecimento", esforco: "Esforço", recuperacao: "Recuperação" };

export const ERRO_INICIO: Record<string, string> = {
  sem_consentimento: "Antes, dê o consentimento na aba Consentimento.",
  sem_parametros: "Antes, informe sua frequência de repouso e máxima em Ajustes.",
  ja_em_treino: "Já há um treino em andamento.",
  catalogo_vazio: "O catálogo está vazio.",
};

export const ERRO_AJUSTE: Record<string, string> = {
  repouso_fora_da_faixa: "Frequência de repouso fora do esperado (25 a 120 bpm).",
  maxima_fora_da_faixa: "Frequência máxima fora do esperado (100 a 250 bpm).",
  maxima_nao_supera_repouso: "A máxima precisa ficar pelo menos 20 bpm acima do repouso.",
  retencao_fora_da_faixa: "O prazo da trilha vai de 0 a 720 horas.",
  modo_invalido: "Modo inválido.",
};

export const TEXTO_CONSENTIMENTO_SINAL =
  "Para escolher a música pelo seu esforço, o app lê a sua frequência cardíaca do sensor que você conectar. " +
  "É dado de saúde. Ele fica só neste aparelho: não vai para servidor, para outra pessoa nem para treinar inteligência artificial. " +
  "Você pode revogar a qualquer momento, e a leitura para na hora. O app não é dispositivo médico e não serve para diagnóstico.";

export const TEXTO_CONSENTIMENTO_AGREGADOS =
  "Opcional. Ao fim de cada treino, enviar à sua organização só contagens (duração, quantas trocas, quantos pulos), " +
  "sem frequência cardíaca, sem as músicas e sem horário. Recusar não muda a música adaptativa.";
