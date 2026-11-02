// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Proveniência: extraído de casa-de-ia/src/core/dado-pessoal.ts (commit 45ba448), decisão D7, etapa 5.
// Código idêntico; só o texto do cabeçalho deixou de falar das tabelas do Growth OS.
//
// Limpeza de dado pessoal em resultado de fonte externa (ferramenta MCP, contexto montado).
//
// Resultado de ferramenta vai para lugares que persistem (auditoria, o transcript do run, o que volta
// ao modelo). Todos passam por aqui, a menos que o consentimento do titular diga outra coisa.
//   • abre o envelope do MCP: o JSON costuma vir DENTRO de content[].text, e uma string não
//     revela chave nenhuma;
//   • chave de contato (telefone, e-mail, CPF, endereço...) → "[omitido]", em qualquer lugar;
//   • `nome` só é de pessoa debaixo de algo que é pessoa (identidade, lead, contato, aluno...),
//     na raiz ou dentro de LISTA genérica (`itens`, `resultado: [...]`). Lista com nome de coisa
//     (cursos, equipe, campanhas...) mantém o nome;
//   • em texto: e-mail → "[omitido]"; 8+ dígitos → "***NN"; data ISO fica;
//   • listas cortadas em `maxLista` itens, textos em 500 caracteres, profundidade em 6.

const CHAVES_DE_CONTATO = /^(telefone|telefone_?e164|phone|celular|whatsapp|email|e_?mail|cpf|rg|endereco|address|cep|data_?nascimento|lid_?whatsapp|canal_?lead_?id|instagram|usuario_?instagram)$/;
const CHAVES_DE_NOME = /^(nome|nome_?completo|primeiro_?nome|sobrenome|name|full_?name)$/;
const CHAVES_DE_PESSOA = /^(identidade|lead|leads|contato|contatos|contact|cliente|clientes|aluno|alunos|pessoa|pessoas|usuario|destinatario|remetente|responsavel|titular)$/;
/** Listas cujos itens NÃO são pessoas: o `nome` delas é de curso, equipe, campanha... e fica. */
const LISTAS_SEM_PESSOA = /^(cursos?|turmas?|consultoras?|equipe|unidades?|campanhas?|origens?|ferramentas?|tools|etapas?|tags?|categorias?|produtos?|servicos?)$/;
const MAX_TEXTO = 500;
const MAX_PROFUNDIDADE = 6;

function normalizarChave(k: string): string {
  return k.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
}

const EMAIL = /[^\s@"']+@[^\s@"']+\.[a-z]{2,}/gi;
const SEQUENCIA_DE_DIGITOS = /[(+]?\d[\d\s().+-]{6,}\d/g;

/** Sequência de 8+ dígitos (telefone, CPF, conta) que não é data ISO. */
function ehContatoNumerico(m: string): boolean {
  // Data ISO (2026-10-04, 2026-10-04 05...) não é telefone: decidir SLA depende dela.
  if (/^\d{4}-\d{2}-\d{2}(\D|$)/.test(m)) return false;
  return m.replace(/\D/g, "").length >= 8;
}

export function mascararTexto(s: string): string {
  const semEmail = s.replace(EMAIL, "[omitido]");
  const semDigitos = semEmail.replace(SEQUENCIA_DE_DIGITOS, (m) => (ehContatoNumerico(m) ? `***${m.replace(/\D/g, "").slice(-2)}` : m));
  return semDigitos.length > MAX_TEXTO ? `${semDigitos.slice(0, MAX_TEXTO)}…` : semDigitos;
}

/**
 * O texto traz e-mail ou número de contato (8+ dígitos)? Para RECUSAR na entrada o que não deve
 * ser guardado (memória de agente). Nome de pessoa não é detectável por padrão: fica com quem escreve.
 */
export function temContatoNoTexto(s: string): boolean {
  if (new RegExp(EMAIL.source, "i").test(s)) return true;
  return (s.match(SEQUENCIA_DE_DIGITOS) ?? []).some(ehContatoNumerico);
}

export interface Corte { listasCortadas: number; chavesOmitidas: number }

function limparEm(v: unknown, maxLista: number, corte: Corte, prof: number, emPessoa: boolean): unknown {
  if (v == null || typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "string") return mascararTexto(v);
  if (prof >= MAX_PROFUNDIDADE) return "[omitido: profundo demais]";
  if (Array.isArray(v)) {
    if (v.length > maxLista) corte.listasCortadas++;
    // Lista na raiz é tratada como lista de pessoas (na dúvida, omitir).
    const itens = v.slice(0, maxLista).map((x) => limparEm(x, maxLista, corte, prof + 1, emPessoa || prof === 0));
    return v.length > maxLista ? [...itens, `[+${v.length - maxLista} itens omitidos pelo orçamento]`] : itens;
  }
  if (typeof v === "object") {
    const saida: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const chave = normalizarChave(k);
      const nomeDePessoa = CHAVES_DE_NOME.test(chave) && (emPessoa || prof === 0);
      if (CHAVES_DE_CONTATO.test(chave) || nomeDePessoa) { saida[k] = "[omitido]"; corte.chavesOmitidas++; continue; }
      const listaDePessoas = Array.isArray(x) && !LISTAS_SEM_PESSOA.test(chave);
      saida[k] = limparEm(x, maxLista, corte, prof + 1, emPessoa || CHAVES_DE_PESSOA.test(chave) || listaDePessoas);
    }
    return saida;
  }
  return "[omitido]";
}

export function limpar(v: unknown, maxLista: number, corte: Corte = { listasCortadas: 0, chavesOmitidas: 0 }): unknown {
  return limparEm(v, maxLista, corte, 0, false);
}

/**
 * Tira o dado do envelope do MCP. O gateway guarda { structured?, content: [{type:"text", text}] },
 * e o Motor manda o JSON dentro do texto. Prefere structuredContent; senão, o texto parseado;
 * texto que não é JSON fica como texto (e é mascarado como texto).
 */
export function abrirEnvelope(resultado: unknown): unknown {
  const r = resultado as { structured?: unknown; content?: { type?: string; text?: string }[] } | null;
  if (r && typeof r === "object" && r.structured !== undefined) return r.structured;
  if (!r || !Array.isArray(r.content)) return resultado;
  const partes = r.content.filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => {
    try { return JSON.parse(c.text!); } catch { return c.text; }
  });
  return partes.length === 1 ? partes[0] : partes;
}

/** Até quantos itens por lista um resultado de ferramenta guarda e devolve ao modelo. */
export const MAX_LISTA_RESULTADO = 50;

/** O resultado de ferramenta como pode ser gravado ou devolvido ao modelo: aberto e limpo. */
export function limparResultadoDeFerramenta(resultado: unknown, maxLista = MAX_LISTA_RESULTADO): unknown {
  return limpar(abrirEnvelope(resultado), maxLista);
}
