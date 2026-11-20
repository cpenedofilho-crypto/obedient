// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// O Growth OS como ferramenta das missões, por A2A (auditoria A2A de 06/11/2026, fase 3: orquestração).
//
// O Growth OS é o servidor A2A da casa. O OBEDIENT é cliente dele com uma credencial de MÁQUINA
// (client_credentials no WorkOS), cadastrada lá por uma pessoa e presa a uma organização e a uma lista
// fechada de skills. Por isso, aqui:
//   • só as pessoas listadas pelo dono do servidor (OBEDIENT_GROWTH_OS_USUARIOS) podem receber a
//     autoridade; a credencial vê a operação de uma organização, não é de qualquer pessoa do servidor;
//   • a autoridade é um grant do Ethics Engine como o de qualquer integração: concedido por ato
//     explícito (cli.ts growth-os <usuario>), com finalidade escrita, prazo de 30 dias e autonomia só
//     até risco baixo. Aparece no app e pode ser tirado. Sem grant vigente, a ferramenta nem é oferecida;
//   • as ferramentas desse grant são só leitura (risco LOW) e devolvem números sem dado pessoal (a
//     projeção é do Growth OS);
//   • COMPRAR no marketplace do Growth OS é outro sistema para o Ethics Engine (growth_os_compras),
//     com grant próprio: categoria FINANCIAL, então toda compra para e pede a aprovação da pessoa,
//     e o grant tem teto de valor por compra. Sem esse grant, a ferramenta de compra nem é oferecida.
//     O pagamento é simulado (carteiras contábeis do Growth OS); a regra é a mesma de dinheiro;
//   • PEDIR CÓDIGO (M6) é um terceiro sistema (growth_os_codigo), com grant próprio: abrir uma tarefa
//     de código é risco HIGH e sempre pede a aprovação da pessoa; ver a situação dela é leitura. No
//     Growth OS, a tarefa vira uma missão da Software Factory que uma pessoa de lá inicia, com o plano
//     e o relatório aprovados por gente, e termina num Pull Request. Merge nunca. O OBEDIENT não recebe
//     token do GitHub;
//   • o resultado volta ao modelo como conteúdo externo, nunca como instrução;
//   • a compra leva um messageId DERIVADO da aprovação (idDaMensagemA2A): reenviar a mesma execução
//     aprovada chega ao Growth OS com o mesmo id e não compra de novo (idempotência do A2A). Sem
//     aprovação reivindicada, a compra nem sai;
//   • a saída é pelo fetchSeguro do @obedient/a2a-client: card na mesma origem, sem redirect, IP
//     conferido na conexão;
//   • cada pedido leva a correlação da missão (correlation_id / x-correlation-id) e a que o Growth OS
//     devolve vai para a trilha (a2a.correlation), para ligar os dois lados numa auditoria.
// O segredo vem do ambiente do servidor (OBEDIENT_GROWTH_OS_SEGREDO), é lido na hora do token e nunca
// vai para log, banco ou conversa.

import { createHash, randomUUID } from "node:crypto";
import { ClienteA2A, correlacaoA2A, fonteClientCredentials, type Tarefa } from "@obedient/a2a-client";
import type { Executor, ItemGovernado } from "@obedient/agent-orchestrator";
import type { EthicsEngine } from "@obedient/ethics-engine";
import { AGENTE, PRAZO_DO_GRANT_MS, nomeParaModelo } from "@obedient/integrations";

export const SISTEMA_GROWTH_OS = "growth_os";
const SKILLS = { "growth_os.resumo_operacional": "resumo_operacional", "growth_os.catalogo_marketplace": "catalogo_marketplace" } as const;
type Ferramenta = keyof typeof SKILLS;

/** Compras: sistema à parte, para o grant de leitura nunca cobrir uma ação que gasta. */
export const SISTEMA_GROWTH_OS_COMPRAS = "growth_os_compras";
const FERRAMENTA_COMPRA = "growth_os_compras.comprar_conhecimento";
const CAMPO_DO_VALOR = "preco_maximo_micros";
/** Teto do piloto do marketplace no Growth OS: 10 unidades da moeda por consulta. */
export const TETO_MAXIMO_MICROS = 10_000_000;
export const FINALIDADE_GROWTH_OS_COMPRAS = `integracao:${SISTEMA_GROWTH_OS_COMPRAS}`;
export const explicacaoCompras = (tetoMicros: number) =>
  `Comprar, no marketplace interno do Growth OS, consultas ao conhecimento aprovado da organização, até ${tetoMicros} micro-unidades por compra. Pagamento simulado entre carteiras contábeis. Cada compra pede a sua aprovação.`;

/** Código: sistema à parte. Abrir é HIGH (sempre com aprovação); a situação é leitura. */
export const SISTEMA_GROWTH_OS_CODIGO = "growth_os_codigo";
const FERRAMENTA_ABRIR_CODIGO = "growth_os_codigo.abrir_tarefa_codigo";
const FERRAMENTA_STATUS_CODIGO = "growth_os_codigo.status_tarefa_codigo";
export const FINALIDADE_GROWTH_OS_CODIGO = `integracao:${SISTEMA_GROWTH_OS_CODIGO}`;
export const EXPLICACAO_GROWTH_OS_CODIGO =
  "Pedir ao Growth OS mudanças de código nos repositórios que o cadastro de lá libera: cada pedido pede a sua aprovação aqui, vira uma missão que uma pessoa do Growth OS inicia, tem o plano e o relatório aprovados por gente e termina num Pull Request. Nunca faz merge. Ver a situação do pedido é só leitura.";

export const FINALIDADE_GROWTH_OS = `integracao:${SISTEMA_GROWTH_OS}`;
/**
 * Finalidade do grant de leitura. Ele cobre TODA ferramenta de leitura do Growth OS (`growth_os.*`, risco
 * baixo), então o texto lista todas: ferramenta de leitura nova entra aqui também. Comprar é outro grant.
 */
export const EXPLICACAO_GROWTH_OS =
  "Ler no Growth OS, só leitura e sem dado pessoal: os números da operação da organização nas últimas 24 horas (agentes, execuções, eventos, aprovações e desempenho) e as ofertas à venda no marketplace interno. Não compra nada.";

export interface ConfigGrowthOs {
  cardUrl: string;
  tokenUrl: string;
  clientId: string;
  /** Quem pode receber a autoridade (ids de usuário do OBEDIENT). */
  usuarios: ReadonlySet<string>;
  /** Lido na hora do token; nunca guardado aqui. */
  segredo(): Promise<string>;
}

const https = (v: string | undefined) => {
  if (!v) return false;
  try { return new URL(v).protocol === "https:"; } catch { return false; }
};

/**
 * Tudo ou nada: sem nenhuma variável, a integração fica desligada (null); com parte delas, o servidor
 * não sobe (erro de configuração aparece na subida, não numa missão).
 */
export function configGrowthOsDoAmbiente(env: Record<string, string | undefined> = process.env): ConfigGrowthOs | null {
  const v = (k: string) => env[k]?.trim() || undefined;
  const nomes = ["OBEDIENT_GROWTH_OS_CARD_URL", "OBEDIENT_GROWTH_OS_TOKEN_URL", "OBEDIENT_GROWTH_OS_CLIENT_ID", "OBEDIENT_GROWTH_OS_SEGREDO", "OBEDIENT_GROWTH_OS_USUARIOS"];
  const presentes = nomes.filter((k) => v(k));
  if (!presentes.length) return null;
  const faltam = nomes.filter((k) => !v(k));
  if (faltam.length) throw new Error(`Growth OS: falta ${faltam.join(", ")} (ou tire todas as OBEDIENT_GROWTH_OS_* para desligar)`);
  if (!https(v("OBEDIENT_GROWTH_OS_CARD_URL")) || !https(v("OBEDIENT_GROWTH_OS_TOKEN_URL"))) throw new Error("Growth OS: card e token precisam ser https");
  const usuarios = new Set(v("OBEDIENT_GROWTH_OS_USUARIOS")!.split(",").map((s) => s.trim()).filter(Boolean));
  return {
    cardUrl: v("OBEDIENT_GROWTH_OS_CARD_URL")!,
    tokenUrl: v("OBEDIENT_GROWTH_OS_TOKEN_URL")!,
    clientId: v("OBEDIENT_GROWTH_OS_CLIENT_ID")!,
    usuarios,
    // Relido do ambiente a cada token: trocar o segredo e reiniciar não exige mudar código.
    segredo: async () => {
      const s = env.OBEDIENT_GROWTH_OS_SEGREDO?.trim();
      if (!s) throw new Error("Growth OS: segredo ausente");
      return s;
    },
  };
}

export function clienteGrowthOs(cfg: ConfigGrowthOs, http?: typeof fetch): ClienteA2A {
  return new ClienteA2A({
    cardUrl: cfg.cardUrl,
    token: fonteClientCredentials({ tokenUrl: cfg.tokenUrl, clientId: cfg.clientId, segredo: cfg.segredo, ...(http ? { fetch: http } : {}) }),
    ...(http ? { fetch: http } : {}),
  });
}

/** As ferramentas de leitura do Growth OS, como o laço do agente as quer. */
export function itensGrowthOs(): ItemGovernado[] {
  const leitura = (ferramenta: Ferramenta, description: string): ItemGovernado => ({
    definicao: { name: nomeParaModelo(ferramenta), description, input_schema: { type: "object", properties: {}, additionalProperties: false } },
    chave: `${SISTEMA_GROWTH_OS}/${ferramenta}`,
    sistema: SISTEMA_GROWTH_OS,
    ferramenta,
    risco: "LOW",
    categoria: "READ",
    finalidade: FINALIDADE_GROWTH_OS,
  });
  return [
    leitura("growth_os.resumo_operacional", "Números da operação no Growth OS nas últimas 24 horas: agentes ativos, pausados e falhando; execuções por estado; eventos; aprovações; desempenho. Cada bloco traz a fonte. Sem dado pessoal."),
    leitura("growth_os.catalogo_marketplace", "Ofertas ativas do marketplace interno do Growth OS: identificador, preço em micro-unidades, moeda e escopo do conhecimento vendido. Só leitura: não compra nada."),
  ];
}

/** A ferramenta de compra. Só entra no catálogo de quem tem o grant de compras vigente. */
export function itensGrowthOsCompras(): ItemGovernado[] {
  return [{
    definicao: {
      name: nomeParaModelo(FERRAMENTA_COMPRA),
      description: "Compra, no marketplace interno do Growth OS, uma consulta ao conhecimento aprovado de uma oferta. Pagamento simulado, debitado da carteira do agente cadastrada lá. Sempre pede a aprovação da pessoa. Informe a oferta (identificador do catálogo), a consulta e o preço máximo aceito, igual ao preço do catálogo. Sem conteúdo para a consulta, nada é cobrado.",
      input_schema: {
        type: "object",
        properties: {
          oferta: { type: "string", description: "Identificador da oferta, como veio do catálogo." },
          consulta: { type: "string", description: "O que se quer saber. Só filtra o conteúdo entregue." },
          [CAMPO_DO_VALOR]: { type: "integer", description: "Preço máximo aceito, em micro-unidades da moeda. Se a oferta custar mais, a compra não é feita." },
        },
        required: ["oferta", "consulta", CAMPO_DO_VALOR],
        additionalProperties: false,
      },
    },
    chave: `${SISTEMA_GROWTH_OS_COMPRAS}/${FERRAMENTA_COMPRA}`,
    sistema: SISTEMA_GROWTH_OS_COMPRAS,
    ferramenta: FERRAMENTA_COMPRA,
    risco: "MEDIUM",
    categoria: "FINANCIAL",
    finalidade: FINALIDADE_GROWTH_OS_COMPRAS,
  }];
}

/** As ferramentas de código. Só entram no catálogo de quem tem o grant de código vigente. */
export function itensGrowthOsCodigo(): ItemGovernado[] {
  return [
    {
      definicao: {
        name: nomeParaModelo(FERRAMENTA_ABRIR_CODIGO),
        description:
          "Pede ao Growth OS uma mudança de código num repositório liberado lá. Sempre pede a aprovação da pessoa. Não escreve nada na hora: abre uma missão que uma pessoa do Growth OS inicia, com o plano e o relatório aprovados por gente, e que termina num Pull Request (em rascunho, por padrão). Nunca faz merge. Devolve o missao_id para acompanhar com status_tarefa_codigo.",
        input_schema: {
          type: "object",
          properties: {
            repositorio: { type: "string", description: "dono/repositorio, liberado no cadastro do Growth OS." },
            pedido: { type: "string", description: "O que mudar, em linguagem de pessoa (10 a 2000 caracteres). Sem e-mail nem telefone." },
            caminhos: { type: "array", items: { type: "string" }, description: "Os únicos caminhos que podem ser tocados (relativos, de 1 a 30)." },
            rascunho: { type: "boolean", description: "PR em rascunho (padrão true)." },
          },
          required: ["repositorio", "pedido", "caminhos"],
          additionalProperties: false,
        },
      },
      chave: `${SISTEMA_GROWTH_OS_CODIGO}/${FERRAMENTA_ABRIR_CODIGO}`,
      sistema: SISTEMA_GROWTH_OS_CODIGO,
      ferramenta: FERRAMENTA_ABRIR_CODIGO,
      risco: "HIGH",
      categoria: "WRITE",
      finalidade: FINALIDADE_GROWTH_OS_CODIGO,
    },
    {
      definicao: {
        name: nomeParaModelo(FERRAMENTA_STATUS_CODIGO),
        description:
          "Situação de uma tarefa de código aberta no Growth OS: estado da missão e de cada etapa, o que espera uma pessoa de lá (iniciar, aprovar o plano, aprovar o relatório) e, quando houver, o Pull Request (endereço, número, commit e CI). Só leitura.",
        input_schema: { type: "object", properties: { missao_id: { type: "string", description: "O missao_id que abrir_tarefa_codigo devolveu." } }, required: ["missao_id"], additionalProperties: false },
      },
      chave: `${SISTEMA_GROWTH_OS_CODIGO}/${FERRAMENTA_STATUS_CODIGO}`,
      sistema: SISTEMA_GROWTH_OS_CODIGO,
      ferramenta: FERRAMENTA_STATUS_CODIGO,
      risco: "LOW",
      categoria: "READ",
      finalidade: FINALIDADE_GROWTH_OS_CODIGO,
    },
  ];
}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Abrir a tarefa de código, depois de aprovada. O messageId vem da aprovação: reenviar não abre outra. */
async function abrirCodigo(enviar: Enviar, a: Record<string, unknown>, approvalId: string | undefined) {
  if (!approvalId) return { estado: "recusada", motivo: "codigo_sem_aprovacao" };
  if (Object.keys(a).some((k) => !["repositorio", "pedido", "caminhos", "rascunho"].includes(k))) return { estado: "recusada", motivo: "argumento_nao_previsto" };
  if (typeof a.repositorio !== "string" || !REPO.test(a.repositorio)) return { estado: "recusada", motivo: "repositorio_invalido" };
  if (typeof a.pedido !== "string" || a.pedido.trim().length < 10 || a.pedido.length > 2000) return { estado: "recusada", motivo: "pedido_invalido" };
  if (!Array.isArray(a.caminhos) || !a.caminhos.length || a.caminhos.length > 30 || a.caminhos.some((c) => typeof c !== "string" || !c || c.length > 300 || c.includes("..") || c.startsWith("/")))
    return { estado: "recusada", motivo: "caminhos_invalidos" };
  if (a.rascunho !== undefined && typeof a.rascunho !== "boolean") return { estado: "recusada", motivo: "rascunho_invalido" };
  const dados = { repositorio: a.repositorio, pedido: a.pedido.trim(), caminhos: a.caminhos, ...(a.rascunho !== undefined ? { rascunho: a.rascunho } : {}) };
  return paraModelo(await enviar("abrir_tarefa_codigo", { messageId: idDaMensagemA2A(approvalId, FERRAMENTA_ABRIR_CODIGO), dados }));
}

async function statusCodigo(enviar: Enviar, a: Record<string, unknown>) {
  if (Object.keys(a).some((k) => k !== "missao_id") || typeof a.missao_id !== "string" || !UUID.test(a.missao_id)) return { estado: "recusada", motivo: "missao_id_invalido" };
  return paraModelo(await enviar("status_tarefa_codigo", { messageId: `obedient-${randomUUID()}`, dados: { missao_id: a.missao_id } }));
}

/** O que volta ao modelo: só o estado e os dados das partes estruturadas. Nem id de tarefa, nem texto livre. */
function paraModelo(t: Tarefa) {
  if (t.estado !== "TASK_STATE_COMPLETED") return { estado: t.estado, ...(t.erro ? { erro: t.erro } : {}), dados: null };
  return { estado: t.estado, dados: t.artefatos.flatMap((a) => a.partes.filter((p) => p.data !== undefined).map((p) => p.data)) };
}

const dadosDa = (t: Tarefa): unknown[] => t.artefatos.flatMap((a) => a.partes.filter((p) => p.data !== undefined).map((p) => p.data));
const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * O messageId de uma execução aprovada: o mesmo para a mesma aprovação e ferramenta, sempre. Hash, para
 * o id interno da aprovação não ir para o outro sistema.
 */
export function idDaMensagemA2A(approvalId: string, ferramenta: string, etapa = ""): string {
  return `obedient-${createHash("sha256").update(`${approvalId}\n${ferramenta}\n${etapa}`).digest("hex").slice(0, 32)}`;
}

/** Preço da oferta no catálogo do Growth OS, ou null se ela não está à venda. */
/** Um pedido ao Growth OS com a correlação da execução; avisa quem registra o que voltou. */
type Enviar = (skill: string, o: { messageId: string; dados?: Record<string, unknown> }) => Promise<Tarefa>;

async function precoNoCatalogo(enviar: Enviar, oferta: string, messageId: string): Promise<{ precoMicros: number; compraLigada: boolean } | null> {
  const t = await enviar("catalogo_marketplace", { messageId });
  if (t.estado !== "TASK_STATE_COMPLETED") throw new Error("catálogo do Growth OS indisponível");
  for (const d of dadosDa(t)) {
    if (!obj(d) || !Array.isArray(d.ofertas)) continue;
    const o = d.ofertas.find((x) => obj(x) && x.oferta === oferta);
    if (obj(o) && typeof o.preco_micros === "string" && /^[0-9]{1,15}$/.test(o.preco_micros)) return { precoMicros: Number(o.preco_micros), compraLigada: d.compra_ligada === true };
  }
  return null;
}

/**
 * A compra, depois de autorizada e aprovada. Confere o preço no catálogo contra o que a pessoa
 * aprovou (preço de oferta não muda no Growth OS: preço novo é oferta nova) e só então compra.
 * Ao Growth OS vão só a oferta e a consulta; quem paga e o teto de lá saem do cadastro de lá.
 */
async function comprar(enviar: Enviar, argumentos: Record<string, unknown>, approvalId: string | undefined) {
  const { oferta, consulta } = argumentos;
  // Toda compra é FINANCIAL e passa por aprovação: sem o id dela, não há como comprar uma vez só.
  if (!approvalId) return { estado: "recusada", motivo: "compra_sem_aprovacao" };
  const maximo = argumentos[CAMPO_DO_VALOR];
  if (typeof oferta !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(oferta) || oferta.length > 80) return { estado: "recusada", motivo: "oferta_invalida" };
  if (typeof consulta !== "string" || !consulta.trim() || consulta.length > 500) return { estado: "recusada", motivo: "consulta_invalida" };
  if (typeof maximo !== "number" || !Number.isInteger(maximo) || maximo < 1 || maximo > TETO_MAXIMO_MICROS) return { estado: "recusada", motivo: "preco_maximo_invalido" };
  const noCatalogo = await precoNoCatalogo(enviar, oferta, idDaMensagemA2A(approvalId, FERRAMENTA_COMPRA, "catalogo"));
  if (!noCatalogo) return { estado: "recusada", motivo: "oferta_fora_do_catalogo" };
  if (!noCatalogo.compraLigada) return { estado: "recusada", motivo: "compra_desligada_no_growth_os" };
  if (noCatalogo.precoMicros > maximo) return { estado: "recusada", motivo: "preco_acima_do_aprovado", preco_micros: noCatalogo.precoMicros };
  return paraModelo(await enviar("comprar_conhecimento", { messageId: idDaMensagemA2A(approvalId, FERRAMENTA_COMPRA), dados: { oferta, consulta: consulta.trim() } }));
}

/** O que foi para a trilha de um pedido ao Growth OS: a correlação enviada e a devolvida por ele. */
export interface CorrelacaoA2A {
  sistema: string;
  ferramenta: string;
  skill: string;
  enviada: string;
  devolvida: string | null;
}

/**
 * O executor que o Ethics Engine chama depois de autorizar: a skill A2A correspondente, nada além.
 * Cada pedido leva a correlação da execução (a missão, saneada) e `registrar` recebe a devolvida.
 */
export function executorGrowthOs(cliente: ClienteA2A, registrar?: (c: CorrelacaoA2A) => Promise<void>): Executor {
  return async (sistema, ferramenta, argumentos, execucao) => {
    const enviada = correlacaoA2A(execucao?.correlationId);
    const enviar: Enviar = async (skill, o) => {
      const t = await cliente.enviar(skill, { ...o, correlationId: enviada });
      await registrar?.({ sistema, ferramenta, skill, enviada, devolvida: t.correlationId });
      return t;
    };
    if (sistema === SISTEMA_GROWTH_OS_COMPRAS && ferramenta === FERRAMENTA_COMPRA) return comprar(enviar, argumentos, execucao?.approvalId);
    if (sistema === SISTEMA_GROWTH_OS_CODIGO && ferramenta === FERRAMENTA_ABRIR_CODIGO) return abrirCodigo(enviar, argumentos, execucao?.approvalId);
    if (sistema === SISTEMA_GROWTH_OS_CODIGO && ferramenta === FERRAMENTA_STATUS_CODIGO) return statusCodigo(enviar, argumentos);
    if (sistema !== SISTEMA_GROWTH_OS || !(ferramenta in SKILLS)) throw new Error("ferramenta do Growth OS desconhecida");
    // Os argumentos do modelo não chegam ao Growth OS: a skill é escolhida aqui, pela ferramenta autorizada.
    return paraModelo(await enviar(SKILLS[ferramenta as Ferramenta], { messageId: `obedient-${randomUUID()}` }));
  };
}

/**
 * Concede à pessoa a autoridade do agente no Growth OS (ato explícito do dono do servidor, pela linha de
 * comando). Só para quem está em OBEDIENT_GROWTH_OS_USUARIOS. Conceder de novo substitui a anterior.
 */
export async function concederGrowthOs(motor: EthicsEngine, cfg: ConfigGrowthOs, userId: string, agora: Date, concedidoPor: string = userId): Promise<void> {
  if (!cfg.usuarios.has(userId)) throw new Error("essa pessoa não está em OBEDIENT_GROWTH_OS_USUARIOS");
  await retirarGrowthOs(motor, userId);
  await motor.grants.grant(
    {
      userId,
      agentId: AGENTE,
      systemId: SISTEMA_GROWTH_OS,
      capability: `${SISTEMA_GROWTH_OS}.*`,
      purpose: EXPLICACAO_GROWTH_OS,
      limits: { maxRisk: "LOW", autonomousUpTo: "LOW", maxAmount: null, amountField: null },
      expiresAt: new Date(agora.getTime() + PRAZO_DO_GRANT_MS),
    },
    concedidoPor,
  );
}

export async function retirarGrowthOs(motor: EthicsEngine, userId: string): Promise<void> {
  for (const g of await motor.grants.list(userId)) if (g.agentId === AGENTE && g.systemId === SISTEMA_GROWTH_OS && !g.revokedAt) await motor.grants.revoke(g.id, userId);
}

/** A pessoa tem autoridade vigente no Growth OS? (Sem ela, a ferramenta nem é oferecida ao modelo.) */
export async function temGrowthOs(motor: EthicsEngine, userId: string, agora: Date): Promise<boolean> {
  return (await motor.grants.list(userId)).some((g) => g.agentId === AGENTE && g.systemId === SISTEMA_GROWTH_OS && !g.revokedAt && g.expiresAt > agora);
}

/**
 * Concede à pessoa a autoridade de COMPRAR no marketplace do Growth OS, com teto por compra. Ato
 * explícito do dono do servidor, pela linha de comando, só para quem está em
 * OBEDIENT_GROWTH_OS_USUARIOS. Nenhuma compra é autônoma: a categoria FINANCIAL sempre pede a
 * aprovação da pessoa. Conceder de novo substitui a anterior.
 */
export async function concederComprasGrowthOs(motor: EthicsEngine, cfg: ConfigGrowthOs, userId: string, tetoMicros: number, agora: Date, concedidoPor: string = userId): Promise<void> {
  if (!cfg.usuarios.has(userId)) throw new Error("essa pessoa não está em OBEDIENT_GROWTH_OS_USUARIOS");
  if (!Number.isInteger(tetoMicros) || tetoMicros < 1 || tetoMicros > TETO_MAXIMO_MICROS) throw new Error(`teto por compra tem de ser inteiro entre 1 e ${TETO_MAXIMO_MICROS} micro-unidades`);
  await retirarComprasGrowthOs(motor, userId);
  await motor.grants.grant(
    {
      userId,
      agentId: AGENTE,
      systemId: SISTEMA_GROWTH_OS_COMPRAS,
      capability: `${SISTEMA_GROWTH_OS_COMPRAS}.*`,
      purpose: explicacaoCompras(tetoMicros),
      limits: { maxRisk: "CRITICAL", autonomousUpTo: null, maxAmount: tetoMicros, amountField: CAMPO_DO_VALOR },
      expiresAt: new Date(agora.getTime() + PRAZO_DO_GRANT_MS),
    },
    concedidoPor,
  );
}

export async function retirarComprasGrowthOs(motor: EthicsEngine, userId: string): Promise<void> {
  for (const g of await motor.grants.list(userId)) if (g.agentId === AGENTE && g.systemId === SISTEMA_GROWTH_OS_COMPRAS && !g.revokedAt) await motor.grants.revoke(g.id, userId);
}

export async function temComprasGrowthOs(motor: EthicsEngine, userId: string, agora: Date): Promise<boolean> {
  return (await motor.grants.list(userId)).some((g) => g.agentId === AGENTE && g.systemId === SISTEMA_GROWTH_OS_COMPRAS && !g.revokedAt && g.expiresAt > agora);
}

/**
 * Concede à pessoa a autoridade de PEDIR CÓDIGO ao Growth OS (M6). Ato explícito do dono do servidor,
 * pela linha de comando, só para quem está em OBEDIENT_GROWTH_OS_USUARIOS. Abrir uma tarefa é HIGH:
 * sempre pede a aprovação da pessoa. Só a situação (leitura) é autônoma. Conceder de novo substitui.
 */
export async function concederCodigoGrowthOs(motor: EthicsEngine, cfg: ConfigGrowthOs, userId: string, agora: Date, concedidoPor: string = userId): Promise<void> {
  if (!cfg.usuarios.has(userId)) throw new Error("essa pessoa não está em OBEDIENT_GROWTH_OS_USUARIOS");
  await retirarCodigoGrowthOs(motor, userId);
  await motor.grants.grant(
    {
      userId,
      agentId: AGENTE,
      systemId: SISTEMA_GROWTH_OS_CODIGO,
      capability: `${SISTEMA_GROWTH_OS_CODIGO}.*`,
      purpose: EXPLICACAO_GROWTH_OS_CODIGO,
      limits: { maxRisk: "HIGH", autonomousUpTo: "LOW", maxAmount: null, amountField: null },
      expiresAt: new Date(agora.getTime() + PRAZO_DO_GRANT_MS),
    },
    concedidoPor,
  );
}

export async function retirarCodigoGrowthOs(motor: EthicsEngine, userId: string): Promise<void> {
  for (const g of await motor.grants.list(userId)) if (g.agentId === AGENTE && g.systemId === SISTEMA_GROWTH_OS_CODIGO && !g.revokedAt) await motor.grants.revoke(g.id, userId);
}

export async function temCodigoGrowthOs(motor: EthicsEngine, userId: string, agora: Date): Promise<boolean> {
  return (await motor.grants.list(userId)).some((g) => g.agentId === AGENTE && g.systemId === SISTEMA_GROWTH_OS_CODIGO && !g.revokedAt && g.expiresAt > agora);
}
