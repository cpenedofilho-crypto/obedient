// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
// @ts-check
//
// O lado do aparelho da passkey: converte as opções JSON do servidor para o que o navegador pede
// (ArrayBuffer) e a resposta do navegador de volta para JSON. A chave privada nunca sai do aparelho.

/** @param {string} s */
const deB64u = (s) => {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0)).buffer;
};
/** @param {ArrayBuffer | null | undefined} b */
const paraB64u = (b) => (b ? btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : undefined);

export const temPasskey = () => typeof window !== "undefined" && !!window.PublicKeyCredential && !!navigator.credentials;

/** Cadastrar a passkey (convite). @param {any} o opções do servidor */
export async function criar(o) {
  /** @type {PublicKeyCredentialCreationOptions} */
  const publicKey = {
    ...o,
    challenge: deB64u(o.challenge),
    user: { ...o.user, id: deB64u(o.user.id) },
    excludeCredentials: (o.excludeCredentials ?? []).map((/** @type {any} */ c) => ({ ...c, id: deB64u(c.id) })),
  };
  const c = /** @type {PublicKeyCredential | null} */ (await navigator.credentials.create({ publicKey }));
  if (!c) throw new Error("cadastro cancelado");
  const r = /** @type {AuthenticatorAttestationResponse} */ (c.response);
  return {
    id: c.id,
    rawId: paraB64u(c.rawId),
    type: c.type,
    response: {
      clientDataJSON: paraB64u(r.clientDataJSON),
      attestationObject: paraB64u(r.attestationObject),
      transports: typeof r.getTransports === "function" ? r.getTransports() : [],
    },
    clientExtensionResults: c.getClientExtensionResults(),
  };
}

/** Entrar ou reautenticar. @param {any} o opções do servidor */
export async function usar(o) {
  /** @type {PublicKeyCredentialRequestOptions} */
  const publicKey = {
    ...o,
    challenge: deB64u(o.challenge),
    allowCredentials: (o.allowCredentials ?? []).map((/** @type {any} */ c) => ({ ...c, id: deB64u(c.id) })),
  };
  const c = /** @type {PublicKeyCredential | null} */ (await navigator.credentials.get({ publicKey }));
  if (!c) throw new Error("entrada cancelada");
  const r = /** @type {AuthenticatorAssertionResponse} */ (c.response);
  return {
    id: c.id,
    rawId: paraB64u(c.rawId),
    type: c.type,
    response: {
      clientDataJSON: paraB64u(r.clientDataJSON),
      authenticatorData: paraB64u(r.authenticatorData),
      signature: paraB64u(r.signature),
      userHandle: paraB64u(r.userHandle),
    },
    clientExtensionResults: c.getClientExtensionResults(),
  };
}
