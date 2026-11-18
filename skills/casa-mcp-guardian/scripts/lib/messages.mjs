// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
// @ts-check
//
// Finding titles, in English and Brazilian Portuguese. A finding carries a code and data (names,
// counts, signal codes); the sentence comes from here, never from the audited files.

/** @type {Record<string, { en: string, pt: string, fix_en: string, fix_pt: string }>} */
export const MESSAGES = {
  FILE_UNREADABLE: { en: "File could not be read", pt: "Arquivo não pôde ser lido", fix_en: "Check the path and permissions.", fix_pt: "Confira o caminho e as permissões." },
  FILE_TOO_LARGE: { en: "File larger than the 2 MB limit; skipped", pt: "Arquivo maior que o limite de 2 MB; ignorado", fix_en: "Audit a smaller export.", fix_pt: "Audite uma exportação menor." },
  FILE_NOT_JSON: { en: "File is not valid JSON (comments and trailing commas are accepted)", pt: "Arquivo não é JSON válido (comentário e vírgula final são aceitos)", fix_en: "Fix the syntax.", fix_pt: "Corrija a sintaxe." },
  IMPLICIT_PATH_OUTSIDE_PROJECT: { en: "Default config path leads outside the project (symlink); not read", pt: "Caminho padrão de configuração sai do projeto (link simbólico); não foi lido", fix_en: "It may be a personal or global config. If the user agrees, audit it with --config.", fix_pt: "Pode ser configuração pessoal ou global. Se a pessoa concordar, audite com --config." },
  NO_SERVERS: { en: "No MCP servers found in this file", pt: "Nenhum servidor MCP neste arquivo", fix_en: "Expected a `mcpServers` or `servers` object.", fix_pt: "Esperado um objeto `mcpServers` ou `servers`." },
  SERVER_UNRECOGNIZED: { en: "Server entry has neither `url` nor `command`", pt: "Servidor sem `url` nem `command`", fix_en: "Check the entry.", fix_pt: "Confira a entrada." },
  URL_INVALID: { en: "Server URL does not parse", pt: "URL do servidor não é válida", fix_en: "Fix the URL.", fix_pt: "Corrija a URL." },
  URL_CREDENTIALS: { en: "Credentials embedded in the URL", pt: "Credencial dentro da URL", fix_en: "Move them to an environment variable or the client's secret store. Rotate them unless the file never left this machine (never committed, synced, backed up or shared); when in doubt, rotate.", fix_pt: "Leve para variável de ambiente ou cofre do cliente. Troque a credencial, a menos que o arquivo nunca tenha saído desta máquina (nunca commitado, sincronizado, copiado em backup ou compartilhado); na dúvida, troque." },
  URL_SECRET_PATH: { en: "URL path looks like it carries a token (webhook-style)", pt: "Caminho da URL parece levar um token (estilo webhook)", fix_en: "Move the URL to an environment variable or the client's secret store. Rotate the token unless the file never left this machine (never committed, synced, backed up or shared); when in doubt, rotate. It may also be a long resource id: confirm.", fix_pt: "Leve a URL para variável de ambiente ou cofre do cliente. Troque o token, a menos que o arquivo nunca tenha saído desta máquina (nunca commitado, sincronizado, copiado em backup ou compartilhado); na dúvida, troque. Também pode ser um id longo de recurso: confirme." },
  URL_SECRET_PARAM: { en: "Query parameter that looks like a credential", pt: "Parâmetro de URL com cara de credencial", fix_en: "Send it in a header that reads from an environment variable. Rotate it unless the file never left this machine (never committed, synced, backed up or shared); when in doubt, rotate.", fix_pt: "Mande num cabeçalho lido de variável de ambiente. Troque a credencial, a menos que o arquivo nunca tenha saído desta máquina (nunca commitado, sincronizado, copiado em backup ou compartilhado); na dúvida, troque." },
  URL_PROTOCOL: { en: "Unexpected URL protocol", pt: "Protocolo de URL inesperado", fix_en: "Use https.", fix_pt: "Use https." },
  URL_METADATA_HOST: { en: "Link-local address (cloud metadata lives here)", pt: "Endereço link-local (onde fica o metadata da nuvem)", fix_en: "Never point an MCP client at it.", fix_pt: "Nunca aponte um cliente MCP para ele." },
  URL_PRIVATE_HOST: { en: "Private or reserved network address", pt: "Endereço de rede privada ou reservada", fix_en: "Confirm the server is yours and intended.", fix_pt: "Confirme que o servidor é seu e é esse mesmo." },
  URL_LOOPBACK: { en: "Local server", pt: "Servidor local", fix_en: "Fine for development.", fix_pt: "Normal em desenvolvimento." },
  URL_PLAINTEXT: { en: "No TLS to a non-local host", pt: "Sem TLS para host que não é local", fix_en: "Use https.", fix_pt: "Use https." },
  LITERAL_SECRET: { en: "Literal credential in the config (value not shown)", pt: "Credencial escrita no arquivo (valor não mostrado)", fix_en: "Reference an environment variable instead (e.g. ${API_KEY}). Rotate the credential unless the file never left this machine (never committed, synced, backed up or shared); when in doubt, rotate.", fix_pt: "Use referência a variável de ambiente (ex.: ${API_KEY}). Troque a credencial, a menos que o arquivo nunca tenha saído desta máquina (nunca commitado, sincronizado, copiado em backup ou compartilhado); na dúvida, troque." },
  UNPINNED_PACKAGE: { en: "Package run without a pinned version", pt: "Pacote executado sem versão fixa", fix_en: "Pin an exact version (pkg@1.2.3); a new release runs with your permissions.", fix_pt: "Fixe a versão (pkg@1.2.3): uma versão nova roda com as suas permissões." },
  UNPINNED_IMAGE: { en: "Container image not pinned by digest", pt: "Imagem de contêiner sem digest fixo", fix_en: "Use image@sha256:…", fix_pt: "Use imagem@sha256:…" },
  SHELL_WRAPPER: { en: "Server started through a shell command line", pt: "Servidor iniciado por linha de comando de shell", fix_en: "Call the binary directly with explicit arguments.", fix_pt: "Chame o binário direto, com argumentos explícitos." },
  PIPE_TO_SHELL: { en: "Downloads and pipes into a shell", pt: "Baixa e executa direto no shell", fix_en: "Install a pinned, verified release instead.", fix_pt: "Instale uma versão fixa e verificada." },
  AUTO_APPROVE: { en: "Tools approved without asking", pt: "Ferramentas aprovadas sem perguntar", fix_en: "Keep auto-approval to read-only tools you have reviewed.", fix_pt: "Deixe aprovação automática só para leitura revisada." },
  AUTO_APPROVE_ALL: { en: "Every tool of this server approved without asking", pt: "Todas as ferramentas do servidor aprovadas sem perguntar", fix_en: "Remove the wildcard.", fix_pt: "Tire o curinga." },
  ENABLE_ALL_PROJECT_SERVERS: { en: "Every server in the project's .mcp.json is enabled without review", pt: "Todo servidor do .mcp.json do projeto é ligado sem revisão", fix_en: "Approve servers one by one.", fix_pt: "Aprove servidor por servidor." },
  TOOLS_LISTING_INCOMPLETE: { en: "The listing is incomplete: it has more pages (nextCursor)", pt: "A listagem está incompleta: tem mais páginas (nextCursor)", fix_en: "Fetch every page of tools/list and save all the tools in one listing without nextCursor. Until then the audit and any comparison cover only this page, and --emit-pins refuses it.", fix_pt: "Busque todas as páginas de tools/list e salve todas as ferramentas numa única listagem, sem nextCursor. Até lá a auditoria e a comparação cobrem só esta página, e o --emit-pins recusa a listagem." },
  TOOLS_FILE_EMPTY: { en: "No tools found in this listing", pt: "Nenhuma ferramenta nesta listagem", fix_en: "Expected a `tools/list` result.", fix_pt: "Esperado o resultado de `tools/list`." },
  TOOL_INJECTION_SIGNAL: { en: "Tool description contains instruction-like text (treat as hostile)", pt: "Descrição da ferramenta tem texto com cara de instrução (trate como hostil)", fix_en: "Do not enable the tool until a person reads the description.", fix_pt: "Não ligue a ferramenta antes de uma pessoa ler a descrição." },
  TOOL_SUSPICIOUS_TEXT: { en: "Tool description has unusual content", pt: "Descrição da ferramenta tem conteúdo incomum", fix_en: "Read it before enabling.", fix_pt: "Leia antes de ligar." },
  TOOL_NAME_HIDDEN: { en: "Tool name contains hidden or control characters", pt: "Nome da ferramenta tem caractere escondido ou de controle", fix_en: "Do not enable it.", fix_pt: "Não ligue." },
  TOOL_HINT_CONTRADICTS: { en: "readOnlyHint contradicts what the name does", pt: "readOnlyHint contradiz o que o nome faz", fix_en: "Trust the name; ask the server owner to fix the annotation.", fix_pt: "Confie no nome; peça ao dono do servidor para corrigir a anotação." },
  TOOL_NO_OBJECT_SCHEMA: { en: "Tool has no object input schema", pt: "Ferramenta sem esquema de entrada de objeto", fix_en: "A well-behaved client should not offer it.", fix_pt: "Um cliente correto não deveria oferecê-la." },
  TOOL_DUPLICATE_NAME: { en: "The same tool of the same server appears more than once (in one listing or across listings)", pt: "A mesma ferramenta do mesmo servidor aparece mais de uma vez (numa listagem ou entre listagens)", fix_en: "Do not enable the server until it lists each tool once: a client may call either copy, and pins cannot tell them apart.", fix_pt: "Não ative o servidor até ele listar cada ferramenta uma vez só: o cliente pode chamar qualquer das cópias, e a fixação não distingue as duas." },
  TOOL_SCHEMA_TOO_DEEP: { en: "Tool definition nested too deeply to inspect or pin", pt: "Definição da ferramenta aninhada demais para inspecionar ou fixar", fix_en: "Treat the server as hostile or broken: no real schema nests this deep. Do not enable the tool.", fix_pt: "Trate o servidor como hostil ou quebrado: nenhum esquema real aninha tanto. Não ative a ferramenta." },
  TOOL_ENTRY_INVALID: { en: "Listing entries that are not tool objects", pt: "Entradas da listagem que não são objetos de ferramenta", fix_en: "Get a clean tools/list result: those entries were not audited, and --emit-pins refuses the listing.", fix_pt: "Obtenha um resultado de tools/list limpo: essas entradas não foram auditadas, e --emit-pins recusa a listagem." },
  TOOL_NAME_COLLISION: { en: "Same tool name in more than one server (shadowing risk)", pt: "Mesmo nome de ferramenta em mais de um servidor (risco de sombra)", fix_en: "Prefix or disable one of them.", fix_pt: "Prefixe ou desligue uma delas." },
  TOOL_CHANGED: { en: "Tool changed since it was pinned (name, description, schema or annotations)", pt: "Ferramenta mudou desde a fixação (nome, descrição, esquema ou anotações)", fix_en: "Review the change before using it again.", fix_pt: "Revise a mudança antes de usar de novo." },
  TOOL_NEW: { en: "Tool not in the pin file", pt: "Ferramenta fora do arquivo de fixação", fix_en: "Review it and add it to the pins.", fix_pt: "Revise e inclua na fixação." },
  TOOL_REMOVED: { en: "Pinned tool no longer advertised", pt: "Ferramenta fixada não aparece mais", fix_en: "Confirm it was intentional.", fix_pt: "Confirme que foi intencional." },
  PINS_INVALID: { en: "Pin file is not in the expected format", pt: "Arquivo de fixação fora do formato", fix_en: "Regenerate it with --emit-pins.", fix_pt: "Gere de novo com --emit-pins." },
};

/** @param {string} code @param {"en" | "pt"} lang */
export function title(code, lang) {
  const m = MESSAGES[code];
  return m ? m[lang] : code;
}
/** @param {string} code @param {"en" | "pt"} lang */
export function fix(code, lang) {
  const m = MESSAGES[code];
  return m ? (lang === "pt" ? m.fix_pt : m.fix_en) : "";
}
