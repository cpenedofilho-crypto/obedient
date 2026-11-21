#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Cláudio Penedo.
#
# Backup cifrado do banco do OBEDIENT (A4). Gera, na pasta dada:
#   obedient-<data>.dump.enc        pg_dump (formato custom) cifrado com AES-256 (openssl, PBKDF2)
#   obedient-<data>.contagem.json   linhas por tabela, para conferir a restauração (só números)
#   obedient-<data>.sha256          hash dos dois
#
#   OBEDIENT_BACKUP_URL=... OBEDIENT_BACKUP_SENHA=... scripts/backup/backup.sh <pasta>
#
# OBEDIENT_BACKUP_URL: papel que vê todas as linhas (o administrador do Postgres, ou um papel com
#   BYPASSRLS). As tabelas têm RLS forçada: com o dono do schema, o pg_dump recusa, e é melhor assim.
# OBEDIENT_BACKUP_SENHA: a senha do arquivo. Guarde LONGE do backup e longe das chaves do cofre.
# As credenciais das pessoas já estão cifradas no banco pelo cofre (OBEDIENT_CHAVES_COFRE): sem as
# chaves do cofre, o backup não abre nenhuma delas. De propósito.
set -euo pipefail
umask 077
pasta="${1:?uso: backup.sh <pasta>}"
: "${OBEDIENT_BACKUP_URL:?defina OBEDIENT_BACKUP_URL}"
: "${OBEDIENT_BACKUP_SENHA:?defina OBEDIENT_BACKUP_SENHA}"
[ "${#OBEDIENT_BACKUP_SENHA}" -ge 20 ] || { echo "OBEDIENT_BACKUP_SENHA precisa de 20 caracteres ou mais" >&2; exit 1; }
raiz="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$pasta"
nome="obedient-$(date -u +%Y%m%dT%H%M%SZ)"
dump="$pasta/$nome.dump.enc"

# Conta antes e depois do dump: se mudou no meio, a conferência da restauração acusaria. Por isso o
# dump é de uma transação só (snapshot) e a contagem sai do mesmo instante lógico o mais perto possível.
node --import tsx "$raiz/scripts/backup/contar.ts" "$OBEDIENT_BACKUP_URL" > "$pasta/$nome.contagem.json"
PGOPTIONS="-c row_security=off" pg_dump --format=custom --no-password --dbname="$OBEDIENT_BACKUP_URL" \
  | openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt -pass env:OBEDIENT_BACKUP_SENHA -out "$dump"
node --import tsx "$raiz/scripts/backup/contar.ts" "$OBEDIENT_BACKUP_URL" > "$pasta/$nome.contagem.depois.json"
if ! cmp -s "$pasta/$nome.contagem.json" "$pasta/$nome.contagem.depois.json"; then
  echo "aviso: o banco mudou durante o backup; a conferência da restauração pode acusar diferença pequena" >&2
fi
rm -f "$pasta/$nome.contagem.depois.json"
( cd "$pasta" && sha256sum "$nome.dump.enc" "$nome.contagem.json" > "$nome.sha256" )
echo "backup: $dump ($(du -h "$dump" | cut -f1))"
