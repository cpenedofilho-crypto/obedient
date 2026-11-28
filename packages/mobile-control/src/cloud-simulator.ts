// SPDX-License-Identifier: AGPL-3.0-only
import { CelularFalso, APP_DEMO } from "./adaptador-falso.ts";
import type { AdaptadorMovel, Comando } from "./tipos.ts";

type Operation = "start" | "capture" | "execute" | "stop";

/** Test-only adapter. No network, billing, credentials or real devices. */
export class CloudSimulator implements AdaptadorMovel {
  private readonly active = new Map<string, CelularFalso>();
  private readonly allowed: ReadonlySet<string>;
  private failure: Operation | null = null;
  constructor(ids: readonly string[]) {
    this.allowed = new Set(ids);
  }
  failNext(operation: Operation): void { this.failure = operation; }
  private check(id: string, operation: Operation): void {
    if (!this.allowed.has(id)) throw new Error("unknown simulated device");
    if (this.failure === operation) {
      this.failure = null;
      throw new Error("simulated provider failure");
    }
  }
  private device(id: string): CelularFalso {
    const device = this.active.get(id);
    if (!device) throw new Error("device inactive");
    return device;
  }
  async iniciar(id: string): Promise<void> {
    this.check(id, "start");
    if (this.active.has(id)) throw new Error("device already active");
    this.active.set(id, new CelularFalso());
  }
  async capturar(id: string) {
    this.check(id, "capture");
    return this.device(id).capturar();
  }
  async executar(id: string, command: Comando): Promise<void> {
    this.check(id, "execute");
    if (command.tipo === "abrir_app" && command.app !== APP_DEMO)
      throw new Error("only synthetic demo app allowed");
    await this.device(id).executar(id, command);
  }
  async encerrar(id: string): Promise<void> {
    this.check(id, "stop");
    this.active.delete(id);
  }
}
