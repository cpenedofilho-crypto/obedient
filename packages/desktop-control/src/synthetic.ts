// SPDX-License-Identifier: AGPL-3.0-only
// Adaptador sintético: nunca acessa sistema operacional, rede ou arquivos reais.
import { createHash, randomUUID } from "node:crypto";
import { classifyDesktopAction, validateDesktopProposal, type DesktopDevice, type DesktopObservation, type DesktopOperation, type DesktopProposal } from "./index.ts";

export interface SyntheticSession { id: string; tenantId: string; deviceId: string; expiresAt: number; steps: number; }
export type SyntheticAction = { operation: DesktopOperation; target?: string; value?: string };
export interface SyntheticApproval { proposalId: string; sessionId: string; screenHash: string; summary: string; }
export type Approve = (request: SyntheticApproval) => Promise<boolean>;

const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const fail = (reason: string): never => { throw new Error(reason); };
export class SyntheticDesktop {
  private readonly devices = new Map<string, DesktopDevice>();
  private readonly sessions = new Map<string, SyntheticSession>();
  private readonly observations = new Map<string, DesktopObservation>();
  private readonly proposals = new Map<string, { proposal: DesktopProposal; action: SyntheticAction }>();
  private readonly consumed = new Set<string>();
  private readonly screens = new Map<string, { app: string; text: string; version: number }>();
  constructor(private readonly now: () => number = Date.now) {}
  register(device: DesktopDevice): void {
    if (device.environment !== "isolated" || !device.active) fail("device_not_isolated");
    if (this.devices.has(device.id)) fail("duplicate_device");
    this.devices.set(device.id, { ...device, allowedApps: [...device.allowedApps] });
  }
  start(tenantId: string, deviceId: string, minutes = 10): SyntheticSession {
    const device = this.devices.get(deviceId);
    if (!device || device.tenantId !== tenantId || !device.active) return fail("device_unavailable");
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 30) return fail("invalid_duration");
    for (const session of this.sessions.values()) {
      if (session.deviceId === deviceId && session.expiresAt > this.now()) return fail("device_busy");
    }
    const session = { id: randomUUID(), tenantId, deviceId, expiresAt: this.now() + minutes * 60_000, steps: 0 };
    this.sessions.set(session.id, session);
    this.screens.set(session.id, { app: "launcher", text: "", version: 0 });
    return { ...session };
  }
  private session(tenantId: string, sessionId: string): SyntheticSession {
    const s = this.sessions.get(sessionId);
    if (!s || s.tenantId !== tenantId) return fail("session_not_found");
    if (s.expiresAt <= this.now()) { this.stop(tenantId, sessionId); return fail("session_expired"); }
    if (s.steps >= 40) return fail("step_limit");
    return s;
  }
  observe(tenantId: string, sessionId: string): DesktopObservation {
    this.session(tenantId, sessionId);
    const screen = this.screens.get(sessionId)!;
    const observation: DesktopObservation = {
      id: randomUUID(), sessionId, capturedAt: this.now(), screenHash: hash(screen),
      elements: screen.app === "launcher" ? [] : [{ id: "e1", role: "textbox", label: "Título fictício" }],
    };
    this.observations.set(sessionId, observation);
    return { ...observation, elements: [...observation.elements] };
  }
  propose(tenantId: string, sessionId: string, observationId: string, action: SyntheticAction): DesktopProposal {
    const s = this.session(tenantId, sessionId);
    const obs = this.observations.get(sessionId);
    if (!obs || obs.id !== observationId) return fail("stale_observation");
    if (action.operation === "app.launch" && (!action.target || !this.devices.get(s.deviceId)!.allowedApps.includes(action.target))) return fail("app_not_allowed");
    if ((action.operation === "element.click" || action.operation === "element.type") && !obs.elements.some(e => e.id === action.target)) return fail("target_not_observed");
    if (action.operation === "element.type" && (!action.value || action.value.length > 500)) return fail("invalid_text");
    if (action.operation === "file.export" && action.target !== "synthetic.pdf") return fail("export_not_allowed");
    const proposal: DesktopProposal = {
      id: randomUUID(), sessionId, observationId, screenHash: obs.screenHash,
      operation: action.operation, target: action.target, risk: classifyDesktopAction(action.operation),
      summary: `${action.operation}: ${action.target ?? "synthetic"}`, expiresAt: this.now() + 60_000,
    };
    this.proposals.set(proposal.id, { proposal, action: { ...action } });
    return { ...proposal };
  }
  async execute(tenantId: string, proposalId: string, approve: Approve): Promise<{ status: "synthetic_only"; artifact?: { name: string; sha256: string } }> {
    const record = this.proposals.get(proposalId);
    if (!record || this.consumed.has(proposalId)) return fail("proposal_unavailable");
    const { proposal, action } = record;
    this.session(tenantId, proposal.sessionId);
    // Reserve before awaiting approval to prevent concurrent double execution.
    this.consumed.add(proposalId);
    const approved = await approve({ proposalId, sessionId: proposal.sessionId, screenHash: proposal.screenHash, summary: proposal.summary });
    if (!approved) return fail("approval_required");
    const s = this.session(tenantId, proposal.sessionId);
    const obs = this.observations.get(proposal.sessionId);
    if (!obs) return fail("observation_missing");
    const screen = this.screens.get(proposal.sessionId)!;
    if (validateDesktopProposal(proposal, obs, this.now()) !== "ok" || hash(screen) !== proposal.screenHash) return fail("screen_changed");
    if (action.operation === "app.launch" && !this.devices.get(s.deviceId)!.allowedApps.includes(action.target!)) return fail("app_not_allowed");
    screen.version++;
    if (action.operation === "app.launch") screen.app = action.target!;
    if (action.operation === "element.type") screen.text = action.value!;
    s.steps++;
    this.observations.delete(proposal.sessionId);
    if (action.operation === "file.export") return { status: "synthetic_only", artifact: { name: "synthetic.pdf", sha256: hash({ app: screen.app, text: screen.text }) } };
    return { status: "synthetic_only" };
  }
  stop(tenantId: string, sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s || s.tenantId !== tenantId) return;
    this.sessions.delete(sessionId);
    this.screens.delete(sessionId);
    this.observations.delete(sessionId);
    for (const [id, record] of this.proposals) if (record.proposal.sessionId === sessionId) this.proposals.delete(id);
  }
}
