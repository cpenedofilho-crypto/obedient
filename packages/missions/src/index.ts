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
// Durabilidade: a reserva de uma tentativa tem PRAZO (PRAZO_RESERVA_MS). Se o processo cair no meio
// da tentativa, ninguém a conclui; vencido o prazo, a missão volta a ser devida (também na função do
// agendador, que lê proxima_tentativa_em), e a retomada é uma tentativa nova, dentro do teto, com a
// interrupção registrada. A ação aprovada que já tinha sido reivindicada não roda de novo: quem
// garante é a troca approved → executing do Ethics Engine. O resultado tardio do processo antigo
// chega com a versão velha e é descartado.
//
// Quem faz a tentativa é uma porta (Executor): no servidor, o laço do agente (agent-orchestrator)
// com as ferramentas governadas pelo Ethics Engine. Aqui fica só a regra.
//
// A explicação de um desfecho pode ter conteúdo da pessoa: fica na missão (que a pessoa apaga), não
// na trilha. A trilha registra o tipo de desfecho, a tentativa e o custo.

import { type Clock, type IdFactory, ObedientError, systemClock, uuid } from "@obedient/core";
import { CONSTITUTION_VERSION, type EthicsEngine } from "@obedient/ethics-engine";
import { LIMITES_EQUIPE } from "@obedient/mission-engine";
import { type PlanoDaMissao, type TarefaDoPlano, hashDoPlano, lerTarefas } from "./plano.ts";
import { type Criterio, type Evidencia, problemasDosCriterios, textoNaoVerificada, verificar } from "./verificacao.ts";

import { type Mandato, TETO_MENSAL_CENTAVOS, inicioDoMes, lerMandato, problemasDoMandato } from "./mandato.ts";

export * from "./verificacao.ts";
export * from "./mandato.ts";
export * from "./plano.ts";

/**
 * Estados da missão (decisão D20, marco M2). `planning` e `verifying` já estão na tabela, mas só entram
 * em uso com o planejador (M5) e o verificador (M3).
 *   created: criada, esperando a primeira tentativa · planning: o plano está sendo feito ·
 *   running: uma tentativa está reservada e rodando · verifying: os critérios estão sendo conferidos ·
 *   retrying: falhou de passagem e espera a hora da próxima tentativa · waiting_approval: espera a
 *   pessoa decidir um pedido · blocked: parou e precisa da pessoa · completed, failed, cancelled: fim.
 */
export const ESTADOS_MISSAO = ["created", "planning", "running", "verifying", "retrying", "waiting_approval", "blocked", "completed", "failed", "cancelled"] as const;
export type EstadoMissao = (typeof ESTADOS_MISSAO)[number];
export const TERMINAIS: readonly EstadoMissao[] = ["completed", "failed", "cancelled"];
export const ABERTAS: readonly EstadoMissao[] = ESTADOS_MISSAO.filter((e) => !TERMINAIS.includes(e));

/**
 * A ÚNICA tabela de transições da missão. Todo `estado` muda por `podeMudar`/`Missoes.mudar`, e o banco
 * confere a mesma tabela num gatilho (0009). Duas arestas são provisórias e saem quando a peça que as
 * substitui chegar: created → running (até o planejador, M5). Desde o M3, nada termina sem passar por
 * verifying. Terminal não sai para lugar nenhum.
 */
export const TRANSICOES: Readonly<Record<EstadoMissao, readonly EstadoMissao[]>> = {
  // created → blocked desde o M4: o teto do mês pode parar a missão antes da primeira tentativa.
  created: ["planning", "running", "blocked", "failed", "cancelled"],
  // planning → retrying e retrying → planning desde o M5: o planejador também tem falha passageira.
  planning: ["running", "waiting_approval", "retrying", "blocked", "failed", "cancelled"],
  running: ["verifying", "waiting_approval", "retrying", "blocked", "failed", "cancelled"],
  verifying: ["completed", "running", "blocked", "failed", "cancelled"],
  retrying: ["planning", "running", "blocked", "failed", "cancelled"],
  waiting_approval: ["running", "blocked", "failed", "cancelled"],
  blocked: ["retrying", "planning", "running", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function podeMudar(de: EstadoMissao, para: EstadoMissao): boolean {
  return TRANSICOES[de]?.includes(para) ?? false;
}

/** Estados em que a missão espera uma tentativa (o agendador a pega quando a hora chega). */
export const DEVIDAS: readonly EstadoMissao[] = ["created", "retrying", "running", "planning"];

export const INTERVALO_BASE_MS = 30_000;
export const INTERVALO_MAXIMO_MS = 60 * 60_000;
/** Teto de custo padrão e máximo por missão, em centavos (R$ 15 e R$ 100; decisão D21). */
export const TETO_CUSTO_PADRAO = 1500;
export const TETO_CUSTO_MAXIMO = 10_000;
export const MAX_OBJETIVO = 2000;
export const MAX_EXPLICACAO = 2000;
/**
 * Prazo da reserva de uma tentativa. Maior que o prazo de uma rodada do agente (10 min no servidor),
 * para uma tentativa lenta, mas viva, não ser tomada por outro processo.
 */
export const PRAZO_RESERVA_MS = 15 * 60_000;
/** Dono da reserva quando quem reserva não se identifica (testes, uso em memória). */
export const DONO_PADRAO = "processo";

export type TipoDesfecho = "feito" | "nao_sei" | "nao_consegui";

export interface Missao {
  id: string;
  userId: string;
  agente: string;
  objetivo: string;
  /** Critérios de conclusão (M3), fixados na criação. Vazio = a evidência diz que não havia critério. */
  criterios: Criterio[];
  /** Mandato (M4), fixado na criação: só estreita o que os grants permitem. */
  mandato: Mandato;
  /** Planejar antes (M5): a missão passa por planning e espera a pessoa aprovar o plano. */
  planejar: boolean;
  /** Último número de plano usado (sobe a cada plano novo). */
  planoVersao: number;
  /** O plano em vigor (null: sem plano, ou o último foi recusado). */
  plano: PlanoDaMissao | null;
  estado: EstadoMissao;
  /** Por que parou e o que a pessoa pode fazer (só quando blocked). */
  impedimento: string | null;
  desfecho: { tipo: TipoDesfecho; explicacao: string } | null;
  tentativas: number;
  maxTentativas: number;
  proximaTentativaEm: Date | null;
  /**
   * Até quando a tentativa em andamento está reservada (null = nenhuma em andamento). Na reserva,
   * proximaTentativaEm = reservadaAte: se o processo cair, a missão volta a ser devida quando vencer.
   */
  reservadaAte: Date | null;
  /**
   * Cerca da reserva (M5): sobe a cada reserva e nunca desce. Todo passo gravado leva a cerca da
   * reserva em que nasceu, e o banco recusa passo com cerca velha: o processo que perdeu a reserva
   * não chama mais nada.
   */
  cerca: number;
  /** Qual processo tem a reserva (nome do processo, sem dado da pessoa); null sem tentativa em andamento. */
  reservadaPor: string | null;
  custoCentavos: number;
  tetoCustoCentavos: number;
  /** Pedido de aprovação que a missão espera (quando waiting_approval). */
  propostaId: string | null;
  /**
   * Onde a tentativa parou (a conversa com o modelo), guardado pelo executor para continuar dali:
   * depois da aprovação, ou depois de uma falha passageira. Opaco para esta camada. Tem conteúdo da
   * pessoa: some ao terminar, impedir, cancelar e apagar.
   */
  rodada: unknown;
  criadaEm: Date;
  atualizadaEm: Date;
  /** Sobe a cada gravação: a troca é atômica pela versão lida (duas tentativas nunca se cruzam). */
  versao: number;
}

/** O que uma tentativa devolve. `custoCentavos` é o gasto da tentativa (modelo, ferramentas). */
export type ResultadoTentativa = { custoCentavos: number } & (
  // "feito" traz as evidências que o executor conferiu; sem elas, a missão confere o que puder (só os
  // critérios que não dependem do registro de passos) e nunca dá por verificado o que não viu.
  | { tipo: TipoDesfecho; explicacao: string; evidencias?: Evidencia[] }
  | { tipo: "falha_temporaria"; erro: string; rodada?: unknown }
  | { tipo: "aguardando_aprovacao"; propostaId: string; rodada?: unknown }
  // A tentativa não pode seguir sem a pessoa (por exemplo, uma ação ficou sem resultado confirmado):
  // a missão para com o motivo, sem gastar outra tentativa nem repetir nada sozinha.
  | { tipo: "impedida"; motivo: string }
  // O planejador (M5) entregou as tarefas; a missão espera a pessoa aprovar o plano.
  | { tipo: "plano"; tarefas: TarefaDoPlano[] }
);

export type Executor = (m: Missao) => Promise<ResultadoTentativa>;

export interface MissionStore {
  insert(m: Missao): Promise<void>;
  get(id: string): Promise<Missao | undefined>;
  listByUser(userId: string): Promise<Missao[]>;
  /** Grava só se a versão guardada ainda for `versaoLida` (compare-and-set). */
  update(m: Missao, versaoLida: number): Promise<boolean>;
  /** Guarda as evidências da verificação (só inserção). */
  gravarEvidencias(m: Missao, evidencias: readonly Evidencia[]): Promise<void>;
  evidencias(missionId: string): Promise<(Evidencia & { tentativa: number })[]>;
  /** Gasto de uma tentativa (só inserção), para o teto mensal (M4). */
  registrarGasto(m: Missao, centavos: number, em: Date): Promise<void>;
  /** Soma do que a pessoa gastou desde `desde`, em todas as missões. */
  gastoDesde(userId: string, desde: Date): Promise<number>;
  /** Grava as tarefas do plano `plano.versao` (só inserção). Chamado antes de salvar a missão. */
  gravarPlano(m: Missao, plano: PlanoDaMissao): Promise<void>;
  /** Chaves das tarefas feitas do plano `versao`. */
  tarefasFeitas(missionId: string, versao: number): Promise<string[]>;
  /** Marca a tarefa feita; false se já estava feita. */
  marcarTarefaFeita(m: Missao, versao: number, chave: string, em: Date): Promise<boolean>;
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
  private readonly provas = new Map<string, (Evidencia & { tentativa: number })[]>();
  async gravarEvidencias(m: Missao, evidencias: readonly Evidencia[]) {
    const l = this.provas.get(m.id) ?? [];
    l.push(...evidencias.map((e) => ({ ...structuredClone(e), tentativa: m.tentativas })));
    this.provas.set(m.id, l);
  }
  async evidencias(missionId: string) {
    return structuredClone(this.provas.get(missionId) ?? []);
  }
  private readonly gastos: { userId: string; centavos: number; em: Date }[] = [];
  async registrarGasto(m: Missao, centavos: number, em: Date) {
    this.gastos.push({ userId: m.userId, centavos, em: new Date(em) });
  }
  async gastoDesde(userId: string, desde: Date) {
    return this.gastos.filter((g) => g.userId === userId && g.em.getTime() >= desde.getTime()).reduce((a, g) => a + g.centavos, 0);
  }
  private readonly feitas = new Map<string, Set<string>>();
  async gravarPlano(m: Missao, plano: PlanoDaMissao) {
    this.feitas.set(`${m.id}:${plano.versao}`, new Set());
  }
  async tarefasFeitas(missionId: string, versao: number) {
    return [...(this.feitas.get(`${missionId}:${versao}`) ?? [])];
  }
  async marcarTarefaFeita(m: Missao, versao: number, chave: string) {
    const f = this.feitas.get(`${m.id}:${versao}`) ?? new Set<string>();
    if (f.has(chave)) return false;
    f.add(chave);
    this.feitas.set(`${m.id}:${versao}`, f);
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
  async criar(userId: string, agente: string, objetivo: string, opts: { tetoCustoCentavos?: number; maxTentativas?: number; criterios?: Criterio[]; mandato?: { ferramentas?: string[] | null; prazoFinalEm?: Date | string | null }; planejar?: boolean } = {}): Promise<Missao> {
    const texto = typeof objetivo === "string" ? objetivo.replace(/\s+/g, " ").trim() : "";
    if (!texto || texto.length > MAX_OBJETIVO) throw new ObedientError("INVALID_PAYLOAD", `o objetivo precisa ter de 1 a ${MAX_OBJETIVO} caracteres`);
    if (agente === userId) throw new ObedientError("INVALID_PAYLOAD", "o agente não pode ser a própria pessoa");
    const teto = opts.tetoCustoCentavos ?? TETO_CUSTO_PADRAO;
    if (!Number.isInteger(teto) || teto < 1 || teto > TETO_CUSTO_MAXIMO) throw new ObedientError("INVALID_PAYLOAD", `teto de custo entre 1 e ${TETO_CUSTO_MAXIMO} centavos`);
    const max = opts.maxTentativas ?? 3;
    if (!Number.isInteger(max) || max < 1 || max > LIMITES_EQUIPE.maxTentativas) throw new ObedientError("INVALID_PAYLOAD", `de 1 a ${LIMITES_EQUIPE.maxTentativas} tentativas`);
    const problemas = problemasDosCriterios(opts.criterios);
    if (problemas.length) throw new ObedientError("INVALID_PAYLOAD", `critérios inválidos: ${problemas.slice(0, 3).join("; ")}`);
    const agora = this.clock.now();
    const doMandato = problemasDoMandato(opts.mandato, agora);
    if (doMandato.length) throw new ObedientError("INVALID_PAYLOAD", `mandato inválido: ${doMandato.slice(0, 3).join("; ")}`);
    const m: Missao = {
      id: this.newId(),
      userId,
      agente,
      objetivo: texto,
      criterios: structuredClone(opts.criterios ?? []),
      mandato: lerMandato(opts.mandato),
      planejar: opts.planejar === true,
      planoVersao: 0,
      plano: null,
      estado: "created",
      impedimento: null,
      desfecho: null,
      tentativas: 0,
      maxTentativas: max,
      proximaTentativaEm: agora,
      reservadaAte: null,
      cerca: 0,
      reservadaPor: null,
      custoCentavos: 0,
      tetoCustoCentavos: teto,
      propostaId: null,
      rodada: null,
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

  /** Evidências da verificação da missão, em ordem (M3). */
  evidencias(id: string) {
    return this.store.evidencias(id);
  }

  listar(userId: string) {
    return this.store.listByUser(userId);
  }

  /** Missões do usuário cuja próxima tentativa já chegou. */
  async devidas(userId: string): Promise<Missao[]> {
    const agora = this.clock.now().getTime();
    return (await this.store.listByUser(userId)).filter((m) => (DEVIDAS.includes(m.estado) && (m.proximaTentativaEm?.getTime() ?? Infinity) <= agora) || m.estado === "waiting_approval");
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
  async reservar(id: string, dono = DONO_PADRAO): Promise<{ reservada: true; missao: Missao } | { reservada: false; missao: Missao }> {
    const m = await this.store.get(id);
    if (!m) throw new ObedientError("PROPOSAL_NOT_FOUND", "missão inexistente");
    const nao = (x: Missao) => ({ reservada: false as const, missao: x });
    // Só anda o que espera tentativa ou aprovação; parada, planejando ou conferindo não se reserva aqui.
    if (!DEVIDAS.includes(m.estado) && m.estado !== "waiting_approval") return nao(m);

    const parada = await this.motor.stop.blocking(m.userId);
    if (parada) return nao(await this.cancelar(m, `parada de emergência: ${parada.reason}`));

    // Prazo final do mandato (M4): passou, não tenta mais.
    if (m.mandato.prazoFinalEm && this.clock.now().getTime() >= m.mandato.prazoFinalEm.getTime()) return nao(await this.falharPorPrazo(m));
    // Teto do mês (D21): nenhuma tentativa começa depois de atingido.
    if ((await this.gastoDoMes(m.userId)) >= TETO_MENSAL_CENTAVOS) return nao(await this.bloquear(m, this.textoTetoMensal()));

    // Plano esperando a pessoa (M5): sem aprovação, espera; aprovado, começa uma tentativa nova de
    // execução, já pelo plano.
    if (m.estado === "waiting_approval" && !m.propostaId && m.plano) {
      if (!m.plano.aprovadoEm) return nao(m);
      if (m.custoCentavos >= m.tetoCustoCentavos) return nao(await this.bloquear(m, this.textoTeto(m)));
      m.tentativas += 1;
      this.mudar(m, "running");
      this.reservarAte(m, dono);
      m.atualizadaEm = this.clock.now();
      if (!(await this.salvar(m))) return nao((await this.store.get(id))!);
      return { reservada: true, missao: m };
    }
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
      // Aprovado (ou já executado): a MESMA tentativa continua de onde parou (não conta outra). Com
      // prazo, como qualquer reserva: antes, a missão ficava devida na hora e um segundo processo
      // podia rodar a mesma continuação por cima.
      this.mudar(m, "running");
      m.propostaId = null;
      if (m.custoCentavos >= m.tetoCustoCentavos) return nao(await this.bloquear(m, this.textoTeto(m)));
      this.reservarAte(m, dono);
      m.atualizadaEm = this.clock.now();
      if (!(await this.salvar(m))) return nao((await this.store.get(id))!);
      return { reservada: true, missao: m };
    }
    if ((m.proximaTentativaEm?.getTime() ?? Infinity) > this.clock.now().getTime()) return nao(m);

    if (m.custoCentavos >= m.tetoCustoCentavos) return nao(await this.bloquear(m, this.textoTeto(m)));

    // Reserva vencida sem conclusão: o processo que tentava caiu (ou passou do prazo).
    if (m.reservadaAte) {
      await this.registrar(m, "mission.attempt_interrupted", "failed", [`tentativa ${m.tentativas} de ${m.maxTentativas} não terminou dentro do prazo da reserva`]);
      if (m.tentativas >= m.maxTentativas)
        return nao(
          await this.bloquear(
            m,
            `A tentativa ${m.tentativas} não terminou (o servidor pode ter reiniciado no meio) e não sobrou tentativa. Uma ação aprovada que já estava em andamento não é repetida: confira se ela aconteceu antes de mandar tentar de novo ou cancelar.`,
          ),
        );
    }

    m.tentativas += 1;
    // Planejar antes (M5): sem plano, a tentativa é do planejador.
    this.mudar(m, m.planejar && !m.plano ? "planning" : "running");
    this.reservarAte(m, dono);
    m.atualizadaEm = this.clock.now();
    if (!(await this.salvar(m))) return nao((await this.store.get(id))!);
    return { reservada: true, missao: m };
  }

  private reservarAte(m: Missao, dono: string) {
    m.reservadaAte = new Date(this.clock.now().getTime() + PRAZO_RESERVA_MS);
    m.proximaTentativaEm = m.reservadaAte;
    // Cerca (M5): cada reserva tem a sua; a anterior deixa de valer para gravar passos.
    m.cerca += 1;
    m.reservadaPor = dono.slice(0, 200) || DONO_PADRAO;
  }

  /**
   * Passo 2: aplica o resultado da tentativa reservada. Se a missão mudou no meio (a pessoa cancelou,
   * apertou parar, ou a reserva venceu e outro processo tentou de novo), o resultado é descartado e a
   * missão fica como está.
   */
  async concluir(reservada: Missao, resultado: ResultadoTentativa): Promise<Missao> {
    let r = resultado;
    const m = structuredClone(reservada);
    m.reservadaAte = null;
    m.reservadaPor = null;
    // Só a falha temporária marca a próxima tentativa (abaixo); o resto não tem próxima.
    m.proximaTentativaEm = null;
    const custo = Number.isFinite(r.custoCentavos) && r.custoCentavos > 0 ? Math.ceil(r.custoCentavos) : 0;
    m.custoCentavos += custo;
    m.atualizadaEm = this.clock.now();
    const sobre = [`tentativa ${m.tentativas} de ${m.maxTentativas}`, `custo ${reais(custo)} (total ${reais(m.custoCentavos)})`];
    // O gasto aconteceu, mesmo que o resultado seja descartado depois: conta para o teto do mês.
    if (custo > 0) await this.store.registrarGasto(m, custo, this.clock.now());

    // O planejador só entrega plano; a execução nunca entrega plano (M5). O resto vira falha passageira.
    if (m.estado === "planning" && (r.tipo === "feito" || r.tipo === "nao_sei" || r.tipo === "aguardando_aprovacao"))
      r = { tipo: "falha_temporaria", erro: "o planejador não entregou um plano", custoCentavos: r.custoCentavos };
    if (m.estado !== "planning" && r.tipo === "plano") r = { tipo: "falha_temporaria", erro: "plano fora da hora de planejar", custoCentavos: r.custoCentavos };

    switch (r.tipo) {
      case "plano": {
        const lido = lerTarefas(r.tarefas);
        if ("problemas" in lido) {
          this.mudar(m, "blocked");
          m.impedimento = curto(`O planejador entregou um plano que não confere (${lido.problemas.slice(0, 2).join("; ")}). Mande tentar de novo ou cancele.`, 500);
          m.rodada = null;
          if (!(await this.salvar(m))) return this.descartada(reservada, r.tipo);
          await this.registrar(m, "mission.blocked", "info", [...sobre, "plano inválido"]);
          return m;
        }
        m.planoVersao += 1;
        m.plano = { versao: m.planoVersao, hash: hashDoPlano(lido.tarefas), aprovadoEm: null, tarefas: lido.tarefas };
        this.mudar(m, "waiting_approval");
        m.propostaId = null;
        m.rodada = null;
        // As tarefas entram antes da missão: se a troca pela versão falhar, ficam órfãs de um plano
        // que ninguém vê (a versão do plano não foi gravada na missão).
        await this.store.gravarPlano(m, m.plano);
        if (!(await this.salvar(m))) return this.descartada(reservada, r.tipo);
        await this.registrar(m, "mission.plan_proposed", "approval_required", [...sobre, `${m.plano.tarefas.length} tarefa(s)`, `plano ${m.plano.hash.slice(0, 12)}`]);
        return m;
      }
      case "nao_consegui": {
        this.mudar(m, "failed");
        m.rodada = null;
        m.desfecho = { tipo: r.tipo, explicacao: curto(String(r.explicacao ?? "").trim() || "(sem explicação)", MAX_EXPLICACAO) };
        if (!(await this.salvar(m))) return this.descartada(reservada, r.tipo);
        await this.registrar(m, "mission.nao_consegui", "failed", sobre);
        return m;
      }
      // Terminar passa por verifying (M3): as evidências ficam gravadas antes de a missão terminar.
      case "feito":
      case "nao_sei": {
        const evidencias: Evidencia[] =
          r.tipo === "nao_sei"
            ? [{ criterio: null, tipo: "nao_sei", ok: true, referencia: null, detalhe: "O agente respondeu que não sabe: nenhum critério se aplica." }]
            : (r.evidencias ?? verificar(m.criterios, [], undefined).evidencias);
        // Plano (M5): "feito" só com todas as tarefas feitas, conferido aqui pelo que está gravado.
        if (r.tipo === "feito" && m.plano) {
          const feitas = new Set(await this.store.tarefasFeitas(m.id, m.plano.versao));
          const faltam = m.plano.tarefas.filter((t) => !feitas.has(t.chave));
          const i = evidencias.findIndex((e) => e.tipo === "plano_completo");
          if (i >= 0) evidencias.splice(i, 1);
          evidencias.push({
            criterio: null,
            tipo: "plano_completo",
            ok: faltam.length === 0,
            referencia: `${m.plano.tarefas.length - faltam.length} de ${m.plano.tarefas.length} tarefa(s)`,
            detalhe: faltam.length ? `Faltam ${faltam.length} tarefa(s) do plano: ${curto(faltam.map((t) => t.titulo).join("; "), 300)}.` : "Todas as tarefas do plano foram feitas.",
          });
        }
        this.mudar(m, "verifying");
        m.rodada = null;
        if (!(await this.salvar(m))) return this.descartada(reservada, r.tipo);
        await this.store.gravarEvidencias(m, evidencias);
        await this.registrar(m, "mission.verifying", "info", [...sobre, `${evidencias.filter((e) => e.ok).length} de ${evidencias.length} evidência(s) conferida(s)`]);
        if (!evidencias.every((e) => e.ok)) {
          this.mudar(m, "blocked");
          m.impedimento = textoNaoVerificada(evidencias);
          if (!(await this.salvar(m))) return this.descartada(reservada, r.tipo);
          await this.registrar(m, "mission.blocked", "info", [curto(m.impedimento, 200)]);
          return m;
        }
        this.mudar(m, "completed");
        m.desfecho = { tipo: r.tipo, explicacao: curto(String(r.explicacao ?? "").trim() || "(sem explicação)", MAX_EXPLICACAO) };
        if (!(await this.salvar(m))) return this.descartada(reservada, r.tipo);
        await this.registrar(m, `mission.${r.tipo}`, r.tipo === "feito" ? "executed" : "info", sobre);
        return m;
      }
      case "aguardando_aprovacao":
        this.mudar(m, "waiting_approval");
        m.propostaId = r.propostaId;
        m.rodada = r.rodada ?? null;
        if (!(await this.salvar(m))) return this.descartada(reservada, r.tipo);
        await this.registrar(m, "mission.waiting_approval", "approval_required", sobre);
        return m;
      case "impedida": {
        this.mudar(m, "blocked");
        m.impedimento = curto(String(r.motivo ?? "").trim() || "A missão precisa de você para continuar.", 500);
        m.rodada = null;
        if (!(await this.salvar(m))) return this.descartada(reservada, r.tipo);
        await this.registrar(m, "mission.blocked", "info", [...sobre, curto(m.impedimento, 200)]);
        return m;
      }
      case "falha_temporaria": {
        m.rodada = r.rodada ?? null;
        if (m.tentativas >= m.maxTentativas) {
          this.mudar(m, "blocked");
          m.impedimento = `Tentou ${m.tentativas} vez(es) e não conseguiu. Último erro: ${curto(String(r.erro), 200)}. Diga se quer tentar de novo ou cancelar.`;
        } else if (m.custoCentavos >= m.tetoCustoCentavos) {
          this.mudar(m, "blocked");
          m.impedimento = this.textoTeto(m);
        } else if ((await this.gastoDoMes(m.userId)) >= TETO_MENSAL_CENTAVOS) {
          // O teto do mês (D21) acabou nesta tentativa: aumentar o teto da missão não ajudaria.
          this.mudar(m, "blocked");
          m.impedimento = this.textoTetoMensal();
        } else {
          this.mudar(m, "retrying");
          m.proximaTentativaEm = new Date(this.clock.now().getTime() + intervaloDepois(m.tentativas));
        }
        // Impedida, a missão recomeça do zero se a pessoa mandar tentar de novo.
        if (m.estado === "blocked") m.rodada = null;
        if (!(await this.salvar(m))) return this.descartada(reservada, r.tipo);
        await this.registrar(m, "mission.attempt_failed", "failed", sobre);
        if (m.estado === "blocked") await this.registrar(m, "mission.blocked", "info", [curto(m.impedimento!, 200)]);
        return m;
      }
    }
  }

  /** A única porta de troca de estado: fora da tabela TRANSICOES, nada muda. */
  private mudar(m: Missao, para: EstadoMissao) {
    if (m.estado === para) return;
    if (!podeMudar(m.estado, para)) throw new ObedientError("INVALID_TRANSITION", `transição de estado não permitida: ${m.estado} → ${para}`);
    m.estado = para;
  }

  /** Quanto a pessoa gastou neste mês (Brasil, UTC−3), somando todas as missões. */
  gastoDoMes(userId: string) {
    return this.store.gastoDesde(userId, inicioDoMes(this.clock.now()));
  }

  private textoTetoMensal() {
    return `Chegou ao teto do mês (${reais(TETO_MENSAL_CENTAVOS)}). As missões voltam a andar no mês que vem, ou cancele.`;
  }

  private async falharPorPrazo(m: Missao): Promise<Missao> {
    this.mudar(m, "failed");
    m.desfecho = { tipo: "nao_consegui", explicacao: `Passou do prazo final que você deu (${m.mandato.prazoFinalEm!.toISOString()}) sem terminar.` };
    m.proximaTentativaEm = null;
    m.reservadaAte = null;
    m.reservadaPor = null;
    m.rodada = null;
    m.atualizadaEm = this.clock.now();
    if (!(await this.salvar(m))) return (await this.store.get(m.id))!;
    await this.registrar(m, "mission.nao_consegui", "failed", ["passou do prazo final do mandato"]);
    return m;
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
    if (m.mandato.prazoFinalEm && this.clock.now().getTime() >= m.mandato.prazoFinalEm.getTime()) throw new ObedientError("INVALID_PAYLOAD", "o prazo final desta missão já passou: crie outra");
    if (opts.novoTetoCentavos !== undefined) {
      const t = opts.novoTetoCentavos;
      if (!Number.isInteger(t) || t <= m.tetoCustoCentavos || t > TETO_CUSTO_MAXIMO) throw new ObedientError("INVALID_PAYLOAD", `o novo teto precisa ser maior que o atual e até ${TETO_CUSTO_MAXIMO} centavos`);
      m.tetoCustoCentavos = t;
    }
    if (m.custoCentavos >= m.tetoCustoCentavos) throw new ObedientError("INVALID_PAYLOAD", "o teto de custo já foi atingido: aumente o teto para tentar de novo");
    this.mudar(m, "retrying");
    m.impedimento = null;
    m.tentativas = 0;
    m.propostaId = null;
    m.rodada = null;
    m.proximaTentativaEm = this.clock.now();
    m.reservadaAte = null;
    m.reservadaPor = null;
    m.atualizadaEm = this.clock.now();
    if (!(await this.salvar(m))) throw new ObedientError("PROPOSAL_NOT_PENDING", "a missão mudou enquanto isso");
    await this.registrar(m, "mission.retry", "info", [`teto ${reais(m.tetoCustoCentavos)}`]);
    return m;
  }

  /** A pessoa aprova o plano que viu (M5): pelo hash, para aprovar exatamente aquele plano. */
  async aprovarPlano(userId: string, id: string, hash: string): Promise<Missao> {
    const m = await this.planoEsperando(userId, id);
    if (hash !== m.plano!.hash) throw new ObedientError("PAYLOAD_MISMATCH", "o plano mudou desde que você o viu");
    m.plano!.aprovadoEm = this.clock.now();
    m.proximaTentativaEm = this.clock.now();
    m.atualizadaEm = this.clock.now();
    if (!(await this.salvar(m))) throw new ObedientError("PROPOSAL_NOT_PENDING", "a missão mudou enquanto isso");
    await this.registrar(m, "mission.plan_approved", "info", [`plano ${m.plano!.hash.slice(0, 12)}`, `${m.plano!.tarefas.length} tarefa(s)`]);
    return m;
  }

  /** A pessoa recusa o plano: a missão para; "tentar de novo" planeja outra vez. */
  async recusarPlano(userId: string, id: string): Promise<Missao> {
    const m = await this.planoEsperando(userId, id);
    m.plano = null;
    const fim = await this.bloquear(m, "Você recusou o plano. Mande tentar de novo para o agente planejar outra vez, ou cancele.");
    await this.registrar(fim, "mission.plan_rejected", "info", []);
    return fim;
  }

  private async planoEsperando(userId: string, id: string): Promise<Missao> {
    const m = await this.store.get(id);
    if (!m || m.userId !== userId) throw new ObedientError("PROPOSAL_NOT_FOUND", "missão inexistente");
    if (m.estado !== "waiting_approval" || !m.plano || m.plano.aprovadoEm || m.propostaId) throw new ObedientError("PROPOSAL_NOT_PENDING", "não há plano esperando você nesta missão");
    return m;
  }

  /**
   * O agente marca uma tarefa feita (M5). Só da missão em execução pelo plano aprovado, e só com
   * todas as dependências feitas (o banco confere de novo). Devolve as feitas depois da marcação.
   */
  async marcarTarefaFeita(reservada: Missao, chave: string): Promise<{ ok: true; feitas: string[] } | { ok: false; motivo: string }> {
    const plano = reservada.plano;
    if (!plano?.aprovadoEm || reservada.estado !== "running") return { ok: false, motivo: "esta missão não está executando um plano aprovado" };
    const t = plano.tarefas.find((x) => x.chave === chave);
    if (!t) return { ok: false, motivo: `não há tarefa "${curto(chave, 40)}" no plano` };
    const feitas = new Set(await this.store.tarefasFeitas(reservada.id, plano.versao));
    if (feitas.has(chave)) return { ok: true, feitas: [...feitas] };
    const faltam = t.dependeDe.filter((d) => !feitas.has(d));
    if (faltam.length) return { ok: false, motivo: `antes desta, termine: ${faltam.join(", ")}` };
    await this.store.marcarTarefaFeita(reservada, plano.versao, chave, this.clock.now());
    feitas.add(chave);
    return { ok: true, feitas: [...feitas] };
  }

  /** Chaves das tarefas feitas do plano em vigor (vazio sem plano). */
  async tarefasFeitas(m: Missao): Promise<string[]> {
    return m.plano ? this.store.tarefasFeitas(m.id, m.plano.versao) : [];
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
    this.mudar(m, "cancelled");
    m.proximaTentativaEm = null;
    m.reservadaAte = null;
    m.reservadaPor = null;
    m.rodada = null;
    m.atualizadaEm = this.clock.now();
    if (!(await this.salvar(m))) return (await this.store.get(m.id))!;
    await this.registrar(m, "mission.cancelled", "info", [motivo]);
    return m;
  }

  private async bloquear(m: Missao, impedimento: string): Promise<Missao> {
    this.mudar(m, "blocked");
    m.impedimento = impedimento;
    m.proximaTentativaEm = null;
    m.reservadaAte = null;
    m.reservadaPor = null;
    m.rodada = null;
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
