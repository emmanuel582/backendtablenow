#!/bin/bash
# TableNow Backend — VPS deploy. Run on the VPS (manually or via the
# deploy-vps GitHub Action). Idempotent: always rebuilds from remote main.
set -euo pipefail

echo "🚀 TableNow Backend — Déploiement VPS"

# Deploy the EXACT remote main — no merge surprises, no local drift.
git fetch origin main
git reset --hard origin/main

# Install ALL deps. The TypeScript build needs devDependencies (tsc, rimraf,
# copyfiles), so --omit=dev here would break `npm run build`. npm ci is
# reproducible from package-lock.json.
npm ci

# Compile TS -> dist/ and copy runtime assets.
npm run build

echo "🔍 Vérification variables d'environnement..."
for var in SUPABASE_ANON_KEY INTERNAL_SECRET BACKEND_URL JWT_SECRET VAPI_API_KEY; do
  if ! grep -q "^${var}=" .env 2>/dev/null; then
    echo "❌ Manquante dans .env : $var"
    exit 1
  fi
done
echo "✅ Variables OK"

# Restart (or first-time start) under pm2, pick up any .env changes, and
# persist the process list so it survives a reboot.
pm2 restart tablenow-api --update-env || pm2 start dist/server.js --name tablenow-api
pm2 save
pm2 logs tablenow-api --lines 30 --nostream
