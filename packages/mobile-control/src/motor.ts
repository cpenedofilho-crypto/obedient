// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// O Mobile Control Engine (decisão D17): as ferramentas que o agente usa para um celular, cada uma
// governada pelo Ethics Engine, com um adaptador de aparelho por trás.
//
//   • cinco ferramentas: listar aparelhos, abrir sessão, observar, agir e encerrar. Encerrar nunca
//     passa por autorização: tirar poder sempre funciona, mesmo sem grant;
//   • cada ação é classificada aqui (politica.ts) e o Ethics Engine decide com esse risco: roda
//     sozinha, vira pedido de aprovação ou é negada. Negada pelo Ethics Engine (grant revogado,
//     parada acionada), a sessão é encerrada na hora: na dúvida, para;
//   • só a observação mais recente vale para agir, e o toque é pedido pelo id do elemento. O hash da
//     tela entra no payload que a pessoa aprova; na execução o motor observa de novo e, se a tela
//     mudou, NÃO age (tela_mudou) e devolve a tela nova;
//   • sessão tem prazo (até 30 min) e limite de passos; uma sessão aberta por aparelho;
//   • a parada de emergência encerra as sessões da pessoa no mesmo instante (ligarParada);
//   • o registro guarda hash dos argumentos, risco e desfecho, nunca o texto digitado nem a tela.

import { type Clock, type IdFactory, type RiskLevel, type ToolCategory, payloadHash, systemClock, uuid } from "@obedient/core";
import { type AbrirMotor, type ItemCatalogo, type ItemGovernado, type Quem, type ResultadoChamada, chamarComEthicsEmEtapas } from "@obedient/agent-orchestrator";
import { centro, montarObservacao, type ObservacaoInterna, paraModelo } from "./percepcao.ts";
import { classificar } from "./politica.ts";
import { type AcaoRegistrada, type AdaptadorMovel, type Comando, type Direcao, type Dispositivo, OPERACOES, type Operacao, type Sessao } from "./tipos.ts";

export const SISTEMA = "mobile";
export const MAX_MINUTOS = 30;
export const PASSOS_PADRAO = 40;
export const MAX_TEXTO_DIGITADO = 500;

export const FERRAMENTAS = {
  listar: "mobile_list_devices",
  iniciar: "mobile_start_session",
  observar: "mobile_observe",
  agir: "mobile_act",
  encerrar: "mobile_stop_session",
} as const;

const uuidOk = (v: unknown): v is string => typeof v === "string" && /^[0-9A-Za-z-]{8,64}$/.test(v);

// ---- dispositivos ------------------------------------------------------------------------------

export class RegistroDeDispositivos {
  private readonly todos = new Map<string, Dispositivo>();
  registrar(d: Dispositivo): Dispositivo {
    if (d.credencialRef !== null && !/^[A-Z][A-Z0-9_]*$/.test(d.credencialRef)) throw new Error("credencialRef é o NOME de uma variável de ambiente, nunca o valor");
    this.todos.set(d.id, structuredClone(d));
    return d;
  }
  /** Só o aparelho do próprio tenant: de outro, é como se não existisse. */
  get(tenantId: string, id: string): Dispositivo | undefined {
    const d = this.todos.get(id);
    return d && d.tenantId === tenantId ? structuredClone(d) : undefined;
  }
  listar(tenantId: string): Dispositivo[] {
    return [...this.todos.values()].filter((d) => d.tenantId === tenantId).map((d) => structuredClone(d));
  }
}

// ---- as ferramentas como o modelo vê -----------------------------------------------------------

const objeto = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required, additionalProperties: false });

const DEFINICOES: Record<string, { description: string; input_schema: Record<string, unknown>; risco: RiskLevel; categoria: ToolCategory }> = {
  [FERRAMENTAS.listar]: {
    description: "Lista os celulares que você pode usar, com os apps permitidos em cada um.",
    input_schema: objeto({}, []),
    risco: "LOW",
    categoria: "READ",
  },
  [FERRAMENTAS.iniciar]: {
    description: "Abre uma sessão num celular por até 30 minutos. Encerre com mobile_stop_session quando terminar.",
    input_schema: objeto({ device_id: { type: "string" }, minutos: { type: "integer", minimum: 1, maximum: MAX_MINUTOS } }, ["device_id"]),
    risco: "MEDIUM",
    categoria: "WRITE",
  },
  [FERRAMENTAS.observar]: {
    description: "Lê a tela atual: o app em primeiro plano e os elementos, cada um com um id. Para agir, use sempre a observação mais recente.",
    input_schema: objeto({ session_id: { type: "string" } }, ["session_id"]),
    risco: "LOW",
    categoria: "READ",
  },
  [FERRAMENTAS.agir]: {
    description:
      "Faz uma ação na tela observada: tocar um elemento (pelo id), digitar num campo (pelo id), deslizar, voltar, ir ao início ou abrir um app da lista do aparelho. Ações sensíveis esperam a aprovação da pessoa. Se a tela mudar antes da execução, nada acontece e a tela nova volta para você.",
    input_schema: objeto(
      {
        session_id: { type: "string" },
        observation_id: { type: "string" },
        operacao: { type: "string", enum: [...OPERACOES] },
        alvo: { type: "string", maxLength: 16 },
        texto: { type: "string", maxLength: MAX_TEXTO_DIGITADO },
        direcao: { type: "string", enum: ["up", "down", "left", "right"] },
        app: { type: "string", maxLength: 200 },
        intencao: { type: "string", minLength: 3, maxLength: 200 },
      },
      ["session_id", "observation_id", "operacao", "intencao"],
    ),
    risco: "MEDIUM",
    categoria: "WRITE",
  },
  [FERRAMENTAS.encerrar]: {
    description: "Encerra a sessão no celular. Sempre funciona.",
    input_schema: objeto({ session_id: { type: "string" } }, ["session_id"]),
    risco: "LOW",
    categoria: "WRITE",
  },
};

const PERMITIDOS: Record<string, readonly string[]> = Object.fromEntries(
  Object.entries(DEFINICOES).map(([nome, d]) => [nome, Object.keys((d.input_schema as { properties: object }).properties)]),
);

/** Argumentos fora do esquema são recusados antes de qualquer coisa. Devolve o problema, ou null. */
export function validarArgs(nome: string, args: Record<string, unknown>): string | null {
  const permitidos = PERMITIDOS[nome];
  if (!permitidos) return `ferramenta desconhecida: ${nome}`;
  const extra = Object.keys(args).find((k) => !permitidos.includes(k));
  if (extra) return `argumento não previsto: ${extra}`;
  if (nome === FERRAMENTAS.iniciar) {
    if (!uuidOk(args.device_id)) return "device_id inválido";
    if (args.minutos !== undefined && (!Number.isInteger(args.minutos) || (args.minutos as number) < 1 || (args.minutos as number) > MAX_MINUTOS)) return `minutos entre 1 e ${MAX_MINUTOS}`;
  }
  if (nome === FERRAMENTAS.observar || nome === FERRAMENTAS.encerrar || nome === FERRAMENTAS.agir) {
    if (!uuidOk(args.session_id)) return "session_id inválido";
  }
  if (nome === FERRAMENTAS.agir) {
    if (!uuidOk(args.observation_id)) return "observation_id inválido";
    const op = args.operacao;
    if (!(OPERACOES as readonly unknown[]).includes(op)) return "operação fora do vocabulário";
    if (typeof args.intencao !== "string" || args.intencao.trim().length < 3 || args.intencao.length > 200) return "intencao de 3 a 200 caracteres";
    if ((op === "input.tap_element" || op === "input.text") && (typeof args.alvo !== "string" || !/^e\d{1,4}$/.test(args.alvo))) return "alvo precisa ser o id de um elemento da observação";
    if (op === "input.text" && (typeof args.texto !== "string" || !args.texto.length || args.texto.length > MAX_TEXTO_DIGITADO)) return `texto de 1 a ${MAX_TEXTO_DIGITADO} caracteres`;
    if (op === "input.swipe" && !["up", "down", "left", "right"].includes(args.direcao as string)) return "direcao: up, down, left ou right";
    if (op === "apps.launch" && (typeof args.app !== "string" || !/^[A-Za-z0-9_.]{3,200}$/.test(args.app))) return "app inválido";
  }
  return null;
}

// ---- o motor -----------------------------------------------------------------------------------

class ErroSessao extends Error {}

export interface OpcoesMotor {
  dispositivos: RegistroDeDispositivos;
  adaptador: AdaptadorMovel;
  clock?: Clock;
  novoId?: IdFactory;
  maxPassos?: number;
}

const negado = (motivo: string): ResultadoChamada => ({ status: "denied", motivo, approvalId: null, resultado: null });

export class MotorMovel {
  private readonly sessoes = new Map<string, Sessao>();
  private readonly observacoes = new Map<string, ObservacaoInterna>();
  /** Registro das ações: hash, risco e desfecho; nunca texto. */
  readonly registro: AcaoRegistrada[] = [];
  private readonly clock: Clock;
  private readonly novoId: IdFactory;

  constructor(private readonly o: OpcoesMotor) {
    this.clock = o.clock ?? systemClock;
    this.novoId = o.novoId ?? uuid;
  }

  /** As cinco ferramentas, para o catálogo do laço do agente. */
  itens(): ItemGovernado[] {
    return Object.entries(DEFINICOES).map(([name, d]) => ({
      definicao: { name, description: d.description, input_schema: d.input_schema },
      chave: `${SISTEMA}/${name}`,
      sistema: SISTEMA,
      ferramenta: `${SISTEMA}.${name.replace(/^mobile_/, "")}`,
      risco: d.risco,
      categoria: d.categoria,
    }));
  }

  sessao(id: string): Sessao | undefined {
    const s = this.sessoes.get(id);
    return s ? structuredClone(s) : undefined;
  }

  /** Art. 9º: a parada de emergência encerra as sessões da pessoa (ou de todos) na hora. */
  ligarParada(engine: { stop: { onEngage(l: (scope: { kind: "global" } | { kind: "user"; userId: string }) => void | Promise<void>): void } }) {
    engine.stop.onEngage(async (scope) => {
      for (const s of this.sessoes.values()) if (s.estado === "active" && (scope.kind === "global" || s.tenantId === scope.userId)) await this.fechar(s, "killed", "parada de emergência");
    });
  }

  async encerrarDoTenant(tenantId: string, motivo: string): Promise<number> {
    let n = 0;
    for (const s of this.sessoes.values()) if (s.tenantId === tenantId && s.estado === "active") (await this.fechar(s, "killed", motivo), n++);
    return n;
  }

  /** A porta chamarFerramenta do laço do agente, para uma pessoa. */
  porta(abrir: AbrirMotor, quem: Quem) {
    return async (item: ItemCatalogo, args: Record<string, unknown>, approvalId?: string): Promise<ResultadoChamada> => {
      const nome = item.definicao.name;
      const problema = validarArgs(nome, args);
      if (problema) return { status: "tool_error", motivo: problema, approvalId: null, resultado: null };
      const base = this.itens().find((i) => i.definicao.name === nome)!;
      const tenant = quem.userId;

      // Encerrar tira poder: nunca depende de autorização.
      if (nome === FERRAMENTAS.encerrar) {
        const s = this.sessoes.get(args.session_id as string);
        if (!s || s.tenantId !== tenant) return negado("sessao_inexistente");
        if (s.estado === "active") await this.fechar(s, "stopped", "encerrada pelo agente");
        return { status: "succeeded", motivo: null, approvalId: null, resultado: { conteudo_externo: { encerrada: true } } };
      }

      const governar = async (risco: RiskLevel, categoria: ToolCategory, payload: Record<string, unknown>, executor: () => Promise<unknown>, sessao?: Sessao) => {
        const dinamico: ItemGovernado = { ...base, risco, categoria };
        const r = await chamarComEthicsEmEtapas(abrir, { ...quem, ...(sessao?.missionId ? { correlationId: sessao.missionId } : {}) }, async () => executor())(dinamico, payload, approvalId);
        // Negado pelo Ethics Engine (grant revogado, parada, aprovação inválida): a sessão para na hora.
        if (r.status === "denied" && sessao) await this.fechar(this.sessoes.get(sessao.id)!, "killed", `autorização negada: ${r.motivo ?? "sem motivo"}`);
        return r;
      };

      if (nome === FERRAMENTAS.listar) {
        return governar(base.risco, base.categoria, args, async () => ({
          aparelhos: this.o.dispositivos.listar(tenant).filter((d) => d.ativo).map((d) => ({ id: d.id, rotulo: d.rotulo, plataforma: d.plataforma, ambiente: d.ambiente, apps_permitidos: d.appsPermitidos })),
        }));
      }

      if (nome === FERRAMENTAS.iniciar) {
        const d = this.o.dispositivos.get(tenant, args.device_id as string);
        if (!d || !d.ativo) return negado("aparelho inexistente ou desligado");
        return governar(base.risco, base.categoria, args, () => this.abrirSessao(d, (args.minutos as number | undefined) ?? 15, quem));
      }

      let s: Sessao;
      try {
        s = this.ativa(tenant, args.session_id as string);
      } catch (e) {
        return negado((e as Error).message);
      }

      if (nome === FERRAMENTAS.observar) {
        return governar(base.risco, base.categoria, args, async () => {
          const at = this.ativa(tenant, s.id);
          at.passos++;
          const obs = await this.capturar(at);
          this.registrar(at, nome, "screen.observe", base.risco, base.categoria, args, "executada", null, null, obs.screenHash);
          return paraModelo(obs);
        }, s);
      }

      // mobile_act
      const op = args.operacao as Operacao;
      if (args.observation_id !== s.ultimaObservacao) return negado("observacao_desatualizada: observe a tela de novo antes de agir");
      const obs = this.observacoes.get(args.observation_id as string)!;
      const alvo = typeof args.alvo === "string" ? obs.internos.find((e) => e.id === args.alvo) : undefined;
      if ((op === "input.tap_element" || op === "input.text") && !alvo) return negado("o alvo não existe nesta observação");
      if (op === "input.text" && !alvo!.campo) return negado("o alvo não é um campo de texto");
      const c = classificar(this.o.dispositivos.get(tenant, s.dispositivoId)!, { operacao: op, appAtual: obs.app, ...(alvo ? { textoAlvo: alvo.texto } : {}), ...(typeof args.app === "string" ? { app: args.app } : {}) });
      if (c.negado) {
        this.registrar(s, nome, op, c.risco, c.categoria, args, "negada", c.negado, obs.screenHash, null);
        return negado(c.negado);
      }
      // O que a pessoa aprova inclui a tela em que a ação foi pedida.
      const payload = { ...args, screen_hash: obs.screenHash };
      const r = await governar(c.risco, c.categoria, payload, () => this.agir(tenant, s.id, obs, op, args), s);
      if (r.status === "approval_required") this.registrar(s, nome, op, c.risco, c.categoria, args, "aguardando_aprovacao", null, obs.screenHash, null);
      return r;
    };
  }

  // ---- por dentro --------------------------------------------------------------------------------

  private async abrirSessao(d: Dispositivo, minutos: number, quem: Quem) {
    for (const s of this.sessoes.values()) if (s.dispositivoId === d.id) this.expirarSePreciso(s);
    if ([...this.sessoes.values()].some((s) => s.dispositivoId === d.id && s.estado === "active")) throw new ErroSessao("o aparelho já tem uma sessão aberta");
    await this.o.adaptador.iniciar(d.id);
    const agora = this.clock.now();
    const s: Sessao = {
      id: this.novoId(),
      tenantId: d.tenantId,
      dispositivoId: d.id,
      missionId: quem.correlationId ?? null,
      estado: "active",
      criadaEm: agora,
      expiraEm: new Date(agora.getTime() + Math.min(minutos, MAX_MINUTOS) * 60_000),
      passos: 0,
      maxPassos: this.o.maxPassos ?? PASSOS_PADRAO,
      ultimaObservacao: null,
      motivoFim: null,
    };
    this.sessoes.set(s.id, s);
    this.registrar(s, FERRAMENTAS.iniciar, "session.start", "MEDIUM", "WRITE", { device_id: d.id }, "executada", null, null, null);
    return { session_id: s.id, expira_em: s.expiraEm.toISOString(), max_passos: s.maxPassos };
  }

  private async agir(tenant: string, sessionId: string, pedida: ObservacaoInterna, op: Operacao, args: Record<string, unknown>) {
    const s = this.ativa(tenant, sessionId);
    s.passos++;
    // TOCTOU: a tela tem de ser a mesma em que a ação foi pedida (e aprovada).
    const agora = await this.capturar(s);
    if (agora.screenHash !== pedida.screenHash) {
      this.registrar(s, FERRAMENTAS.agir, op, "-", "-", args, "tela_mudou", "a tela mudou desde a observação", pedida.screenHash, agora.screenHash);
      return { status: "tela_mudou", mensagem: "A tela mudou e nada foi feito. Veja a tela nova e peça de novo, se ainda fizer sentido.", tela: paraModelo(agora) };
    }
    const alvo = typeof args.alvo === "string" ? agora.internos.find((e) => e.id === args.alvo) : undefined;
    const d = s.dispositivoId;
    const comandos: Comando[] = [];
    if (op === "input.tap_element") comandos.push({ tipo: "tocar", ...centro(alvo!.caixa) });
    else if (op === "input.text") comandos.push({ tipo: "tocar", ...centro(alvo!.caixa) }, { tipo: "digitar", texto: args.texto as string });
    else if (op === "input.swipe") comandos.push({ tipo: "deslizar", direcao: args.direcao as Direcao });
    else if (op === "nav.home") comandos.push({ tipo: "inicio" });
    else if (op === "nav.back") comandos.push({ tipo: "voltar" });
    else comandos.push({ tipo: "abrir_app", app: args.app as string });
    try {
      for (const c of comandos) await this.o.adaptador.executar(d, c);
    } catch (e) {
      this.registrar(s, FERRAMENTAS.agir, op, "-", "-", args, "falhou", "o aparelho recusou o comando", agora.screenHash, null);
      throw e;
    }
    const depois = await this.capturar(s);
    this.registrar(s, FERRAMENTAS.agir, op, "-", "-", args, "executada", null, agora.screenHash, depois.screenHash);
    return { status: "executada", tela: paraModelo(depois) };
  }

  private async capturar(s: Sessao): Promise<ObservacaoInterna> {
    const bruta = await this.o.adaptador.capturar(s.dispositivoId);
    const obs = montarObservacao(bruta, { observationId: this.novoId(), sessionId: s.id }, this.clock.now());
    // Só a mais recente vale; as anteriores somem (não guardamos tela velha).
    if (s.ultimaObservacao) this.observacoes.delete(s.ultimaObservacao);
    this.observacoes.set(obs.observationId, obs);
    s.ultimaObservacao = obs.observationId;
    return obs;
  }

  private expirarSePreciso(s: Sessao) {
    if (s.estado === "active" && this.clock.now().getTime() >= s.expiraEm.getTime()) {
      s.estado = "expired";
      s.motivoFim = "prazo da sessão";
      if (s.ultimaObservacao) this.observacoes.delete(s.ultimaObservacao);
      s.ultimaObservacao = null;
      void this.o.adaptador.encerrar(s.dispositivoId).catch(() => {});
    }
  }

  /** A sessão, se for do tenant e ainda puder ser usada. Senão, lança com o motivo. */
  private ativa(tenantId: string, id: string): Sessao {
    const s = this.sessoes.get(id);
    if (!s || s.tenantId !== tenantId) throw new ErroSessao("sessao_inexistente");
    this.expirarSePreciso(s);
    if (s.estado !== "active") throw new ErroSessao(`sessao_${s.estado}: ${s.motivoFim ?? ""}`.trim());
    if (s.passos >= s.maxPassos) {
      void this.fechar(s, "stopped", "limite de passos da sessão");
      throw new ErroSessao("sessao_stopped: limite de passos da sessão");
    }
    return s;
  }

  private async fechar(s: Sessao, estado: "stopped" | "killed", motivo: string) {
    if (s.estado !== "active") return;
    s.estado = estado;
    s.motivoFim = motivo;
    if (s.ultimaObservacao) this.observacoes.delete(s.ultimaObservacao);
    s.ultimaObservacao = null;
    this.registrar(s, FERRAMENTAS.encerrar, "session.stop", "LOW", "WRITE", {}, "executada", motivo, null, null);
    try {
      await this.o.adaptador.encerrar(s.dispositivoId);
    } catch {
      // O aparelho não respondeu: a sessão já está fechada aqui, e nada mais é mandado a ele.
    }
  }

  private registrar(s: Sessao, ferramenta: string, operacao: AcaoRegistrada["operacao"], risco: string, categoria: string, args: Record<string, unknown>, desfecho: AcaoRegistrada["desfecho"], motivo: string | null, antes: string | null, depois: string | null) {
    this.registro.push({
      sessionId: s.id,
      seq: this.registro.filter((r) => r.sessionId === s.id).length + 1,
      ferramenta,
      operacao,
      risco,
      categoria,
      argsHash: payloadHash(args),
      desfecho,
      motivo,
      screenHashAntes: antes,
      screenHashDepois: depois,
      em: this.clock.now(),
    });
  }
}
