// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
// Permissão de Bluetooth no Android: 12+ pede "Dispositivos por perto" (BLUETOOTH_SCAN, com
// neverForLocation no manifesto, e BLUETOOTH_CONNECT); até o 11, a localização precisa, exigida pelo
// sistema para procurar aparelhos BLE. No iOS, o sistema pergunta na primeira busca.
import { PermissionsAndroid, Platform } from "react-native";

export async function pedirPermissaoBluetooth(): Promise<boolean> {
  if (Platform.OS !== "android") return true;
  if (Number(Platform.Version) >= 31) {
    const r = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    ]);
    return Object.values(r).every((v) => v === PermissionsAndroid.RESULTS.GRANTED);
  }
  const r = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
  return r === PermissionsAndroid.RESULTS.GRANTED;
}
