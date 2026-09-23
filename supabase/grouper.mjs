#!/usr/bin/env node
/*
 * Produit des versions AUTONOMES des Edge Functions dans supabase/autonome/.
 *
 * Pourquoi : le Dashboard Supabase ne sait pas charger les fichiers voisins
 * (« Module not found » sur ../_partage/commun.ts) — piège déjà rencontré sur
 * VSM Connect. Le déploiement par la CLI, lui, gère très bien les imports
 * relatifs ; ces fichiers ne servent qu'au copier-coller dans le Dashboard.
 *
 * Usage :  node supabase/grouper.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ici = dirname(fileURLToPath(import.meta.url))
const FONCTIONS = ['lead', 'admin', 'relance-mail', 'purge']

// Capte aussi bien `import { a } from "x"` que la forme multi-lignes.
const IMPORT = /^import\s+(?:type\s+)?\{([\s\S]*?)\}\s+from\s+"([^"]+)";?\s*$/gm

/**
 * Inline récursivement les imports relatifs et remonte les imports externes.
 * @param externes Map<spécificateur de module, Set<nom importé>>
 */
function inliner(fichier, vus, externes) {
  if (vus.has(fichier)) return ''
  vus.add(fichier)

  const source = readFileSync(fichier, 'utf8')
  const dossier = dirname(fichier)
  let avant = ''

  const corps = source.replace(IMPORT, (_tout, noms, module) => {
    if (module.startsWith('.')) {
      avant += inliner(resolve(dossier, module), vus, externes)
      return ''
    }
    // Import externe (jsr:, https:…) : on le remonte en tête, dédoublonné.
    if (!externes.has(module)) externes.set(module, new Set())
    for (const n of noms.split(',').map((s) => s.trim()).filter(Boolean)) {
      externes.get(module).add(n.replace(/^type\s+/, ''))
    }
    return ''
  })

  // `export` n'a plus de sens une fois tout réuni dans un seul fichier.
  const nu = corps.replace(/^export (const|let|function|async function|type|enum|interface) /gm, '$1 ')
  return avant + nu.replace(/\n{3,}/g, '\n\n').trim() + '\n\n'
}

mkdirSync(resolve(ici, 'autonome'), { recursive: true })

for (const nom of FONCTIONS) {
  const externes = new Map()
  const corps = inliner(resolve(ici, 'functions', nom, 'index.ts'), new Set(), externes)

  const imports = [...externes.entries()]
    .map(([module, noms]) => `import { ${[...noms].sort().join(', ')} } from "${module}";`)
    .join('\n')

  const entete =
    `// ─────────────────────────────────────────────────────────────────────────\n` +
    `// ATLAS — fonction « ${nom} », version autonome (un seul fichier).\n` +
    `// GÉNÉRÉ AUTOMATIQUEMENT : ne pas modifier ici.\n` +
    `// Source : supabase/functions/${nom}/  ·  Régénérer : node supabase/grouper.mjs\n` +
    `// À coller dans Dashboard > Edge Functions, qui ne sait pas charger _partage/.\n` +
    `// ─────────────────────────────────────────────────────────────────────────\n\n`

  const fichier = `${entete}${imports}\n\n${corps}`
  writeFileSync(resolve(ici, 'autonome', `${nom}.ts`), fichier)
  console.log(`✓ supabase/autonome/${nom}.ts  (${fichier.split('\n').length} lignes)`)
}
