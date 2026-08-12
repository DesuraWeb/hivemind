#!/usr/bin/env bash
# Repart d'une base vierge. Destructif — dev uniquement.
set -euo pipefail
cd "$(dirname "$0")/.."

read -rp "Supprimer et recréer la base 'chapo' ? [y/N] " ok
[ "$ok" = "y" ] || { echo "annulé"; exit 1; }

dropdb --if-exists chapo
createdb chapo
pnpm db:migrate
pnpm db:seed
echo "✅ Base réinitialisée."
