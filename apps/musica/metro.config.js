// SPDX-License-Identifier: AGPL-3.0-only
// Metro do app de música (D31, F3). Duas coisas fora do padrão do Expo:
// 1. Os pacotes @obedient/* vêm do próprio monorepo, em TypeScript (packages/*/src/index.ts), sem build.
// 2. node:crypto não existe no React Native. Os pacotes do núcleo importam hash e UUID no topo do módulo
//    (mesmo onde o app não usa), então o import é trocado pelo shim deste app (shims/node-crypto.ts).
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const app = __dirname;
const raiz = path.resolve(app, "../..");
const config = getDefaultConfig(app);

config.watchFolders = [path.join(raiz, "packages")];
config.resolver.nodeModulesPaths = [path.join(app, "node_modules")];

const padrao = config.resolver.resolveRequest;
config.resolver.resolveRequest = (contexto, nome, plataforma) => {
  if (nome === "node:crypto" || nome === "crypto") {
    return { type: "sourceFile", filePath: path.join(app, "shims/node-crypto.ts") };
  }
  const pacote = /^@obedient\/([a-z0-9-]+)$/.exec(nome);
  if (pacote) {
    return { type: "sourceFile", filePath: path.join(raiz, "packages", pacote[1], "src/index.ts") };
  }
  return (padrao ?? contexto.resolveRequest)(contexto, nome, plataforma);
};

module.exports = config;
