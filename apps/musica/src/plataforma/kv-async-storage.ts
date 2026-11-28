// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
// Kv sobre o AsyncStorage (armazenamento local do app, que fica dentro da área do app no aparelho).
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Kv } from "../armazenamento/kv.ts";

export const kvDoAparelho: Kv = {
  ler: (c) => AsyncStorage.getItem(c),
  gravar: (c, v) => AsyncStorage.setItem(c, v),
  apagar: (c) => AsyncStorage.removeItem(c),
  chaves: async () => [...(await AsyncStorage.getAllKeys())],
};
