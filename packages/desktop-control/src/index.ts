// SPDX-License-Identifier: AGPL-3.0-only
// Desktop Control Engine — contratos puros, sem acesso a computadores reais.
export type DesktopRisk = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type DesktopOperation = "app.launch" | "element.click" | "element.type" | "file.export";
export interface DesktopDevice {
  id: string;
  tenantId: string;
  environment: "isolated";
  allowedApps: readonly string[];
  active: boolean;
}
export interface DesktopObservation {
  id: string;
  sessionId: string;
  screenHash: string;
  capturedAt: number;
  elements: readonly { id: string; role: string; label: string }[];
}
export interface DesktopProposal {
  id: string;
  sessionId: string;
  observationId: string;
  screenHash: string;
  operation: DesktopOperation;
  target?: string;
  risk: DesktopRisk;
  summary: string;
  expiresAt: number;
}
export function classifyDesktopAction(operation: DesktopOperation): DesktopRisk {
  switch (operation) {
    case "app.launch": return "MEDIUM";
    case "element.click": return "HIGH";
    case "element.type": return "HIGH";
    case "file.export": return "HIGH";
    default: return "CRITICAL";
  }
}
export function validateDesktopProposal(
  proposal: DesktopProposal,
  observation: DesktopObservation,
  now: number,
): "ok" | "expired" | "wrong_session" | "screen_changed" {
  if (now >= proposal.expiresAt) return "expired";
  if (proposal.sessionId !== observation.sessionId) return "wrong_session";
  if (proposal.observationId !== observation.id || proposal.screenHash !== observation.screenHash) return "screen_changed";
  return "ok";
}
