// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Proveniência: extraído de casa-de-ia/src/mcp-gateway/risco.ts (commit 45ba448), do mesmo autor,
// pela decisão D7 (opção A). Nomes mantidos em português de propósito: o Growth OS passa a
// consumir este pacote trocando só o caminho do import. Ver docs/architecture/extracao-growth-os.md.
//
// Classificação de risco e permissões das ferramentas descobertas. Regras puras.
//
// As anotações MCP (readOnlyHint, destructiveHint...) são DICAS do servidor: a
// especificação manda não confiar nelas cegamente. Por isso o nome também pesa, e na
// dúvida o risco sobe. A classificação é o piso automático; quem baixa é um humano
// (risk_override, auditado).
import { ordemRisco, type Risco } from "./tipos.ts";

export interface FerramentaDescoberta {
  name: string;
  description?: string;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
}

// Gasto de mídia: ativar anúncio, impulsionar post e mexer em orçamento ou lance começam a
// gastar dinheiro (Meta Ads MCP: ads_activate_entity, ads_boost_ig_post). Contam como pagamento.
const GASTO_DE_MIDIA = "budget|orcament|spend|activat|(?:^|_)ativar(?:_|$)|boost|impulsion|(?:^|_)bid(?:_|$)|(?:^|_)lance(?:_|$)";
// Ferramentas da Meta (Meta Ads MCP) que mudam orçamento, status ou entrega de campanha no ar pelo
// NOME, sem palavra de gasto que o regex acima pegue. Conferido no esquema de cada uma (19/10/2026):
//  - ads_update_entity: muda daily_budget, lifetime_budget, spend_cap, lance, status (PAUSED,
//    ARCHIVED, DELETED) e o público inteiro de campanha, conjunto ou anúncio já publicado;
//  - ads_create_ad_set e ads_create_campaign: levam orçamento (daily_budget, campaign_daily_budget,
//    spend cap); nascem pausados ou em rascunho, mas o orçamento vale na hora da ativação;
//  - ads_experiment_abtest_create_test, ads_experiment_abtest_update_test e
//    ads_experiment_lift_create_test: dividem orçamento e entrega de entidades no ar (budget_percentage,
//    público de controle) e encerram teste em andamento.
// ads_activate_entity e ads_boost_ig_post já caem no regex (activat, boost). ads_create_ad fica de
// fora: nasce pausado, sem status nem orçamento, e só gasta pela ads_activate_entity.
// Nome exato, com no máximo um prefixo de namespace (meta.ads_update_entity).
const MIDIA_NO_AR = /(?:^|_)ads_(update_entity|create_ad_set|create_campaign|experiment_abtest_create_test|experiment_abtest_update_test|experiment_lift_create_test)$/;
const DOMINIO_CRITICO = new RegExp(
  `(delet|remov|apag|exclu|destru|drop|purg|estorn|refund|cancel|revog|revok|pagament|payment|pagar|charge|cobran|boleto|(?:^|_)pix(?:_|$)|transfer|financ|juridic|legal|judicia|protest|contrat|acordo|agreement|${GASTO_DE_MIDIA})`,
);
const COMUNICACAO_EXTERNA = /(enviar|envio|send|notific|mensag|message|email|whatsapp|sms|publicar|publish|post_)/;
// Verbo de leitura no começo, com no máximo um prefixo de namespace (ex.: motor_, recupera.).
// "status" não é verbo: saiu da lista (atualizar_status casava como leitura).
const LEITURA = /^([a-z0-9]+_)?(get|list|listar|consultar|buscar|obter|ler|read|search|pesquisar|detalhar|resumo|ping|quem_sou|contar|calcular|identificar|sugerir)(_|$)/;
// Verbo de escrita no começo do nome: o que vem depois não vira "leitura" (update_status, create_list,
// send_status_update). Sem isto, o prefixo opcional de namespace aceitava o próprio verbo de escrita.
const VERBO_DE_ESCRITA = /^(atualizar|update|criar|create|registrar|register|gravar|salvar|save|set|definir|marcar|mark|editar|edit|alterar|change|mudar|adicionar|add|inserir|insert|incluir|enviar|send|post|publicar|publish|agendar|schedule|aplicar|apply|executar|execute|exec|run|iniciar|start|parar|stop|ativar|activate|desativar|deactivate|habilitar|enable|desabilitar|disable|mover|move|copiar|copy|upload|reset|resetar|apagar|delete|remover|remove)_/;

function normal(nome: string): string {
  return nome.toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

/** Nome de leitura: verbo de leitura no começo e nenhum verbo de escrita antes dele. */
function ehLeitura(n: string): boolean {
  return LEITURA.test(n) && !VERBO_DE_ESCRITA.test(n);
}

/** Comunicação externa que não é leitura explícita (enviar_mensagem sim; consultar_mensagens não). */
function ehComunicacao(n: string): boolean {
  return COMUNICACAO_EXTERNA.test(n) && !ehLeitura(n);
}

export function classificar(f: FerramentaDescoberta): { nivel: Risco; motivo: string } {
  const n = normal(f.name);
  const a = f.annotations ?? {};
  const critico = DOMINIO_CRITICO.test(n);
  if (a.destructiveHint === true) return { nivel: "CRITICAL", motivo: "anotação destructiveHint" };
  // Mexe em verba ou status de campanha da Meta: nem readOnlyHint (dica do servidor) baixa.
  if (MIDIA_NO_AR.test(n)) return { nivel: "CRITICAL", motivo: "muda orçamento ou status de campanha no ar (Meta Ads)" };
  if (critico && a.readOnlyHint !== true) return { nivel: "CRITICAL", motivo: "nome indica ação destrutiva, financeira ou jurídica" };
  // Comunicação externa: a dica do servidor (readOnlyHint) não rebaixa, como em MIDIA_NO_AR.
  if (ehComunicacao(n)) return { nivel: "HIGH", motivo: a.readOnlyHint === true ? "comunicação externa (readOnlyHint não rebaixa)" : "comunicação externa" };
  if (a.readOnlyHint === true) {
    return critico
      ? { nivel: "MEDIUM", motivo: "readOnlyHint em domínio financeiro ou jurídico" }
      : { nivel: "LOW", motivo: "anotação readOnlyHint" };
  }
  if (ehLeitura(n)) return { nivel: "MEDIUM", motivo: "nome sugere leitura, sem anotação que confirme" };
  return { nivel: "HIGH", motivo: "escrita sem anotação: classificação conservadora" };
}

// ------------------------------------------------------------------ categoria (o QUE a ferramenta faz)
//
// O risco é o quanto preocupa (LOW..CRITICAL); a categoria é a natureza da ação. Gravada em
// mcp_tools.category (0009) para política e regra fixa decidirem por ela. Vem do NOME e das
// anotações, nunca da descrição (texto livre do servidor); na dúvida, a categoria mais séria.
// Ordem: destrutiva > financeira > jurídica > comunicação > leitura > escrita.

export const CATEGORIAS = ["READ", "WRITE", "COMMUNICATION", "FINANCIAL", "LEGAL", "DESTRUCTIVE"] as const;
export type Categoria = (typeof CATEGORIAS)[number];

const DESTRUTIVA = /(delet|remov|apag|exclu|destru|drop|purg|revog|revok|cancel)/;
// Verbo destrutivo como palavra do nome, em qualquer posição (get_and_delete_x, obter_e_cancelar): vence
// o verbo de leitura do começo. Substantivo (listar_cancelamentos) segue leitura.
const VERBO_DESTRUTIVO = /(?:^|_)(delete|deletar|remove|remover|apagar|excluir|destroy|destruir|drop|purge|purgar|revoke|revogar|cancel|cancelar)(?:_|$)/;
const FINANCEIRA = new RegExp(`(pagament|payment|pagar|charge|cobran|boleto|(?:^|_)pix(?:_|$)|transfer|financ|estorn|refund|${GASTO_DE_MIDIA})`);
const JURIDICA = /(juridic|legal|judicia|protest|contrat|acordo|agreement)/;

export function classificarCategoria(f: FerramentaDescoberta): { categoria: Categoria; motivo: string } {
  const n = normal(f.name);
  const a = f.annotations ?? {};
  // readOnlyHint não faz de comunicação externa uma leitura (a dica é do servidor).
  const leitura = (a.readOnlyHint === true && !ehComunicacao(n)) || ehLeitura(n);
  // Verbo destrutivo vence a anotação: a especificação manda não confiar nela cegamente.
  if (a.destructiveHint === true) return { categoria: "DESTRUCTIVE", motivo: "anotação destructiveHint" };
  if (VERBO_DESTRUTIVO.test(n) || (DESTRUTIVA.test(n) && !ehLeitura(n))) return { categoria: "DESTRUCTIVE", motivo: "nome indica ação destrutiva" };
  // Verba e status de campanha no ar: nem readOnlyHint tira de financeira.
  if (MIDIA_NO_AR.test(n)) return { categoria: "FINANCIAL", motivo: "muda orçamento ou status de campanha no ar (Meta Ads)" };
  if (leitura) return { categoria: "READ", motivo: a.readOnlyHint === true ? "anotação readOnlyHint" : "nome indica leitura" };
  if (FINANCEIRA.test(n)) return { categoria: "FINANCIAL", motivo: "nome indica ação financeira" };
  if (JURIDICA.test(n)) return { categoria: "LEGAL", motivo: "nome indica ação jurídica" };
  if (COMUNICACAO_EXTERNA.test(n)) return { categoria: "COMMUNICATION", motivo: "nome indica comunicação externa" };
  return { categoria: "WRITE", motivo: "escrita" };
}

/**
 * Categoria que vale: a reclassificação humana, a gravada na descoberta, ou (linha anterior à
 * 0009, ainda sem categoria gravada) a calculada agora — nunca "sem categoria".
 */
export function categoriaEfetiva(t: { name: string; annotations: unknown; category?: string | null; categoryOverride?: string | null }): Categoria {
  const c = t.categoryOverride ?? t.category;
  if (c && (CATEGORIAS as readonly string[]).includes(c)) return c as Categoria;
  return classificarCategoria({ name: t.name, annotations: (t.annotations ?? {}) as FerramentaDescoberta["annotations"] }).categoria;
}

/** Permissões exigidas por padrão: leitura até MEDIUM, escrita em HIGH, escrita + crítica em CRITICAL. */
export function permissoesPadrao(servidor: string, nivel: Risco): string[] {
  if (ordemRisco(nivel) <= ordemRisco("MEDIUM")) return [`mcp:${servidor}:read`];
  if (nivel === "HIGH") return [`mcp:${servidor}:write`];
  return [`mcp:${servidor}:write`, `mcp:${servidor}:critical`];
}

/** "mcp:calendar:read" é satisfeita por ela mesma, "mcp:*:read", "mcp:calendar:*" ou "*". */
export function satisfaz(concedida: string, exigida: string): boolean {
  if (concedida === "*" || concedida === exigida) return true;
  const c = concedida.split(":");
  const e = exigida.split(":");
  return c.length === e.length && c.every((p, i) => p === "*" || p === e[i]);
}

export function temPermissoes(concedidas: readonly string[], exigidas: readonly string[]): string[] {
  return exigidas.filter((e) => !concedidas.some((c) => satisfaz(c, e)));
}

/** Categorias que nunca ficam abaixo de CRITICAL, qualquer que seja o risk_override (F-M02). */
export const CATEGORIAS_CRITICAS: readonly Categoria[] = ["FINANCIAL", "LEGAL", "DESTRUCTIVE"];

/**
 * A ferramenta é de uma categoria crítica? Vale a mais séria entre a categoria automática (gravada ou
 * calculada agora) e a reclassificação humana: trocar a categoria à mão também não tira a ferramenta
 * do piso, senão a mesma pessoa que baixa o risco baixaria a categoria antes (F-M02).
 */
export function ehCategoriaCritica(t: { name: string; annotations?: unknown; category?: string | null; categoryOverride?: string | null }): boolean {
  const automatica = categoriaEfetiva({ name: t.name, annotations: t.annotations, category: t.category ?? null });
  const humana = t.categoryOverride && (CATEGORIAS as readonly string[]).includes(t.categoryOverride) ? (t.categoryOverride as Categoria) : null;
  return CATEGORIAS_CRITICAS.includes(automatica) || (humana !== null && CATEGORIAS_CRITICAS.includes(humana));
}

/**
 * Risco que vale: a reclassificação humana ou o automático, com um piso fixo. Ferramenta financeira,
 * jurídica ou destrutiva é sempre CRITICAL, e o risk_override não a baixa (decisão F-M02, 19/10/2026;
 * docs/MCP_GOVERNANCE.md). Sem o nome, só o risco (chamada que ainda não sabe qual é a ferramenta).
 */
export function riscoEfetivo(t: { riskLevel: string; riskOverride: string | null; name?: string; annotations?: unknown; category?: string | null; categoryOverride?: string | null }): Risco {
  const risco = (t.riskOverride ?? t.riskLevel) as Risco;
  if (t.name !== undefined && risco !== "CRITICAL" && ehCategoriaCritica({ ...t, name: t.name })) return "CRITICAL";
  return risco;
}

/** Só leitura e idempotente podem ser repetidas depois de falha de transporte. */
export function podeRepetir(risco: Risco, annotations: FerramentaDescoberta["annotations"]): boolean {
  if (ordemRisco(risco) >= ordemRisco("HIGH")) return false;
  return risco === "LOW" || annotations?.readOnlyHint === true || annotations?.idempotentHint === true;
}

/** Política: padrão de ferramenta '*', exato, ou prefixo 'motor_listar*'. */
export function casaPadraoFerramenta(padrao: string, nome: string): boolean {
  if (padrao === "*") return true;
  return padrao.endsWith("*") ? nome.startsWith(padrao.slice(0, -1)) : padrao === nome;
}

/** Espelha o CHECK mcp_policies_pattern_check. */
export const REGEX_PADRAO_FERRAMENTA_POLITICA = /^(\*|[A-Za-z0-9_.-]+\*?)$/;
