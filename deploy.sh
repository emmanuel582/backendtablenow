#!/bin/bash
set -e

echo "🚀 TableNow Backend — Déploiement VPS"

git pull origin main
npm install --omit=dev
npm run build

echo "🔍 Vérification variables d'environnement..."
for var in SUPABASE_ANON_KEY INTERNAL_SECRET BACKEND_URL JWT_SECRET VAPI_API_KEY; do
  if ! grep -q "^${var}=" .env 2>/dev/null; then
    echo "❌ Manquante dans .env : $var"
    exit 1
  fi
done
echo "✅ Variables OK"

pm2 restart tablenow-backend || pm2 start dist/server.js --name tablenow-backend
pm2 logs tablenow-backend --lines 30 --nostream
