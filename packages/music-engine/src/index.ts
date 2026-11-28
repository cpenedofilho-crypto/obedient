// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
//
// Music Intelligence Engine (decisão D31). Núcleo sem I/O: o app do aparelho implementa as portas
// (SensorAdapter, PlayerNativo) e o resto é deste pacote. Arquitetura em docs/architecture/music-engine.md.
export * from "./sensor/parse-2a37.ts";
export * from "./sensor/simulado.ts";
export * from "./contexto/filtro-artefatos.ts";
export * from "./contexto/zonas.ts";
export * from "./contexto/engine.ts";
export * from "./preferencias/engine.ts";
export * from "./decisao/decidir.ts";
export * from "./reproducao/catalogo-proprio.ts";
export * from "./privacidade/engine.ts";
export * from "./privacidade/retencao.ts";
export * from "./eventos.ts";
export * from "./sessao.ts";
