// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Configuração do app, lida das variáveis EXPO_PUBLIC_* no build.
//
// SINAL_REAL: o sensor Bluetooth de verdade só aparece com EXPO_PUBLIC_SINAL_REAL=1. Padrão desligado:
// pela decisão D31, nenhum dado real de pessoa entra antes do fim da F0 (parecer jurídico). Sem ele, o
// app roda só com o sinal simulado e o catálogo de demonstração.
export const SINAL_REAL_LIBERADO = process.env.EXPO_PUBLIC_SINAL_REAL === "1";

/** Growth OS (F2). Sem ela, o app não fala com servidor nenhum (modo demonstração, offline). */
export const GROWTH_OS_URL = process.env.EXPO_PUBLIC_GROWTH_OS_URL ?? null;
