// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// ConsentStore do Ethics Engine guardado no aparelho. O ConsentManager continua sendo a autoridade
// (CONSTITUTION.md Art. 4º); aqui só muda onde os registros ficam entre uma abertura e outra do app.
import type { ConsentRecord, ConsentStore } from "@obedient/ethics-engine";
import { gravarJson, type Kv, lerJson } from "./kv.ts";

const CHAVE = "consentimentos";

type Gravado = Omit<ConsentRecord, "givenAt" | "expiresAt" | "revokedAt"> & { givenAt: string; expiresAt: string | null; revokedAt: string | null };

const paraGravar = (r: ConsentRecord): Gravado => ({
  ...r, givenAt: r.givenAt.toISOString(), expiresAt: r.expiresAt?.toISOString() ?? null, revokedAt: r.revokedAt?.toISOString() ?? null,
});
const doGravado = (g: Gravado): ConsentRecord => ({
  ...g, givenAt: new Date(g.givenAt), expiresAt: g.expiresAt ? new Date(g.expiresAt) : null, revokedAt: g.revokedAt ? new Date(g.revokedAt) : null,
});

export class ConsentStoreLocal implements ConsentStore {
  constructor(private readonly kv: Kv) {}

  private async todos(): Promise<ConsentRecord[]> {
    return (await lerJson<Gravado[]>(this.kv, CHAVE, [])).map(doGravado);
  }

  async insert(r: ConsentRecord): Promise<void> {
    const todos = await this.todos();
    todos.push({ ...r });
    await gravarJson(this.kv, CHAVE, todos.map(paraGravar));
  }

  async listByUser(userId: string): Promise<ConsentRecord[]> {
    return (await this.todos()).filter((r) => r.userId === userId);
  }

  async revokeWhere(userId: string, purpose: string, category: string | null, at: Date): Promise<number> {
    const todos = await this.todos();
    let n = 0;
    for (const r of todos)
      if (r.userId === userId && r.purpose === purpose && (category === null || r.category === category) && !r.revokedAt) {
        r.revokedAt = at;
        n++;
      }
    await gravarJson(this.kv, CHAVE, todos.map(paraGravar));
    return n;
  }
}
