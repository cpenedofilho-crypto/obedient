// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Memória pessoal (CONSTITUTION.md Art. 10: aprendizado responsável).
//
//   • aprender é OPT-IN por categoria: só se guarda uma lição numa categoria em que a pessoa ligou o
//     aprendizado (consentimento de finalidade "aprendizado"). Categoria sensível exige consentimento
//     específico, como no resto do motor;
//   • toda lição pode ser vista e apagada. Desligar o aprendizado de uma categoria APAGA o que foi
//     aprendido nela (usar o mínimo, pelo menor tempo: Art. 4º);
//   • a memória que vai para o contexto do agente é só a das categorias ainda ligadas;
//   • treinar modelo de terceiro é outra finalidade, com consentimento separado, desligado por
//     padrão. Ligar o aprendizado NÃO liga isso. (O OBEDIENT não tem caminho que mande dado para
//     treino; a regra existe para que, se um dia houver, ele precise desse consentimento.)
//
// A trilha registra que uma lição foi aprendida ou apagada, a categoria e o agente, NUNCA o texto
// da lição: a trilha é só de inclusão e não pode guardar o que a pessoa tem direito de apagar.

import { type Clock, type IdFactory, ObedientError, systemClock, uuid } from "@obedient/core";
import { type AuditTrail, CONSTITUTION_VERSION, type ConsentManager, SENSITIVE_CATEGORIES } from "@obedient/ethics-engine";

export const FINALIDADE_APRENDIZADO = "aprendizado";
export const FINALIDADE_TREINO_TERCEIRO = "treinar_modelo_de_terceiro";

/** Categorias do que o agente pode aprender. Sensíveis exigem consentimento específico (LGPD art. 11). */
export const CATEGORIAS_DE_APRENDIZADO = [
  { id: "preferencias", nome: "Preferências e jeito de trabalhar", sensivel: false },
  { id: "agenda", nome: "Rotina e agenda", sensivel: false },
  { id: "contacts", nome: "Pessoas e contatos", sensivel: false },
  { id: "trabalho", nome: "Trabalho e projetos", sensivel: false },
  { id: "financas", nome: "Finanças", sensivel: false },
  { id: "health", nome: "Saúde", sensivel: true },
] as const;
export type CategoriaDeAprendizado = (typeof CATEGORIAS_DE_APRENDIZADO)[number]["id"];

// As sensíveis daqui são as mesmas que o Consent Manager trata como sensíveis.
for (const c of CATEGORIAS_DE_APRENDIZADO)
  if (c.sensivel !== (SENSITIVE_CATEGORIES as readonly string[]).includes(c.id)) throw new Error(`categoria ${c.id}: sensibilidade diverge do Consent Manager`);

export const MAX_TEXTO_LICAO = 500;
export const MAX_LICOES_POR_USUARIO = 2000;

export interface Licao {
  id: string;
  userId: string;
  categoria: CategoriaDeAprendizado;
  /** O que foi aprendido, em uma frase. Dado do usuário: nunca vai para a trilha. */
  texto: string;
  /** Agente que aprendeu. */
  agente: string;
  aprendidaEm: Date;
}

export interface MemoryStore {
  insert(l: Licao): Promise<void>;
  listByUser(userId: string): Promise<Licao[]>;
  /** Apaga uma lição do usuário; devolve se existia. */
  delete(userId: string, id: string): Promise<boolean>;
  /** Apaga as lições do usuário (de uma categoria, ou todas); devolve quantas. */
  deleteWhere(userId: string, categoria: CategoriaDeAprendizado | null): Promise<number>;
}

export class InMemoryMemoryStore implements MemoryStore {
  private rows: Licao[] = [];
  async insert(l: Licao) {
    this.rows.push({ ...l });
  }
  async listByUser(userId: string) {
    return this.rows.filter((l) => l.userId === userId).map((l) => ({ ...l }));
  }
  async delete(userId: string, id: string) {
    const antes = this.rows.length;
    this.rows = this.rows.filter((l) => !(l.userId === userId && l.id === id));
    return this.rows.length < antes;
  }
  async deleteWhere(userId: string, categoria: CategoriaDeAprendizado | null) {
    const antes = this.rows.length;
    this.rows = this.rows.filter((l) => !(l.userId === userId && (categoria === null || l.categoria === categoria)));
    return antes - this.rows.length;
  }
}

const ehCategoria = (c: string): c is CategoriaDeAprendizado => CATEGORIAS_DE_APRENDIZADO.some((x) => x.id === c);
const sensivel = (c: CategoriaDeAprendizado) => CATEGORIAS_DE_APRENDIZADO.find((x) => x.id === c)!.sensivel;

export class Memoria {
  constructor(
    private readonly store: MemoryStore,
    private readonly consent: ConsentManager,
    private readonly audit: AuditTrail,
    private readonly clock: Clock = systemClock,
    private readonly newId: IdFactory = uuid,
  ) {}

  /** A pessoa liga o aprendizado de uma categoria. Sensível exige marcar o consentimento como específico. */
  async ligar(userId: string, categoria: string, opts: { especifico?: boolean } = {}): Promise<void> {
    if (!ehCategoria(categoria)) throw new ObedientError("INVALID_PAYLOAD", "categoria de aprendizado desconhecida");
    if (sensivel(categoria) && !opts.especifico) throw new ObedientError("INVALID_PAYLOAD", "categoria sensível exige consentimento específico");
    if (await this.ligada(userId, categoria)) return;
    await this.consent.give(userId, FINALIDADE_APRENDIZADO, categoria, { specific: sensivel(categoria) });
    await this.registrar(userId, `user:${userId}`, "memory.opt_in", categoria);
  }

  /** A pessoa desliga: o consentimento é revogado e o que foi aprendido na categoria é apagado. */
  async desligar(userId: string, categoria: string): Promise<number> {
    if (!ehCategoria(categoria)) throw new ObedientError("INVALID_PAYLOAD", "categoria de aprendizado desconhecida");
    await this.consent.revoke(userId, FINALIDADE_APRENDIZADO, categoria);
    const apagadas = await this.store.deleteWhere(userId, categoria);
    await this.registrar(userId, `user:${userId}`, "memory.opt_out", categoria, apagadas);
    return apagadas;
  }

  async ligada(userId: string, categoria: CategoriaDeAprendizado): Promise<boolean> {
    return (await this.consent.check(userId, FINALIDADE_APRENDIZADO, [categoria])).ok;
  }

  /** As categorias com o estado de cada uma, para a tela. */
  async categorias(userId: string) {
    const out = [];
    for (const c of CATEGORIAS_DE_APRENDIZADO) out.push({ ...c, ligada: await this.ligada(userId, c.id) });
    return out;
  }

  /** O agente aprende algo. Sem a categoria ligada, não guarda nada (e a recusa fica na trilha). */
  async lembrar(userId: string, agente: string, categoria: string, texto: string): Promise<Licao> {
    if (!ehCategoria(categoria)) throw new ObedientError("INVALID_PAYLOAD", "categoria de aprendizado desconhecida");
    const limpo = typeof texto === "string" ? texto.replace(/\s+/g, " ").trim() : "";
    if (!limpo || limpo.length > MAX_TEXTO_LICAO) throw new ObedientError("INVALID_PAYLOAD", `a lição precisa ter de 1 a ${MAX_TEXTO_LICAO} caracteres`);
    if (agente === userId) throw new ObedientError("INVALID_PAYLOAD", "o agente não pode se apresentar como o usuário");
    if (!(await this.ligada(userId, categoria))) {
      await this.registrar(userId, `agent:${agente}`, "memory.learn", categoria, undefined, "denied");
      throw new ObedientError("CONSENT_REQUIRED", `aprendizado de ${categoria} está desligado (Art. 10)`);
    }
    if ((await this.store.listByUser(userId)).length >= MAX_LICOES_POR_USUARIO) throw new ObedientError("INVALID_PAYLOAD", "memória cheia: apague lições antigas");
    const l: Licao = { id: this.newId(), userId, categoria, texto: limpo, agente, aprendidaEm: this.clock.now() };
    await this.store.insert(l);
    await this.registrar(userId, `agent:${agente}`, "memory.learn", categoria);
    return { ...l };
  }

  /** Tudo o que o agente sabe da pessoa, inclusive o que estiver numa categoria já desligada (não deveria haver). */
  listar(userId: string): Promise<Licao[]> {
    return this.store.listByUser(userId);
  }

  /** O que vai para o contexto do agente: só lições de categorias ainda ligadas. */
  async paraContexto(userId: string): Promise<Licao[]> {
    const ligadas = new Set<string>();
    for (const c of CATEGORIAS_DE_APRENDIZADO) if (await this.ligada(userId, c.id)) ligadas.add(c.id);
    return (await this.store.listByUser(userId)).filter((l) => ligadas.has(l.categoria));
  }

  async esquecer(userId: string, id: string): Promise<boolean> {
    const l = (await this.store.listByUser(userId)).find((x) => x.id === id);
    if (!l) return false;
    await this.store.delete(userId, id);
    await this.registrar(userId, `user:${userId}`, "memory.forget", l.categoria);
    return true;
  }

  /** Apaga tudo o que foi aprendido e desliga todas as categorias. */
  async esquecerTudo(userId: string): Promise<number> {
    for (const c of CATEGORIAS_DE_APRENDIZADO) await this.consent.revoke(userId, FINALIDADE_APRENDIZADO, c.id);
    const n = await this.store.deleteWhere(userId, null);
    await this.registrar(userId, `user:${userId}`, "memory.forget_all", "todas", n);
    return n;
  }

  /** Treinar modelo de terceiro com dado da pessoa: só com o consentimento SEPARADO desta finalidade. */
  async podeTreinarModeloDeTerceiro(userId: string): Promise<boolean> {
    return (await this.consent.check(userId, FINALIDADE_TREINO_TERCEIRO, ["memoria"])).ok;
  }

  private async registrar(userId: string, actor: string, event: string, categoria: string, quantas?: number, outcome: "info" | "denied" = "info") {
    await this.audit.record({
      userId,
      actor,
      event,
      outcome,
      reasons: [quantas === undefined ? `categoria ${categoria}` : `categoria ${categoria}: ${quantas} lição(ões)`],
      constitutionVersion: CONSTITUTION_VERSION,
    });
  }
}
