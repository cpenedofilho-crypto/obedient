# OBEDIENT

**English** · [Português](README.pt-BR.md)

An open-source personal agent governed by a **verifiable Ethical Constitution**: the model
proposes, the backend decides, and the person authorizes anything sensitive.

> **Status: pre-alpha.** The legal documents in this repository (Constitution, CLA, commercial
> license, governance) are **unreviewed drafts** and may change. **We do not accept external
> contributions yet**: the CLA is under legal review (see `CONTRIBUTING.md`).
>
> The documents linked below are written in Portuguese; this README is the English entry point.

## What exists today

| Package | License | What it does |
|---|---|---|
| `@obedient/core` | AGPL-3.0-only | Types, injectable clock, canonical payload hash |
| `@obedient/policy-engine` | AGPL-3.0-only | Pure decision: `deny > strong approval > approval > allow`, with a CRITICAL floor per category |
| `@obedient/ethics-engine` | AGPL-3.0-only | Grants (Art. 3), consent (Art. 4), human approval bound to a hash and executed once (Art. 1 and 12), emergency stop (Art. 9), chained audit log (Art. 8) |
| `@obedient/integration-gateway` | AGPL-3.0-only | Risk and category of third-party MCP tools without trusting the server's hints, SSRF protection, redaction of personal data (extracted from Growth OS, decision D7) |
| `@obedient/event-bus` | AGPL-3.0-only | Event bus: vocabulary declared per system, idempotency, a net against personal data, retry with doubling backoff and dead letter (extracted from Growth OS, D7) |
| `@obedient/mission-engine` | AGPL-3.0-only | State machine for missions and tasks, layered dependency plan, autonomy levels that can only restrict, delegation by intersection (extracted from Growth OS, D7) |
| `@obedient/agent-orchestrator` | AGPL-3.0-only | The agent loop: the model proposes, every tool goes through the Ethics Engine, anything that needs a person pauses the run until approval and executes once; limits on steps, tokens, deadline, loops and invalid tools (extracted from Growth OS, D7) |
| `@obedient/modelo-anthropic` | AGPL-3.0-only | The model adapter for the agent loop, through Anthropic's Messages API with the official SDK: the response goes back to the loop unedited, transient errors become retryable, and the cost of each response is summed per model so the mission's cost cap holds |
| `@obedient/dots-adapter` | AGPL-3.0-only | DOTS as a subordinate, **read-only** agent, over MCP |
| `@obedient/store-postgres` | AGPL-3.0-only | The Ethics Engine on Postgres: row-level security forced per user, append-only audit with the chain verified by the database, single execution of each proposal and authenticated session (`docs/architecture/persistencia.md`) |
| `@obedient/memory` | AGPL-3.0-only | Personal memory with opt-in learning per subject: every lesson is visible and deletable; turning it off deletes it; training a third-party model only with separate consent (`docs/architecture/memoria-e-direitos.md`) |
| `@obedient/missions` | AGPL-3.0-only | Missions with an attempt cap, growing intervals, a cost cap and an explained blocker; "I don't know" and "I couldn't" are valid outcomes (`docs/architecture/missoes.md`) |
| `@obedient/integrations` | AGPL-3.0-only | Google connections (Calendar, Gmail, Drive): minimal scope, OAuth with PKCE, encrypted credential revoked on stop (`docs/architecture/integracoes.md`) |
| `@obedient/mobile-control` | AGPL-3.0-only | Mobile Control Engine (decision D17): the agent uses a phone through five tools, each governed by the Ethics Engine; a closed action vocabulary (no shell, app install, arbitrary URL, file upload or clipboard), screen content treated as third-party data; phase 1 is an isolated Android emulator with synthetic data only (`docs/architecture/mobile.md`) |
| `@obedient/mobile-mcp` | AGPL-3.0-only | The Mobile Control Engine as an MCP server: acting is propose-then-execute, with one execute tool per risk tier, so an MCP gateway can require the right approval for each; the proposal runs once, with the summary the person saw (`docs/architecture/mobile.md`) |
| `@obedient/server` | AGPL-3.0-only | The server and app (PWA) where the person decides: passkey sign-in, approval cards, stop, authorizations and audit trail, with an offline queue (`docs/architecture/app.md`) |
| `@obedient/sdk` | **Apache-2.0** | Protocol contract for integrators, with no dependency on the AGPL core |

What **does not exist yet** (no stubs, no empty folders): the mission executor (model and tools)
and the API through which the agent reaches the server. The order is in `docs/ROADMAP.md`, and
the extraction from Growth OS in `docs/architecture/extracao-growth-os.md`.

## Running

```bash
npm install
npm run check      # typecheck + tests (including the constitutional suite) + license allowlist
```

Node 22 or newer.

## Documents

- [`CONSTITUTION.md`](CONSTITUTION.md): principles, verifiable rules and legal obligations
- [`GOVERNANCE.md`](GOVERNANCE.md): rights holder, founder's role, maintainers, releases
- [`CONTRIBUTING.md`](CONTRIBUTING.md), [`CLA.md`](CLA.md),
  [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md), [`SECURITY.md`](SECURITY.md)
- [`COMMERCIAL-LICENSE.md`](COMMERCIAL-LICENSE.md), [`TRADEMARKS.md`](TRADEMARKS.md),
  [`NOTICE`](NOTICE)
- [`docs/architecture/ethics-engine.md`](docs/architecture/ethics-engine.md),
  [`docs/architecture/dots.md`](docs/architecture/dots.md)
- [`docs/licensing/PROVENANCE.md`](docs/licensing/PROVENANCE.md): where each file came from
- [`docs/governance/decisoes.md`](docs/governance/decisoes.md): the founder's decisions D1 to D15

## License

GNU Affero General Public License v3.0 only (`LICENSE`), except `packages/sdk` (Apache-2.0).
A commercial license, for those who cannot comply with the AGPL, is offered by Casa de IA
Educação e Consultoria Ltda (`COMMERCIAL-LICENSE.md`).

Copyright (C) 2026 Cláudio Penedo. The exclusive commercial-exploitation license to Casa de IA
Educação e Consultoria Ltda (CNPJ 69.761.208/0001-20) is being formalized; the AGPL-3.0 license
of this repository already applies to everyone.
