#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Cláudio Penedo.
#
# Teste de restauração (A4): abre o backup, restaura num banco NOVO de um Postgres ISOLADO e confere
# que as linhas por tabela batem com a contagem do backup e que as migrations estão em dia (o mesmo que
# o /ready confere). Nunca aponte para a produção: o script cria e apaga bancos.
#
#   OBEDIENT_RESTAURO_URL=postgresql://admin@host-isolado/postgres \
#   OBEDIENT_BACKUP_SENHA=... OBEDIENT_RESTAURO_ISOLADO=sim \
#   scripts/backup/restaurar-teste.sh <pasta>/obedient-<data>.dump.enc [--manter]
#
# OBEDIENT_RESTAURO_URL: administrador do Postgres isolado, no banco "postgres".
# --manter: não apaga o banco restaurado no fim (para abrir o servidor contra ele e testar uma missão).
set -euo pipefail
umask 077
arq="${1:?uso: restaurar-teste.sh <arquivo.dump.enc> [--manter]}"
manter="${2:-}"
: "${OBEDIENT_RESTAURO_URL:?defina OBEDIENT_RESTAURO_URL (Postgres ISOLADO)}"
: "${OBEDIENT_BACKUP_SENHA:?defina OBEDIENT_BACKUP_SENHA}"
[ "${OBEDIENT_RESTAURO_ISOLADO:-}" = "sim" ] || { echo "confirme que o Postgres é isolado: OBEDIENT_RESTAURO_ISOLADO=sim" >&2; exit 1; }
if [ -n "${OBEDIENT_DATABASE_URL:-}" ] && [ "${OBEDIENT_DATABASE_URL%%\?*}" = "${OBEDIENT_RESTAURO_URL%%\?*}" ]; then
  echo "OBEDIENT_RESTAURO_URL é a mesma do servidor: recusado" >&2; exit 1
fi
raiz="$(cd "$(dirname "$0")/../.." && pwd)"
base="${arq%.dump.enc}"
( cd "$(dirname "$arq")" && sha256sum --check --quiet "$(basename "$base").sha256" ) || { echo "hash não confere: arquivo corrompido ou trocado" >&2; exit 1; }

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass env:OBEDIENT_BACKUP_SENHA -in "$arq" -out "$tmp/dump" \
  || { echo "não abriu: senha errada ou arquivo corrompido" >&2; exit 1; }

sufixo="$(date -u +%Y%m%d%H%M%S)"
alvo="obedient_restauro_$sufixo"
papeis="obedient_papeis_$sufixo"
url_de() { local u="$OBEDIENT_RESTAURO_URL"; local s="${u%%\?*}"; local q=""; [ "$u" != "$s" ] && q="?${u#*\?}"; echo "${s%/*}/$1$q"; }

# Os papéis (obedient_app, _operator, _scheduler…) são do cluster, não do banco: as migrations os criam
# num banco descartável, para que as permissões e os donos do backup voltem iguais.
psql "$OBEDIENT_RESTAURO_URL" -v ON_ERROR_STOP=1 -qc "create database $papeis" -c "create database $alvo"
OBEDIENT_OWNER_DATABASE_URL="$(url_de "$papeis")" node --import tsx "$raiz/packages/server/src/cli.ts" migrar > /dev/null
psql "$OBEDIENT_RESTAURO_URL" -qc "drop database $papeis"

# Sem --no-owner: as funções SECURITY DEFINER têm de voltar com o dono delas (papel restrito), nunca
# como do administrador. Se o dono da produção não existir aqui, o restauro para com erro.
pg_restore --exit-on-error --single-transaction --dbname="$(url_de "$alvo")" "$tmp/dump"

if node --import tsx "$raiz/scripts/backup/contar.ts" "$(url_de "$alvo")" "$base.contagem.json"; then ok=1; else ok=0; fi
if [ "$manter" = "--manter" ]; then echo "banco restaurado mantido: $alvo"; else psql "$OBEDIENT_RESTAURO_URL" -qc "drop database $alvo"; fi
[ "$ok" = 1 ]
