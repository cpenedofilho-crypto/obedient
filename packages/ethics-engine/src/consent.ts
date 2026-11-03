// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Consent Manager (CONSTITUTION.md Art. 4º e 10; LGPD arts. 7º, 8º, 11).
//
// Consentimento é por FINALIDADE e por CATEGORIA de dado. A ferramenta declara as categorias
// que toca (no registro, nunca o modelo); a ação só passa se houver consentimento vigente para
// cada categoria naquela finalidade. Revogar vale imediatamente. Categoria sensível (LGPD art. 5º,
// II) exige consentimento marcado como específico.

import { type Clock, type IdFactory, systemClock, uuid } from "@obedient/core";

export const SENSITIVE_CATEGORIES = ["health", "biometric", "religion", "politics", "sex_life", "ethnicity", "union", "genetic"] as const;

export interface ConsentRecord {
  id: string;
  userId: string;
  purpose: string;
  category: string;
  givenAt: Date;
  /** Consentimento destacado e específico (exigido para categoria sensível). */
  specific: boolean;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

export interface ConsentCheck {
  ok: boolean;
  missing: string[];
}

/** Onde os consentimentos ficam. Leitura sempre por usuário (cabe na RLS). */
export interface ConsentStore {
  insert(r: ConsentRecord): Promise<void>;
  listByUser(userId: string): Promise<ConsentRecord[]>;
  /** Marca como revogados os registros ainda vigentes que casam; devolve quantos. */
  revokeWhere(userId: string, purpose: string, category: string | null, at: Date): Promise<number>;
}

export class InMemoryConsentStore implements ConsentStore {
  private readonly rows: ConsentRecord[] = [];
  async insert(r: ConsentRecord): Promise<void> {
    this.rows.push({ ...r });
  }
  async listByUser(userId: string): Promise<ConsentRecord[]> {
    return this.rows.filter((r) => r.userId === userId).map((r) => ({ ...r }));
  }
  async revokeWhere(userId: string, purpose: string, category: string | null, at: Date): Promise<number> {
    let n = 0;
    for (const r of this.rows)
      if (r.userId === userId && r.purpose === purpose && (category === null || r.category === category) && !r.revokedAt) {
        r.revokedAt = at;
        n++;
      }
    return n;
  }
}

export class ConsentManager {
  constructor(
    private readonly clock: Clock = systemClock,
    private readonly store: ConsentStore = new InMemoryConsentStore(),
    private readonly newId: IdFactory = uuid,
  ) {}

  async give(userId: string, purpose: string, category: string, opts: { specific?: boolean; expiresAt?: Date | null } = {}): Promise<ConsentRecord> {
    const r: ConsentRecord = {
      id: this.newId(),
      userId,
      purpose,
      category,
      givenAt: this.clock.now(),
      specific: opts.specific ?? false,
      expiresAt: opts.expiresAt ?? null,
      revokedAt: null,
    };
    await this.store.insert(r);
    return { ...r };
  }

  revoke(userId: string, purpose: string, category: string): Promise<number> {
    return this.store.revokeWhere(userId, purpose, category, this.clock.now());
  }

  /** Revoga tudo de uma finalidade (ex.: o usuário desliga "aprendizado"). */
  revokePurpose(userId: string, purpose: string): Promise<number> {
    return this.store.revokeWhere(userId, purpose, null, this.clock.now());
  }

  async check(userId: string, purpose: string, categories: readonly string[]): Promise<ConsentCheck> {
    const now = this.clock.now();
    const records = await this.store.listByUser(userId);
    const missing = categories.filter((category) => {
      const sensitive = (SENSITIVE_CATEGORIES as readonly string[]).includes(category);
      return !records.some(
        (r) =>
          r.userId === userId &&
          r.purpose === purpose &&
          r.category === category &&
          !r.revokedAt &&
          (!r.expiresAt || r.expiresAt > now) &&
          (!sensitive || r.specific),
      );
    });
    return { ok: missing.length === 0, missing };
  }

  /** Exportação para o titular (LGPD art. 18). */
  export(userId: string): Promise<ConsentRecord[]> {
    return this.store.listByUser(userId);
  }
}
