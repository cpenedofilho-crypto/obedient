// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Consent Manager (CONSTITUTION.md Art. 4º e 10; LGPD arts. 7º, 8º, 11).
//
// Consentimento é por FINALIDADE e por CATEGORIA de dado. A ferramenta declara as categorias
// que toca (no registro, nunca o modelo); a ação só passa se houver consentimento vigente para
// cada categoria naquela finalidade. Revogar vale imediatamente. Categoria sensível (LGPD art. 5º,
// II) exige consentimento marcado como específico.

import { type Clock, systemClock } from "@obedient/core";

export const SENSITIVE_CATEGORIES = ["health", "biometric", "religion", "politics", "sex_life", "ethnicity", "union", "genetic"] as const;

export interface ConsentRecord {
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

export class ConsentManager {
  private readonly records: ConsentRecord[] = [];
  constructor(private readonly clock: Clock = systemClock) {}

  give(userId: string, purpose: string, category: string, opts: { specific?: boolean; expiresAt?: Date | null } = {}): ConsentRecord {
    const r: ConsentRecord = {
      userId,
      purpose,
      category,
      givenAt: this.clock.now(),
      specific: opts.specific ?? false,
      expiresAt: opts.expiresAt ?? null,
      revokedAt: null,
    };
    this.records.push(r);
    return { ...r };
  }

  revoke(userId: string, purpose: string, category: string): number {
    const now = this.clock.now();
    let n = 0;
    for (const r of this.records)
      if (r.userId === userId && r.purpose === purpose && r.category === category && !r.revokedAt) {
        r.revokedAt = now;
        n++;
      }
    return n;
  }

  /** Revoga tudo de uma finalidade (ex.: o usuário desliga "aprendizado"). */
  revokePurpose(userId: string, purpose: string): number {
    const now = this.clock.now();
    let n = 0;
    for (const r of this.records)
      if (r.userId === userId && r.purpose === purpose && !r.revokedAt) {
        r.revokedAt = now;
        n++;
      }
    return n;
  }

  check(userId: string, purpose: string, categories: readonly string[]): ConsentCheck {
    const now = this.clock.now();
    const missing = categories.filter((category) => {
      const sensitive = (SENSITIVE_CATEGORIES as readonly string[]).includes(category);
      return !this.records.some(
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
  export(userId: string): ConsentRecord[] {
    return this.records.filter((r) => r.userId === userId).map((r) => ({ ...r }));
  }
}
