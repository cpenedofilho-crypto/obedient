// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Missões: o que a pessoa pede ao agente e o agente persegue em tentativas.
//
// Art. 7º (persistência responsável):
//   • tentativa tem teto (no máximo LIMITES_EQUIPE.maxTentativas) e intervalo crescente
//     (30 s, 1 min, 2 min, … até 1 h);
//   • missão que não avança vira IMPEDIMENTO explicado à pessoa, nunca laço: bateu no teto de
//     tentativas, bateu no teto de custo, ou o pedido de aprovação foi recusado ou venceu;
//   • há teto de custo por missão, conferido antes de cada tentativa e depois de cada uma.
// Art. 5º (honestidade): "não sei" e "não consegui" são desfechos válidos, registrados como tais.
// Art. 9º (interrupção): parada de emergência cancela as missões em aberto e nenhuma tentativa
//   começa com a parada acionada.
//
// Quem faz a tentativa é uma porta (Executor): no servidor, o laço do agente (agent-orchestrator)
// com as ferramentas governadas pelo Ethics Engine. Aqui fica só a regra.
//
// A explicação de um desfecho pode ter conteúdo da pessoa: fica na missão (que a pessoa apaga), não
// na trilha. A trilha registra o tipo de desfecho, a tentativa e o custo.

import { type Clock, type IdFactory, ObedientError, systemClock, uuid } from "@obedient/core";
import { CONSTITUTION_VERSION, type EthicsEngine } from "@obedient/ethics-engine";
import { LIMITES_EQUIPE } from "@obedient/mission-engine";

export const ESTADOS_MISSAO = ["running", "waiting_approval", "blocked", "completed", "failed", "cancelled"] as const;
export type EstadoMissao = (typeof ESTADOS_MISSAO)[number];
export const ABERTAS: readonly EstadoMissao[] = ["running", "waiting_approval", "blocked"];

export const INTERVALO_BASE_MS = 30_000;
export const INTERVALO_MAXIMO_MS = 60 * 60_000;
/** Teto de custo padrão e máximo por missão, em centavos (R$ 5 e R$ 100). */
export const TETO_CUSTO_PADRAO = 500;
export const TETO_CUSTO_MAXIMO = 10_000;
export const MAX_OBJETIVO = 2000;
export const MAX_EXPLICACAO = 2000;

export type TipoDesfecho = "feito" | "nao_sei" | "nao_consegui";

export interface Missao {
  id: string;
  userId: string;
  agente: string;
  objetivo: string;
  estado: EstadoMissao;
  /** Por que parou e o que a pessoa pode fazer (só quando blocked). */
  impedimento: string | null;
  desfecho: { tipo: TipoDesfecho; explicacao: string } | null;
  tentativas: number;
  maxTentativas: number;
  proximaTentativaEm: Date | null;
  custoCentavos: number;
  tetoCustoCentavos: number;
  /** Pedido de aprovação que a missão espera (quando waiting_approval). */
  propostaId: string | null;
  criadaEm: Date;
  atualizadaEm: Date;
  /** Sobe a cada gravação: a troca é atômica pela versão lida (duas tentativas nunca se cruzam). */
  versao: number;
}

/** O que uma tentativa devolve. `custoCentavos` é o gasto da tentativa (modelo, ferramentas). */
export type ResultadoTentativa = { custoCentavos: number } & (
  | { tipo: TipoDesfecho; explicacao: string }
  | { tipo: "falha_temporaria"; erro: string }
  | { tipo: "aguardando_aprovacao"; propostaId: string }
);

export type Executor = (m: Missao) => Promise<ResultadoTentativa>;

export interface MissionStore {
  insert(m: Missao): Promise<void>;
  get(id: string): Promise<Missao | undefined>;
  listByUser(userId: string): Promise<Missao[]>;
  /** Grava só se a versão guardada ainda for `versaoLida` (compare-and-set). */
  update(m: Missao, versaoLida: number): Promise<boolean>;
}

export class InMemoryMissionStore implements MissionStore {
  private readonly rows = new Map<string, Missao>();
  async insert(m: Missao) {
    this.rows.set(m.id, structuredClone(m));
  }
  async get(id: string) {
    const m = this.rows.get(id);
    return m ? structuredClone(m) : undefined;
  }
  async listByUser(userId: string) {
    return [...this.rows.values()].filter((m) => m.userId === userId).map((m) => structuredClone(m));
  }
  async update(m: Missao, versaoLida: number) {
    const atual = this.rows.get(m.id);
    if (!atual || atual.versao !== versaoLida) return false;
    this.rows.set(m.id, structuredClone(m));
    return true;
  }
}

/** Intervalo antes da tentativa n+1, depois de n falhas: 30 s, 1 min, 2 min, … até 1 h. */
export function intervaloDepois(falhas: number): number {
  return Math.min(INTERVALO_BASE_MS * 2 ** Math.max(0, falhas - 1), INTERVALO_MAXIMO_MS);
}

const reais = (centavos: number) => (centavos / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const curto = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export class Missoes {
  constructor(
    private readonly store: MissionStore,
    private readonly motor: EthicsEngine,
    private readonly clock: Clock = systemClock,
    private readonly newId: IdFactory = uuid,
  ) {
    // Art. 9º: parar cancela o que estava em aberto, no mesmo commit da parada.
    motor.stop.onEngage(async (scope) => {
      if (scope.kind === "user") await this.cancelarTodas(scope.userId, "parada de emergência");
    });
  }

  /** A pessoa pede uma missão. */
  async criar(userId: string, agente: string, objetivo: string, opts: { tetoCustoCentavos?: number; maxTentativas?: number } = {}): Promise<Missao> {
    const texto = typeof objetivo === "string" ? objetivo.replace(/\s+/g, " ").trim() : "";
    if (!texto || texto.length > MAX_OBJETIVO) throw new ObedientError("INVALID_PAYLOAD", `o objetivo precisa ter de 1 a ${MAX_OBJETIVO} caracteres`);
    if (agente === userId) throw new ObedientError("INVALID_PAYLOAD", "o agente não pode ser a própria pessoa");
    const teto = opts.tetoCustoCentavos ?? TETO_CUSTO_PADRAO;
    if (!Number.isInteger(teto) || teto < 1 || teto > TETO_CUSTO_MAXIMO) throw new ObedientError("INVALID_PAYLOAD", `teto de custo entre 1 e ${TETO_CUSTO_MAXIMO} centavos`);
    const max = opts.maxTentativas ?? 3;
    if (!Number.isInteger(max) || max < 1 || max > LIMITES_EQUIPE.maxTentativas) throw new ObedientError("INVALID_PAYLOAD", `de 1 a ${LIMITES_EQUIPE.maxTentativas} tentativas`);
    const agora = this.clock.now();
    const m: Missao = {
      id: this.newId(),
      userId,
      agente,
      objetivo: texto,
      estado: "running",
      impedimento: null,
      desfecho: null,
      tentativas: 0,
      maxTentativas: max,
      proximaTentativaEm: agora,
      custoCentavos: 0,
      tetoCustoCentavos: teto,
      propostaId: null,
      criadaEm: agora,
      atualizadaEm: agora,
      versao: 1,
    };
    await this.store.insert(m);
    await this.registrar(m, "mission.created", "info", [`teto ${reais(teto)}, até ${max} tentativa(s)`]);
    return structuredClone(m);
  }

  get(id: string) {
    return this.store.get(id);
  }

  listar(userId: string) {
    return this.store.listByUser(userId);
  }

  /** Missões do usuário cuja próxima tentativa já chegou. */
  async devidas(userId: string): Promise<Missao[]> {
    const agora = this.clock.now().getTime();
    return (await this.store.listByUser(userId)).filter((m) => (m.estado === "running" && (m.proximaTentativaEm?.getTime() ?? Infinity) <= agora) || m.estado === "waiting_approval");
  }

  /**
   * Avança uma missão: no máximo UMA tentativa. Atalho para reservar → executar → concluir com o
   * mesmo armazenamento (memória, testes). No servidor, cada passo é uma transação curta e a
   * tentativa (que pode levar minutos) roda FORA do banco.
   */
  async avancar(id: string, executar: Executor): Promise<Missao> {
    const r = await this.reservar(id);
    if (!r.reservada) return r.missao;
    let resultado: ResultadoTentativa;
    try {
      resultado = await executar(structuredClone(r.missao));
    } catch (e) {
      resultado = { tipo: "falha_temporaria", erro: e instanceof Error ? e.message : String(e), custoCentavos: 0 };
    }
    return this.concluir(r.missao, resultado);
  }

  /**
   * Passo 1: confere parada, aprovação pendente, hora e teto de custo; se puder tentar, CONTA a
   * tentativa e grava (se o processo cair durante a execução, ela já contou). Duas chamadas ao mesmo
   * tempo: só uma reserva (troca atômica pela versão).
   */
  async reservar(id: string): Promise<{ reservada: true; missao: Missao } | { reservada: false; missao: Missao }> {
    const m = await this.store.get(id);
    if (!m) throw new ObedientError("PROPOSAL_NOT_FOUND", "missão inexistente");
    const nao = (x: Missao) => ({ reservada: false as const, missao: x });
    if (!ABERTAS.includes(m.estado) || m.estado === "blocked") return nao(m);

    const parada = await this.motor.stop.blocking(m.userId);
    if (parada) return nao(await this.cancelar(m, `parada de emergência: ${parada.reason}`));

    if (m.estado === "waiting_approval") {
      const p = m.propostaId ? await this.motor.approvals.get(m.propostaId) : undefined;
      if (!p || p.status === "pending") return nao(m); // a pessoa ainda não decidiu
      if (p.status === "rejected" || p.status === "expired")
        return nao(
          await this.bloquear(
            m,
            p.status === "rejected"
              ? "Você recusou o pedido que a missão precisava. Diga se quer tentar de outro jeito ou cancelar."
              : "O pedido de aprovação venceu sem resposta. Tente de novo quando puder responder, ou cancele.",
          ),
        );
      // Aprovado (ou já executado): segue com uma nova tentativa agora.
      m.estado = "running";
      m.propostaId = null;
      m.proximaTentativaEm = this.clock.now();
    }
    if ((m.proximaTentativaEm?.getTime() ?? Infinity) > this.clock.now().getTime()) return nao(m);

    if (m.custoCentavos >= m.tetoCustoCentavos) return nao(await this.bloquear(m, this.textoTeto(m)));

    m.tentativas += 1;
    m.proximaTentativaEm = null;
    m.atualizadaEm = this.clock.now();
    if (!(await this.salvar(m))) return nao((await this.store.get(id))!);
    return { reservada: true, missao: m };
  }

  /**
   * Passo 2: aplica o resultado da tentativa reservada. Se a missão mudou no meio (a pessoa cancelou,
   * apertou parar), o resultado é descartado e a missão fica como a pessoa deixou.
   */
  async concluir(reservada: Missao, r: ResultadoTentativa): Promise<Missao> {
    const m = structuredClone(reservada);
    const custo = Number.isFinite(r.custoCentavos) && r.custoCentavos > 0 ? Math.ceil(r.custoCentavos) : 0;
    m.custoCentavos += custo;
    m.atualizadaEm = this.clock.now();
    const sobre = [`tentativa ${m.tentativas} de ${m.maxTentativas}`, `custo ${reais(custo)} (total ${reais(m.custoCentavos)})`];

    switch (r.tipo) {
      case "feito":
      case "nao_sei":
      case "nao_consegui": {
        m.estado = r.tipo === "nao_consegui" ? "failed" : "completed";
        m.desfecho = { tipo: r.tipo, explicacao: curto(String(r.explicacao ?? "").trim() || "(sem explicação)", MAX_EXPLICACAO) };
        if (!(await this.salvar(m))) return this.descartada(reservada, r.tipo);
        await this.registrar(m, `mission.${r.tipo}`, r.tipo === "feito" ? "executed" : r.tipo === "nao_sei" ? "info" : "failed", sobre);
        return m;
      }
      case "aguardando_aprovacao":
        m.estado = "waiting_approval";
        m.propostaId = r.propostaId;
        if (!(await this.salvar(m))) return this.descartada(reservada, r.tipo);
        await this.registrar(m, "mission.waiting_approval", "approval_required", sobre);
        return m;
      case "falha_temporaria": {
        if (m.tentativas >= m.maxTentativas) {
          m.estado = "blocked";
          m.impedimento = `Tentou ${m.tentativas} vez(es) e não conseguiu. Último erro: ${curto(String(r.erro), 200)}. Diga se quer tentar de novo ou cancelar.`;
        } else if (m.custoCentavos >= m.tetoCustoCentavos) {
          m.estado = "blocked";
          m.impedimento = this.textoTeto(m);
        } else m.proximaTentativaEm = new Date(this.clock.now().getTime() + intervaloDepois(m.tentativas));
        if (!(await this.salvar(m))) return this.descartada(reservada, r.tipo);
        await this.registrar(m, "mission.attempt_failed", "failed", sobre);
        if (m.estado === "blocked") await this.registrar(m, "mission.blocked", "info", [curto(m.impedimento!, 200)]);
        return m;
      }
    }
  }

  private textoTeto(m: Missao) {
    return `Chegou ao teto de custo (${reais(m.tetoCustoCentavos)}) sem terminar. Aumente o teto ou cancele.`;
  }

  /** Resultado que chegou depois de a missão mudar (cancelada, parada): fica registrado e não se aplica. */
  private async descartada(m: Missao, tipo: string): Promise<Missao> {
    const atual = (await this.store.get(m.id))!;
    await this.registrar(atual, "mission.result_discarded", "info", [`resultado "${tipo}" chegou depois de a missão mudar para ${atual.estado}`]);
    return atual;
  }

  /** A pessoa destrava um impedimento: zera as tentativas e, se quiser, sobe o teto de custo. */
  async tentarDeNovo(userId: string, id: string, opts: { novoTetoCentavos?: number } = {}): Promise<Missao> {
    const m = await this.store.get(id);
    if (!m || m.userId !== userId) throw new ObedientError("PROPOSAL_NOT_FOUND", "missão inexistente");
    if (m.estado !== "blocked") throw new ObedientError("PROPOSAL_NOT_PENDING", "a missão não está parada esperando você");
    if (opts.novoTetoCentavos !== undefined) {
      const t = opts.novoTetoCentavos;
      if (!Number.isInteger(t) || t <= m.tetoCustoCentavos || t > TETO_CUSTO_MAXIMO) throw new ObedientError("INVALID_PAYLOAD", `o novo teto precisa ser maior que o atual e até ${TETO_CUSTO_MAXIMO} centavos`);
      m.tetoCustoCentavos = t;
    }
    if (m.custoCentavos >= m.tetoCustoCentavos) throw new ObedientError("INVALID_PAYLOAD", "o teto de custo já foi atingido: aumente o teto para tentar de novo");
    m.estado = "running";
    m.impedimento = null;
    m.tentativas = 0;
    m.propostaId = null;
    m.proximaTentativaEm = this.clock.now();
    m.atualizadaEm = this.clock.now();
    if (!(await this.salvar(m))) throw new ObedientError("PROPOSAL_NOT_PENDING", "a missão mudou enquanto isso");
    await this.registrar(m, "mission.retry", "info", [`teto ${reais(m.tetoCustoCentavos)}`]);
    return m;
  }

  async cancelarPelaPessoa(userId: string, id: string): Promise<Missao> {
    const m = await this.store.get(id);
    if (!m || m.userId !== userId) throw new ObedientError("PROPOSAL_NOT_FOUND", "missão inexistente");
    if (!ABERTAS.includes(m.estado)) throw new ObedientError("PROPOSAL_NOT_PENDING", "a missão já terminou");
    return this.cancelar(m, "cancelada por você");
  }

  async cancelarTodas(userId: string, motivo: string): Promise<number> {
    let n = 0;
    for (const m of await this.store.listByUser(userId)) if (ABERTAS.includes(m.estado)) if ((await this.cancelar(m, motivo)).estado === "cancelled") n++;
    return n;
  }

  private async cancelar(m: Missao, motivo: string): Promise<Missao> {
    m.estado = "cancelled";
    m.proximaTentativaEm = null;
    m.atualizadaEm = this.clock.now();
    if (!(await this.salvar(m))) return (await this.store.get(m.id))!;
    await this.registrar(m, "mission.cancelled", "info", [motivo]);
    return m;
  }

  private async bloquear(m: Missao, impedimento: string): Promise<Missao> {
    m.estado = "blocked";
    m.impedimento = impedimento;
    m.proximaTentativaEm = null;
    m.atualizadaEm = this.clock.now();
    await this.gravar(m);
    // O texto do impedimento é do sistema (não da pessoa): pode ir para a trilha.
    await this.registrar(m, "mission.blocked", "info", [curto(impedimento, 200)]);
    return m;
  }

  private async gravar(m: Missao) {
    if (!(await this.salvar(m))) throw new ObedientError("PROPOSAL_NOT_PENDING", "a missão mudou enquanto a tentativa rodava (cancelada ou parada)");
  }

  /** Grava com a versão lida e sobe a versão. false = outra gravação chegou antes. */
  private async salvar(m: Missao): Promise<boolean> {
    const lida = m.versao;
    m.versao = lida + 1;
    const ok = await this.store.update(m, lida);
    if (!ok) m.versao = lida;
    return ok;
  }

  private registrar(m: Missao, event: string, outcome: "info" | "executed" | "failed" | "approval_required", reasons: string[]) {
    return this.motor.audit.record({
      userId: m.userId,
      actor: ["mission.created", "mission.retry", "mission.cancelled"].includes(event) ? `user:${m.userId}` : `agent:${m.agente}`,
      event,
      outcome,
      reasons,
      correlationId: m.id,
      ...(m.propostaId ? { proposalId: m.propostaId } : {}),
      constitutionVersion: CONSTITUTION_VERSION,
    });
  }
}
