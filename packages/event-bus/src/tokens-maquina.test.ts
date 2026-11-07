// SPDX-License-Identifier: AGPL-3.0-only
// Token de máquina com prazo e audience (auditoria A2A de 06/11/2026, R7).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hashComAudiencia, hashDoToken, identificarProdutor, lerPrazo, PRAZO_MAXIMO_DIAS } from "./index.ts";

const FONTES = ["recupera-os", "motor"];
const AGORA = new Date("2026-11-07T12:00:00Z");
const TOKEN = "tok-".padEnd(48, "x");
const v2 = (aud: string, data: string, org = "escola-a", fonte = "recupera-os") => `v2:${hashComAudiencia(aud, TOKEN)}:${org}:${fonte}:${data}`;
const quem = (env: string, o: { exigirPrazo?: boolean; agora?: Date } = {}) => identificarProdutor(`Bearer ${TOKEN}`, env, FONTES, { agora: AGORA, exigirPrazo: false, ...o });

describe("prazo", () => {
  it("vale até o fim do dia UTC; vencido, data inválida ou acima do máximo é ignorado", () => {
    assert.equal(lerPrazo("2026-11-07", AGORA)?.toISOString(), "2026-11-07T23:59:59.999Z");
    assert.equal(lerPrazo("2026-11-06", AGORA), null);
    assert.equal(lerPrazo("2026-02-30", AGORA), null);
    assert.equal(lerPrazo("07/11/2027", AGORA), null);
    const max = new Date(AGORA.getTime() + (PRAZO_MAXIMO_DIAS - 1) * 86_400_000).toISOString().slice(0, 10);
    assert.ok(lerPrazo(max, AGORA));
    assert.equal(lerPrazo("2099-01-01", AGORA), null);
  });
});

describe("produtor v2", () => {
  it("token com audience event-bus e prazo em dia identifica org e fonte", () => {
    assert.deepEqual(quem(v2("event-bus", "2027-01-31")), { orgSlug: "escola-a", source: "recupera-os" });
  });

  it("vencido, sem prazo ou para sempre não entra", () => {
    assert.equal(quem(v2("event-bus", "2026-11-06")), null);
    assert.equal(quem(`v2:${hashComAudiencia("event-bus", TOKEN)}:escola-a:recupera-os`), null);
    assert.equal(quem(v2("event-bus", "2099-12-31")), null);
    // No dia seguinte ao prazo, para de valer sem ninguém mexer na variável.
    assert.ok(quem(v2("event-bus", "2026-11-30")));
    assert.equal(quem(v2("event-bus", "2026-11-30"), { agora: new Date("2026-12-01T00:00:01Z") }), null);
  });

  it("audience: hash feito para o Mission Control não abre o Event Bus; hash v2 não vale como legado e vice-versa", () => {
    assert.equal(quem(v2("mission-control", "2027-01-31")), null);
    assert.equal(quem(`v2:${hashDoToken(TOKEN)}:escola-a:recupera-os:2027-01-31`), null);
    assert.equal(quem(`${hashComAudiencia("event-bus", TOKEN)}:escola-a:recupera-os`), null);
  });

  it("formato antigo: aceito até EXIGIR_PRAZO_TOKENS ser ligado", () => {
    const antigo = `${hashDoToken(TOKEN)}:escola-a:recupera-os`;
    assert.deepEqual(quem(antigo), { orgSlug: "escola-a", source: "recupera-os" });
    assert.equal(quem(antigo, { exigirPrazo: true }), null);
    // Com o prazo obrigatório, só a entrada v2 do mesmo token vale.
    assert.deepEqual(quem(`${antigo}, ${v2("event-bus", "2027-01-31", "escola-b", "motor")}`, { exigirPrazo: true }), { orgSlug: "escola-b", source: "motor" });
  });

  it("campos ruins e fonte fora da lista seguem recusados no v2", () => {
    assert.equal(quem(v2("event-bus", "2027-01-31", "Escola A")), null);
    assert.equal(quem(v2("event-bus", "2027-01-31", "escola-a", "inventada")), null);
    assert.equal(quem(`v2:xyz:escola-a:recupera-os:2027-01-31`), null);
    assert.equal(identificarProdutor(TOKEN, v2("event-bus", "2027-01-31"), FONTES, { agora: AGORA }), null);
  });
});
