// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Um autenticador WebAuthn de software, SÓ PARA TESTE: gera uma passkey ES256 e responde aos
// desafios como um aparelho faria (attestation "none", presença e verificação do usuário). Permite
// testar o fluxo inteiro sem navegador. No teste de ponta a ponta, quem faz esse papel é o
// autenticador virtual do Chromium.

import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest();

// CBOR mínimo: inteiros, texto, bytes, mapas.
function cborHead(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
  throw new Error("cbor: grande demais para o teste");
}
type Cbor = number | string | Uint8Array | Map<Cbor, Cbor>;
function cbor(v: Cbor): Buffer {
  if (typeof v === "number") return v >= 0 ? cborHead(0, v) : cborHead(1, -1 - v);
  if (typeof v === "string") {
    const b = Buffer.from(v, "utf8");
    return Buffer.concat([cborHead(3, b.length), b]);
  }
  if (v instanceof Uint8Array) return Buffer.concat([cborHead(2, v.length), Buffer.from(v)]);
  const partes: Buffer[] = [cborHead(5, v.size)];
  for (const [k, x] of v) partes.push(cbor(k), cbor(x));
  return Buffer.concat(partes);
}

export interface OpcoesDeCadastro {
  challenge: string;
  rp: { id?: string };
}
export interface OpcoesDeEntrada {
  challenge: string;
  rpId?: string;
}

export class AutenticadorDeTeste {
  readonly credentialId = randomBytes(16);
  private readonly privada: KeyObject;
  private readonly publica: KeyObject;
  contador = 0;

  constructor(
    private readonly origin: string,
    private readonly rpId: string,
    /** Contador fixo em 0 simula autenticador sem contador (comum em passkey sincronizada). */
    private readonly usaContador = true,
  ) {
    const k = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privada = k.privateKey;
    this.publica = k.publicKey;
  }

  get id() {
    return b64u(this.credentialId);
  }

  private chaveCose(): Buffer {
    const jwk = this.publica.export({ format: "jwk" }) as { x: string; y: string };
    return cbor(
      new Map<Cbor, Cbor>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, Buffer.from(jwk.x, "base64url")],
        [-3, Buffer.from(jwk.y, "base64url")],
      ]),
    );
  }

  private dadosDoAutenticador(comCredencial: boolean, flagsExtra = 0): Buffer {
    const up = 0x01;
    const uv = 0x04;
    const at = comCredencial ? 0x40 : 0;
    const contador = Buffer.alloc(4);
    contador.writeUInt32BE(this.contador);
    const partes: Buffer[] = [sha256(this.rpId), Buffer.from([up | uv | at | flagsExtra]), contador];
    if (comCredencial) {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(this.credentialId.length);
      partes.push(Buffer.alloc(16), len, this.credentialId, this.chaveCose());
    }
    return Buffer.concat(partes);
  }

  private clientData(tipo: "webauthn.create" | "webauthn.get", challenge: string, origin = this.origin) {
    return Buffer.from(JSON.stringify({ type: tipo, challenge, origin, crossOrigin: false }), "utf8");
  }

  /** Resposta a navigator.credentials.create() no formato JSON que o servidor recebe. */
  cadastrar(o: OpcoesDeCadastro) {
    const clientDataJSON = this.clientData("webauthn.create", o.challenge);
    const authData = this.dadosDoAutenticador(true);
    const attestationObject = cbor(new Map<Cbor, Cbor>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports: ["internal"] },
      clientExtensionResults: {},
    };
  }

  /**
   * Resposta a navigator.credentials.get(). `origin` diferente simula página falsa (phishing);
   * `contador` fixa o valor enviado (repetir um já usado simula passkey copiada).
   */
  entrar(o: OpcoesDeEntrada, opts: { origin?: string; contador?: number } = {}) {
    if (opts.contador !== undefined) this.contador = opts.contador;
    else if (this.usaContador) this.contador++;
    const clientDataJSON = this.clientData("webauthn.get", o.challenge, opts.origin);
    const authData = this.dadosDoAutenticador(false);
    const assinatura = sign("sha256", Buffer.concat([authData, sha256(clientDataJSON)]), this.privada);
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData), signature: b64u(assinatura), userHandle: undefined },
      clientExtensionResults: {},
    };
  }
}
