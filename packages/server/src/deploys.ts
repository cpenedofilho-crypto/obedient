// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Controlador de deploys, SÓ LEITURA (marco M7, decisão D20).
//
// O agente pode saber em que pé está o deploy de um projeto da casa na Vercel e se ele responde, para
// acompanhar uma missão que terminou num Pull Request ou para dizer à pessoa se algo saiu do ar. Não
// pode promover, reverter, apagar, mexer em variável de ambiente nem disparar build: deploy de produção
// é ato que não se delega (CONSTITUTION, lista do que nunca se delega). Por isso, aqui:
//   • as três ferramentas são leitura (risco LOW, categoria READ). Não existe ferramenta de escrita
//     neste arquivo, nem "para depois";
//   • os projetos são uma lista fechada do dono do servidor (OBEDIENT_DEPLOYS_PROJETOS). O modelo
//     escolhe um nome dessa lista; o id do projeto na Vercel e o endereço de saúde vêm da configuração,
//     nunca do modelo. Um deploy de outro projeto é recusado, mesmo com o id certo;
//   • a autoridade é um grant do Ethics Engine (sistema "deploys"), concedido por ato explícito pela
//     linha de comando, só a quem o dono listou (OBEDIENT_DEPLOYS_USUARIOS), com prazo de 30 dias e
//     autonomia só até risco baixo. Sem grant vigente, as ferramentas nem são oferecidas;
//   • o token da Vercel (OBEDIENT_VERCEL_TOKEN) é lido do ambiente na hora de cada pedido e nunca vai
//     para log, banco ou conversa. Deve ser um token de leitura, criado pela pessoa (A8);
//   • o que volta ao modelo é projetado: estado, ambiente, datas, commit (40 hex) e branch (conferida
//     por formato). Nada de autor, e-mail, mensagem de commit, variável ou log de build;
//   • a saúde é um GET no endereço configurado, pelo fetchSeguro (sem redirect, IP conferido na
//     conexão), com prazo de 10 s. Volta só o código HTTP e o tempo; o corpo não é lido.

import type { Executor, ItemGovernado } from "@obedient/agent-orchestrator";
import type { EthicsEngine } from "@obedient/ethics-engine";
import { fetchSeguro } from "@obedient/integration-gateway";
import { AGENTE, PRAZO_DO_GRANT_MS, nomeParaModelo } from "@obedient/integrations";

export const SISTEMA_DEPLOYS = "deploys";
export const FINALIDADE_DEPLOYS = `integracao:${SISTEMA_DEPLOYS}`;
export const EXPLICACAO_DEPLOYS =
  "Ver na Vercel, só leitura, os deploys dos projetos que o dono do servidor listou: estado, ambiente, commit e branch de cada um, e se o endereço de saúde do projeto responde. Não promove, não reverte e não muda nada.";

const API_VERCEL = "https://api.vercel.com";
export const PRAZO_SAUDE_MS = 10_000;
const PRAZO_API_MS = 15_000;
const F_LISTAR = "deploys.listar_deploys";
const F_SITUACAO = "deploys.situacao_deploy";
const F_SAUDE = "deploys.verificar_saude";

export interface ProjetoDeploy {
  /** Nome curto que o modelo usa (a-z, 0-9, _). */
  id: string;
  nome: string;
  /** Id do projeto na Vercel (prj_…). */
  projeto: string;
  /** Endereço https de saúde do projeto (opcional: sem ele, não há verificar_saude para o projeto). */
  saude: string | null;
}

export interface ConfigDeploys {
  projetos: readonly ProjetoDeploy[];
  /** Time da Vercel, se os projetos forem de um time. */
  time: string | null;
  usuarios: ReadonlySet<string>;
  /** Lido na hora de cada pedido; nunca guardado aqui. */
  token(): Promise<string>;
}

const ID = /^[a-z][a-z0-9_]{1,39}$/;
const PROJETO_VERCEL = /^prj_[A-Za-z0-9]{8,64}$/;
const TIME_VERCEL = /^team_[A-Za-z0-9]{8,64}$/;
const DEPLOY = /^dpl_[A-Za-z0-9]{8,64}$/;
const SHA = /^[0-9a-f]{40}$/;
const BRANCH = /^[A-Za-z0-9._/-]{1,100}$/;

const https = (v: unknown) => {
  if (typeof v !== "string") return false;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && !u.username && !u.password;
  } catch { return false; }
};

/**
 * Tudo ou nada, como o Growth OS: sem nenhuma variável, desligado (null); com parte delas, o servidor
 * não sobe.
 */
export function configDeploysDoAmbiente(env: Record<string, string | undefined> = process.env): ConfigDeploys | null {
  const v = (k: string) => env[k]?.trim() || undefined;
  const nomes = ["OBEDIENT_VERCEL_TOKEN", "OBEDIENT_DEPLOYS_PROJETOS", "OBEDIENT_DEPLOYS_USUARIOS"];
  const presentes = nomes.filter((k) => v(k));
  if (!presentes.length && !v("OBEDIENT_VERCEL_TIME")) return null;
  const faltam = nomes.filter((k) => !v(k));
  if (faltam.length) throw new Error(`deploys: falta ${faltam.join(", ")} (ou tire todas para desligar)`);
  const time = v("OBEDIENT_VERCEL_TIME") ?? null;
  if (time && !TIME_VERCEL.test(time)) throw new Error("deploys: OBEDIENT_VERCEL_TIME precisa ser team_…");
  let cru: unknown;
  try { cru = JSON.parse(v("OBEDIENT_DEPLOYS_PROJETOS")!); } catch { throw new Error("deploys: OBEDIENT_DEPLOYS_PROJETOS não é JSON"); }
  if (!Array.isArray(cru) || !cru.length || cru.length > 20) throw new Error("deploys: OBEDIENT_DEPLOYS_PROJETOS é uma lista de 1 a 20 projetos");
  const projetos: ProjetoDeploy[] = cru.map((p, i) => {
    if (typeof p !== "object" || p === null || Array.isArray(p)) throw new Error(`deploys: projeto ${i} não é objeto`);
    const o = p as Record<string, unknown>;
    if (Object.keys(o).some((k) => !["id", "nome", "projeto", "saude"].includes(k))) throw new Error(`deploys: projeto ${i} com campo não previsto`);
    if (typeof o.id !== "string" || !ID.test(o.id)) throw new Error(`deploys: projeto ${i}: id é a-z, 0-9 e _ (2 a 40)`);
    if (typeof o.nome !== "string" || !o.nome.trim() || o.nome.length > 80) throw new Error(`deploys: projeto ${o.id}: nome de 1 a 80 caracteres`);
    if (typeof o.projeto !== "string" || !PROJETO_VERCEL.test(o.projeto)) throw new Error(`deploys: projeto ${o.id}: projeto é o id da Vercel (prj_…)`);
    if (o.saude !== undefined && !https(o.saude)) throw new Error(`deploys: projeto ${o.id}: saude precisa ser https`);
    return { id: o.id, nome: o.nome.trim(), projeto: o.projeto, saude: (o.saude as string | undefined) ?? null };
  });
  if (new Set(projetos.map((p) => p.id)).size !== projetos.length) throw new Error("deploys: id de projeto repetido");
  const usuarios = new Set(v("OBEDIENT_DEPLOYS_USUARIOS")!.split(",").map((s) => s.trim()).filter(Boolean));
  return {
    projetos,
    time,
    usuarios,
    token: async () => {
      const t = env.OBEDIENT_VERCEL_TOKEN?.trim();
      if (!t) throw new Error("deploys: token ausente");
      return t;
    },
  };
}

/** As ferramentas, como o laço do agente as quer. Os nomes dos projetos entram como enum. */
export function itensDeploys(cfg: ConfigDeploys): ItemGovernado[] {
  const projetos = cfg.projetos.map((p) => p.id);
  const comSaude = cfg.projetos.filter((p) => p.saude).map((p) => p.id);
  const lista = cfg.projetos.map((p) => `${p.id} (${p.nome})`).join(", ");
  const item = (ferramenta: string, description: string, properties: Record<string, unknown>, required: string[]): ItemGovernado => ({
    definicao: { name: nomeParaModelo(ferramenta), description, input_schema: { type: "object", properties, required, additionalProperties: false } },
    chave: `${SISTEMA_DEPLOYS}/${ferramenta}`,
    sistema: SISTEMA_DEPLOYS,
    ferramenta,
    risco: "LOW",
    categoria: "READ",
    finalidade: FINALIDADE_DEPLOYS,
  });
  const itens = [
    item(
      F_LISTAR,
      `Os deploys mais recentes de um projeto na Vercel, do mais novo ao mais velho: id, estado (BUILDING, READY, ERROR, CANCELED…), ambiente, quando foi criado, commit e branch. Só leitura. Projetos: ${lista}.`,
      {
        projeto: { type: "string", enum: projetos },
        ambiente: { type: "string", enum: ["production", "preview"], description: "Padrão: os dois." },
        limite: { type: "integer", minimum: 1, maximum: 10, description: "Quantos (padrão 5)." },
      },
      ["projeto"],
    ),
    item(
      F_SITUACAO,
      "Situação de um deploy (id dpl_…) de um projeto da lista: estado, ambiente, criado e pronto em, commit, branch e se o endereço principal já aponta para ele. Só leitura.",
      { projeto: { type: "string", enum: projetos }, deploy_id: { type: "string", description: "O id dpl_… que listar_deploys devolveu." } },
      ["projeto", "deploy_id"],
    ),
  ];
  if (comSaude.length) {
    itens.push(item(
      F_SAUDE,
      "Faz um GET no endereço de saúde do projeto e devolve só o código HTTP e o tempo de resposta. Não lê o corpo. Só leitura.",
      { projeto: { type: "string", enum: comSaude } },
      ["projeto"],
    ));
  }
  return itens;
}

const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const texto = (v: unknown, re: RegExp) => (typeof v === "string" && re.test(v) ? v : null);
const ESTADOS = new Set(["BUILDING", "ERROR", "INITIALIZING", "QUEUED", "READY", "CANCELED", "DELETED"]);
const estadoDe = (v: unknown) => (typeof v === "string" && ESTADOS.has(v) ? v : "DESCONHECIDO");
const ambienteDe = (v: unknown) => (v === "production" ? "production" : "preview");
const dataDe = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? new Date(v).toISOString() : null);

/** Um deploy como o modelo o vê. Tudo conferido por formato; o resto da resposta da Vercel fica de fora. */
function projetar(d: Record<string, unknown>) {
  const meta = obj(d.meta) ? d.meta : {};
  return {
    id: texto(d.uid ?? d.id, DEPLOY),
    estado: estadoDe(d.readyState ?? d.state),
    ambiente: ambienteDe(d.target),
    criado_em: dataDe(d.createdAt ?? d.created),
    commit: texto(meta.githubCommitSha, SHA),
    branch: texto(meta.githubCommitRef, BRANCH),
  };
}

type Http = typeof fetch;

/** O executor que o Ethics Engine chama depois de autorizar. Só GET, só nos projetos da lista. */
export function executorDeploys(cfg: ConfigDeploys, http: Http = fetchSeguro): Executor {
  const api = async (caminho: string, busca: URLSearchParams) => {
    if (cfg.time) busca.set("teamId", cfg.time);
    const r = await http(`${API_VERCEL}${caminho}?${busca}`, {
      method: "GET",
      headers: { authorization: `Bearer ${await cfg.token()}`, accept: "application/json" },
      signal: AbortSignal.timeout(PRAZO_API_MS),
    });
    if (r.status === 404) return { naoAchou: true as const };
    if (!r.ok) throw new Error(`Vercel respondeu ${r.status}`);
    const corpo: unknown = await r.json();
    if (!obj(corpo)) throw new Error("resposta da Vercel fora do formato");
    return { corpo };
  };
  return async (sistema, ferramenta, a) => {
    if (sistema !== SISTEMA_DEPLOYS) throw new Error("sistema de deploys desconhecido");
    const permitidos: Record<string, string[]> = { [F_LISTAR]: ["projeto", "ambiente", "limite"], [F_SITUACAO]: ["projeto", "deploy_id"], [F_SAUDE]: ["projeto"] };
    if (!(ferramenta in permitidos)) throw new Error("ferramenta de deploys desconhecida");
    if (Object.keys(a).some((k) => !permitidos[ferramenta]!.includes(k))) return { estado: "recusada", motivo: "argumento_nao_previsto" };
    const p = cfg.projetos.find((x) => x.id === a.projeto);
    if (!p) return { estado: "recusada", motivo: "projeto_fora_da_lista" };

    if (ferramenta === F_LISTAR) {
      if (a.ambiente !== undefined && a.ambiente !== "production" && a.ambiente !== "preview") return { estado: "recusada", motivo: "ambiente_invalido" };
      const limite = a.limite ?? 5;
      if (typeof limite !== "number" || !Number.isInteger(limite) || limite < 1 || limite > 10) return { estado: "recusada", motivo: "limite_invalido" };
      const busca = new URLSearchParams({ projectId: p.projeto, limit: String(limite) });
      if (a.ambiente) busca.set("target", a.ambiente);
      const r = await api("/v6/deployments", busca);
      if ("naoAchou" in r) return { estado: "recusada", motivo: "projeto_nao_encontrado_na_vercel" };
      const lista = Array.isArray(r.corpo.deployments) ? r.corpo.deployments : [];
      // Confere o projeto de cada um: a lista só traz deploys do projeto pedido.
      const deploys = lista.filter(obj).filter((d) => d.projectId === undefined || d.projectId === p.projeto).slice(0, limite).map(projetar);
      return { estado: "ok", projeto: p.id, deploys };
    }

    if (ferramenta === F_SITUACAO) {
      if (typeof a.deploy_id !== "string" || !DEPLOY.test(a.deploy_id)) return { estado: "recusada", motivo: "deploy_id_invalido" };
      const r = await api(`/v13/deployments/${a.deploy_id}`, new URLSearchParams());
      if ("naoAchou" in r) return { estado: "recusada", motivo: "deploy_nao_encontrado" };
      // O deploy tem de ser DESTE projeto: o id certo de outro projeto da conta não passa.
      if (r.corpo.projectId !== p.projeto) return { estado: "recusada", motivo: "deploy_de_outro_projeto" };
      return { estado: "ok", projeto: p.id, deploy: { ...projetar(r.corpo), pronto_em: dataDe(r.corpo.ready), endereco_principal_aponta: r.corpo.aliasAssigned === true || typeof r.corpo.aliasAssigned === "number" } };
    }

    if (!p.saude) return { estado: "recusada", motivo: "projeto_sem_endereco_de_saude" };
    const inicio = Date.now();
    try {
      const r = await http(p.saude, { method: "GET", headers: { accept: "*/*" }, signal: AbortSignal.timeout(PRAZO_SAUDE_MS) });
      // O corpo não é lido: só o código. Cancela para não segurar a conexão.
      await r.body?.cancel().catch(() => {});
      return { estado: "ok", projeto: p.id, status_http: r.status, responde: r.status >= 200 && r.status < 300, latencia_ms: Date.now() - inicio };
    } catch (e) {
      const nome = e instanceof Error ? e.name : "";
      return { estado: "ok", projeto: p.id, status_http: null, responde: false, latencia_ms: Date.now() - inicio, falha: nome === "TimeoutError" || nome === "AbortError" ? "passou_do_prazo" : "sem_conexao" };
    }
  };
}

/** Concede (ato explícito pela linha de comando). Só para quem está em OBEDIENT_DEPLOYS_USUARIOS. */
export async function concederDeploys(motor: EthicsEngine, cfg: ConfigDeploys, userId: string, agora: Date, concedidoPor: string = userId): Promise<void> {
  if (!cfg.usuarios.has(userId)) throw new Error("essa pessoa não está em OBEDIENT_DEPLOYS_USUARIOS");
  await retirarDeploys(motor, userId);
  await motor.grants.grant(
    {
      userId,
      agentId: AGENTE,
      systemId: SISTEMA_DEPLOYS,
      capability: `${SISTEMA_DEPLOYS}.*`,
      purpose: EXPLICACAO_DEPLOYS,
      limits: { maxRisk: "LOW", autonomousUpTo: "LOW", maxAmount: null, amountField: null },
      expiresAt: new Date(agora.getTime() + PRAZO_DO_GRANT_MS),
    },
    concedidoPor,
  );
}

export async function retirarDeploys(motor: EthicsEngine, userId: string): Promise<void> {
  for (const g of await motor.grants.list(userId)) if (g.agentId === AGENTE && g.systemId === SISTEMA_DEPLOYS && !g.revokedAt) await motor.grants.revoke(g.id, userId);
}

export async function temDeploys(motor: EthicsEngine, userId: string, agora: Date): Promise<boolean> {
  return (await motor.grants.list(userId)).some((g) => g.agentId === AGENTE && g.systemId === SISTEMA_DEPLOYS && !g.revokedAt && g.expiresAt > agora);
}
