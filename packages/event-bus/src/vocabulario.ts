// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Proveniência: o mecanismo de casa-de-ia/src/event-bus/vocabulario.ts (commit 45ba448), decisão D7.
// No Growth OS o vocabulário era uma lista fixa no módulo; aqui ele vira um VALOR que cada sistema
// cria com criarVocabulario(): o Growth OS passa o dele (lead, pagamento, aluno), o OBEDIENT o seu
// (missão, proposta, grant). As conferências que lá eram testes do vocabulário (formato canônico,
// tipo repetido, legado que colide) aqui rodam na construção: vocabulário inconsistente não nasce.
//
// Por que o vocabulário existe (histórico do Growth OS, 04/10/2026): um conector gravava
// `lead_created` (sublinhado) enquanto as assinaturas esperavam `lead.*` (ponto). Nada casava e nada
// avisava. O nome canônico tem ponto; o antigo vira `legado` e é traduzido na entrada.

/** Nome canônico: um ou mais segmentos com ponto entre eles (snake_case dentro do segmento). */
export const REGEX_TIPO_CANONICO = /^[a-z]+(_[a-z]+)*(\.[a-z]+(_[a-z]+)*)+$/;

export interface DefinicaoTipo {
  /** Nome canônico: dominio.acao ou dominio.sub.acao, minúsculas, com ponto. */
  tipo: string;
  /** entity_type aceitos para este tipo. */
  entidades: readonly string[];
  /** Fontes que podem publicar este tipo. Ausente = qualquer fonte autenticada. */
  fontes?: readonly string[];
  /** Nomes antigos que ainda podem chegar (e que já estão gravados no histórico). */
  legado?: readonly string[];
  descricao: string;
}

export interface ConfigVocabulario {
  /** Quem pode publicar (fonte vem do contexto autenticado, nunca do corpo). */
  fontes: readonly string[];
  /** Tipos de entidade aceitos. */
  entidades: readonly string[];
  /** Entidades com tabela no próprio sistema: aceitam id interno (UUID). As demais, só id externo. */
  entidadesInternas: readonly string[];
  /** Entidades que só aceitam id interno (ex.: a própria organização). */
  somenteInternas?: readonly string[];
  tipos: readonly DefinicaoTipo[];
  /**
   * Como o sistema aparece nas mensagens de recusa (vão para quem publica). Padrão neutro; o Growth OS
   * informa o dele para manter as mensagens que os produtores já conhecem.
   */
  mensagens?: MensagensVocabulario;
}

export interface MensagensVocabulario {
  /** Sujeito de "... não guarda dado pessoal". Padrão: "o barramento". */
  quemNaoGuardaDadoPessoal?: string;
  /** Documento citado quando o tipo não existe (ex.: "docs/EVENT_CONTRACT.md"). Padrão: nenhum. */
  referenciaContrato?: string;
}

export interface Vocabulario {
  readonly fontes: readonly string[];
  readonly entidades: readonly string[];
  readonly entidadesInternas: readonly string[];
  readonly somenteInternas: readonly string[];
  readonly tipos: readonly DefinicaoTipo[];
  readonly mensagens: Readonly<Required<Pick<MensagensVocabulario, "quemNaoGuardaDadoPessoal">> & Pick<MensagensVocabulario, "referenciaContrato">>;
  definicaoDoTipo(tipo: string): DefinicaoTipo | undefined;
  /** Traduz nome legado para o canônico; qualquer outro nome volta igual. */
  normalizarTipo(tipo: string): string;
  /** Padrão de assinatura com nome legado vira o canônico ('lead_created' → 'lead.created'). */
  normalizarPadrao(padrao: string): string;
  /** Por que um padrão ('*', tipo exato, 'prefixo.*') não serve, ou null se serve. */
  problemaDoPadrao(padrao: string): string | null;
}

export function criarVocabulario(cfg: ConfigVocabulario): Vocabulario {
  const erro = (m: string): never => {
    throw new Error(`vocabulário inválido: ${m}`);
  };
  const fontes = new Set(cfg.fontes);
  const entidades = new Set(cfg.entidades);
  for (const e of cfg.entidadesInternas) if (!entidades.has(e)) erro(`entidade interna "${e}" fora da lista de entidades`);
  for (const e of cfg.somenteInternas ?? []) if (!cfg.entidadesInternas.includes(e)) erro(`"${e}" só aceita id interno mas não é entidade interna`);

  const porTipo = new Map<string, DefinicaoTipo>();
  const legado = new Map<string, string>();
  for (const d of cfg.tipos) {
    if (!REGEX_TIPO_CANONICO.test(d.tipo)) erro(`tipo "${d.tipo}" fora do formato canônico (precisa de ponto)`);
    if (porTipo.has(d.tipo)) erro(`tipo "${d.tipo}" repetido`);
    if (!d.entidades.length) erro(`tipo "${d.tipo}" sem entidade`);
    for (const e of d.entidades) if (!entidades.has(e)) erro(`tipo "${d.tipo}" usa entidade desconhecida "${e}"`);
    for (const f of d.fontes ?? []) if (!fontes.has(f)) erro(`tipo "${d.tipo}" usa fonte desconhecida "${f}"`);
    porTipo.set(d.tipo, d);
  }
  for (const d of cfg.tipos)
    for (const l of d.legado ?? []) {
      if (l.includes(".")) erro(`legado "${l}" tem ponto`);
      if (porTipo.has(l)) erro(`legado "${l}" colide com um tipo canônico`);
      if (legado.has(l)) erro(`legado "${l}" repetido`);
      legado.set(l, d.tipo);
    }

  const normalizarTipo = (tipo: string) => legado.get(tipo) ?? tipo;
  const mensagens = Object.freeze({
    quemNaoGuardaDadoPessoal: cfg.mensagens?.quemNaoGuardaDadoPessoal ?? "o barramento",
    ...(cfg.mensagens?.referenciaContrato ? { referenciaContrato: cfg.mensagens.referenciaContrato } : {}),
  });
  const ref = mensagens.referenciaContrato ? ` (${mensagens.referenciaContrato})` : "";
  return Object.freeze({
    fontes: Object.freeze([...cfg.fontes]),
    entidades: Object.freeze([...cfg.entidades]),
    entidadesInternas: Object.freeze([...cfg.entidadesInternas]),
    somenteInternas: Object.freeze([...(cfg.somenteInternas ?? [])]),
    tipos: Object.freeze([...cfg.tipos]),
    mensagens,
    definicaoDoTipo: (tipo: string) => porTipo.get(tipo),
    normalizarTipo,
    normalizarPadrao: (padrao: string) => (padrao.endsWith(".*") || padrao === "*" ? padrao : normalizarTipo(padrao)),
    problemaDoPadrao(padrao: string): string | null {
      if (padrao === "*") return null;
      if (padrao.endsWith(".*")) {
        const prefixo = padrao.slice(0, -1);
        return cfg.tipos.some((d) => d.tipo.startsWith(prefixo)) ? null : `padrão "${padrao}" não casa com nenhum tipo do vocabulário`;
      }
      const canonico = normalizarTipo(padrao);
      if (canonico !== padrao) return `"${padrao}" é nome antigo; use "${canonico}"`;
      return porTipo.has(padrao) ? null : `tipo "${padrao}" não existe no vocabulário${ref}`;
    },
  });
}
