#!/usr/bin/env bash
# Déploiement complet d'ATLAS. À lancer depuis la racine du projet.
#
#   ./outils/deployer.sh            tout
#   ./outils/deployer.sh fonctions  seulement les Edge Functions
#   ./outils/deployer.sh sites      seulement les deux sites Netlify
#
# Prérequis, une seule fois : npx supabase login && npx netlify login
set -euo pipefail
cd "$(dirname "$0")/.."

PROJET=lioymgigpojlqzrggkff
SITE_FORMULAIRE=cabinet-atlas-link      # site prospect
SITE_ADMIN=atlasinterface               # console de consultation
QUOI="${1:-tout}"

vert() { printf '\033[32m%s\033[0m\n' "$1"; }

if [ "$QUOI" = "tout" ] || [ "$QUOI" = "fonctions" ]; then
  echo "── Vérification des types ──"
  deno check supabase/functions/*/index.ts
  echo "── Régénération des versions autonomes ──"
  node supabase/grouper.mjs
  echo "── Déploiement des Edge Functions ──"
  for f in lead admin relance-mail purge; do
    printf '  %-13s ' "$f"
    npx --no-install supabase functions deploy "$f" --no-verify-jwt --project-ref "$PROJET" >/dev/null 2>&1 \
      && vert "déployée" || { echo "ÉCHEC"; exit 1; }
  done
fi

if [ "$QUOI" = "tout" ] || [ "$QUOI" = "sites" ]; then
  echo "── Déploiement des sites Netlify ──"
  printf '  formulaire    '
  npx --no-install netlify deploy --prod --dir=site  --site="$SITE_FORMULAIRE" --message "déploiement automatique" >/dev/null 2>&1 \
    && vert "en ligne" || { echo "ÉCHEC"; exit 1; }
  printf '  console admin '
  npx --no-install netlify deploy --prod --dir=admin --site="$SITE_ADMIN" --message "déploiement automatique" >/dev/null 2>&1 \
    && vert "en ligne" || { echo "ÉCHEC"; exit 1; }
fi

echo
vert "Terminé."
