// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
// GerenteBle (sensor/ble.ts) sobre o react-native-ble-plx (MIT). Só o necessário: procurar pelo serviço,
// conectar, assinar a característica e desconectar. Nenhuma escrita no aparelho da pessoa.
import { BleManager, State } from "react-native-ble-plx";
import type { AparelhoBle, GerenteBle } from "../sensor/ble.ts";

export function gerenteBlePlx(manager: BleManager = new BleManager()): GerenteBle {
  return {
    async ligado() {
      return (await manager.state()) === State.PoweredOn;
    },
    procurar(servicos, aoAchar) {
      void manager.startDeviceScan(servicos, { allowDuplicates: false }, (erro, d) => {
        if (!erro && d) aoAchar({ id: d.id, nome: d.localName ?? d.name ?? null } satisfies AparelhoBle);
      });
      return () => { void manager.stopDeviceScan(); };
    },
    async conectar(id) {
      await manager.connectToDevice(id, { timeout: 15_000 });
      await manager.discoverAllServicesAndCharacteristicsForDevice(id);
    },
    monitorar(id, servico, caracteristica, aoValor, aoFim) {
      const caiu = manager.onDeviceDisconnected(id, (erro) => aoFim(erro ?? null));
      const assinatura = manager.monitorCharacteristicForDevice(id, servico, caracteristica, (erro, c) => {
        if (erro) aoFim(erro);
        else if (c?.value) aoValor(c.value);
      });
      return () => { assinatura.remove(); caiu.remove(); };
    },
    async desconectar(id) {
      await manager.cancelDeviceConnection(id).catch(() => undefined);
    },
  };
}
