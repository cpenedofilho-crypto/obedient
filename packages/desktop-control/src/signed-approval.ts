// SPDX-License-Identifier: AGPL-3.0-only
// Validador de comprovante do Gateway: não assina nem gera aprovações.
import { verificarComprovante } from "@obedient/integration-gateway";
import type { Approve } from "./synthetic.ts";

export const DESKTOP_EXECUTE_TOOL = "desktop_executar_acao_alta";
export interface DesktopProof {
  proposal_id: string;
  session_id: string;
  screen_hash: string;
  resumo: string;
}
export function requireSignedApproval(input: {
  publicKey: string;
  proof: unknown;
  arguments: DesktopProof;
  now?: number;
}): Approve {
  return async ({ proposalId, sessionId, screenHash, summary }) => {
    const expected: DesktopProof = {
      proposal_id: proposalId, session_id: sessionId,
      screen_hash: screenHash, resumo: summary,
    };
    if (JSON.stringify(expected) !== JSON.stringify(input.arguments)) return false;
    return verificarComprovante({
      chavePublica: input.publicKey,
      ferramenta: DESKTOP_EXECUTE_TOOL,
      argumentos: expected,
      comprovante: input.proof,
      agora: input.now,
    }).ok;
  };
}
