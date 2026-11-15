// SPDX-License-Identifier: AGPL-3.0-only
// Offline-only payment proposal parser. NO network, wallet, signing, settlement or spending.
export type PaymentProposal =
  | { status: "not_required" }
  | { status: "unsupported"; reason: string }
  | { status: "review_required"; challenge: string; amount: string; asset: string; network: string };

export function inspectPaymentRequired(status: number, headers: Record<string, string>): PaymentProposal {
  if (status !== 402) return { status: "not_required" };
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === "payment-required");
  if (!entry || entry[1].length > 8192) return { status: "unsupported", reason: "missing_or_oversized_challenge" };
  let challenge: unknown;
  try { challenge = JSON.parse(Buffer.from(entry[1], "base64").toString("utf8")); }
  catch { return { status: "unsupported", reason: "invalid_challenge" }; }
  if (!challenge || typeof challenge !== "object" || Array.isArray(challenge)) return { status: "unsupported", reason: "invalid_shape" };
  const data = challenge as Record<string, unknown>;
  if (!Array.isArray(data.accepts) || data.accepts.length !== 1) return { status: "unsupported", reason: "ambiguous_payment_options" };
  const option = data.accepts[0] as Record<string, unknown>;
  if (!option || typeof option !== "object" || typeof option.amount !== "string" ||
      !/^[1-9][0-9]{0,29}$/.test(option.amount) ||
      typeof option.asset !== "string" || !/^[a-zA-Z0-9:._-]{1,128}$/.test(option.asset) ||
      typeof option.network !== "string" || !/^[a-zA-Z0-9:._-]{1,128}$/.test(option.network))
    return { status: "unsupported", reason: "unrecognized_payment_terms" };
  return { status: "review_required", challenge: entry[1], amount: option.amount, asset: option.asset, network: option.network };
}
