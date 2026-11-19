// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Contrato declarativo para missões de desenvolvimento.
 * Não executa ferramentas nem concede permissões.
 */
export const OPERACOES_DESENVOLVIMENTO = [
  "repo.read", "branch.create", "file.write", "tests.run",
  "pull_request.create", "deployment.preview", "deployment.promote",
  "database.migrate",
] as const;
export type OperacaoDesenvolvimento = typeof OPERACOES_DESENVOLVIMENTO[number];
export type Ambiente = "sandbox" | "homologacao" | "producao";
export interface EscopoDesenvolvimento {
  readonly repositorio: string;
  readonly ambiente: Ambiente;
  readonly operacoes: readonly OperacaoDesenvolvimento[];
  readonly expiraEm: string;
  readonly limiteCustoCentavos: number;
}
export interface PedidoDesenvolvimento {
  readonly missaoId: string;
  readonly operacao: OperacaoDesenvolvimento;
  readonly repositorio: string;
  readonly ambiente: Ambiente;
  readonly chaveIdempotencia: string;
}
export type ResultadoValidacao = { permitido: true } | { permitido: false; motivo: string };
const REPOSITORIO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const CHAVE = /^[A-Za-z0-9:_-]{8,160}$/;
/**
 * Pré-validação de escopo. Uma decisão positiva NÃO autoriza executar:
 * toda ação ainda precisa passar pelo Ethics Engine e pelo grant vigente.
 */
export function validarPedido(
  escopo: EscopoDesenvolvimento,
  pedido: PedidoDesenvolvimento,
  agora: Date,
): ResultadoValidacao {
  if (!REPOSITORIO.test(escopo.repositorio) || !REPOSITORIO.test(pedido.repositorio))
    return { permitido: false, motivo: "repositorio_invalido" };
  if (escopo.repositorio !== pedido.repositorio)
    return { permitido: false, motivo: "repositorio_fora_do_escopo" };
  if (escopo.ambiente !== pedido.ambiente)
    return { permitido: false, motivo: "ambiente_fora_do_escopo" };
  if (!OPERACOES_DESENVOLVIMENTO.includes(pedido.operacao))
    return { permitido: false, motivo: "operacao_desconhecida" };
  if (!escopo.operacoes.includes(pedido.operacao))
    return { permitido: false, motivo: "operacao_nao_delegada" };
  const expira = Date.parse(escopo.expiraEm);
  if (!Number.isFinite(expira) || expira <= agora.getTime())
    return { permitido: false, motivo: "escopo_expirado" };
  if (!Number.isSafeInteger(escopo.limiteCustoCentavos) || escopo.limiteCustoCentavos < 0)
    return { permitido: false, motivo: "limite_custo_invalido" };
  if (!CHAVE.test(pedido.chaveIdempotencia) || !CHAVE.test(pedido.missaoId))
    return { permitido: false, motivo: "identificador_invalido" };
  // Operações de alto impacto não são habilitadas por este contrato inicial.
  if (pedido.operacao === "deployment.promote" || pedido.operacao === "database.migrate")
    return { permitido: false, motivo: "operacao_critica_nao_implementada" };
  return { permitido: true };
}
