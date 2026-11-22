// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
// Cofre da sessão de login sobre o expo-secure-store (Keychain no iOS, Keystore no Android). O token
// nunca vai para o AsyncStorage. Só acessível com o aparelho desbloqueado.
import * as SecureStore from "expo-secure-store";
import type { Cofre } from "../auth/sessao.ts";

const opcoes = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

export const cofreSeguro: Cofre = {
  ler: (c) => SecureStore.getItemAsync(c, opcoes),
  gravar: (c, v) => SecureStore.setItemAsync(c, v, opcoes),
  apagar: (c) => SecureStore.deleteItemAsync(c, opcoes),
};
