#!/usr/bin/env bash
# Bootstrap d'une machine vierge (macOS). Idempotent.
set -euo pipefail
cd "$(dirname "$0")/.."

command -v node >/dev/null || { echo "Node 22+ requis (brew install node@22)"; exit 1; }
command -v psql >/dev/null || { echo "PostgreSQL 16 requis (brew install postgresql@16)"; exit 1; }

corepack enable pnpm
pnpm install

if [ ! -f .env ]; then
  cp .env.example .env
  # Génère des clés réelles pour que le premier démarrage fonctionne.
  MASTER=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
  SESSION=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
  # BSD sed (macOS) exige un argument après -i.
  sed -i '' "s|^MASTER_KEY=.*|MASTER_KEY=${MASTER}|" .env
  sed -i '' "s|^SESSION_SECRET=.*|SESSION_SECRET=${SESSION}|" .env
  echo "→ .env créé avec des clés fraîches."
fi

createdb chapo 2>/dev/null || echo "→ base 'chapo' déjà présente"
createdb chapo_test 2>/dev/null || echo "→ base 'chapo_test' déjà présente"

pnpm db:migrate
pnpm db:seed
echo "✅ Setup terminé. Lancer: pnpm dev"
