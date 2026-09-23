#!/usr/bin/env node
/*
 * Démo locale — sert le formulaire, la console d'admin et une FAUSSE API.
 *
 * But : voir les deux interfaces fonctionner de bout en bout sans projet
 * Supabase. Les données sont en mémoire et disparaissent à l'arrêt.
 * Rien de ce fichier ne part en production.
 *
 *   node outils/demo-locale.mjs
 *   formulaire : http://localhost:4000
 *   admin      : http://localhost:4001   (mot de passe : atlas)
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'

const RACINE = new URL('..', import.meta.url).pathname
const API = 'http://localhost:4002'
const MOT_DE_PASSE = 'atlas'

/* ----------------------------------------------------- données factices */

const leads = [
  {
    id: randomUUID(), reference: 'A1B2C3D4',
    created_at: new Date(Date.now() - 3600e3).toISOString(),
    garage: 'Garage Martin & Fils', dirigeant: 'Paul Martin',
    telephone: '06 12 34 56 78', email: 'contact@garage-martin.fr', salaries: 4,
    interets: ['Avoir un expert-comptable plus réactif', 'Savoir où mon garage peut économiser et combien'],
    bilan_fourni: true, bilan_nom_origine: 'bilan-2025.pdf', bilan_taille: 12_400_000,
    commercial: 'DUPONT', mail_statut: 'envoye', mail_erreur: null,
  },
  {
    id: randomUUID(), reference: 'E5F6A7B8',
    created_at: new Date(Date.now() - 26 * 3600e3).toISOString(),
    garage: 'Carrosserie du Pont', dirigeant: 'Sonia Belkacem',
    telephone: '07 98 76 54 32', email: 'sonia@carrosserie-pont.fr', salaries: 11,
    interets: ['Diminuer légalement mes prélèvements Urssaf et fiscaux'],
    bilan_fourni: false, bilan_nom_origine: null, bilan_taille: null,
    commercial: 'DUPONT', mail_statut: 'envoye', mail_erreur: null,
  },
  {
    id: randomUUID(), reference: 'C9D0E1F2',
    created_at: new Date(Date.now() - 3 * 86400e3).toISOString(),
    garage: 'Auto Services 93', dirigeant: 'Kevin Nguyen',
    telephone: '06 55 44 33 22', email: 'k.nguyen@as93.fr', salaries: 2,
    interets: ['Développer davantage mes activités', 'Obtenir plus de chiffre d’affaires chaque mois'],
    bilan_fourni: true, bilan_nom_origine: 'bilan-scan.jpg', bilan_taille: 3_100_000,
    commercial: null, mail_statut: 'echec',
    mail_erreur: 'Brevo 401 : Key not found — démonstration de la file de reprise',
  },
]

const jetons = new Set()
const json = (res, corps, code = 200) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...CORS })
  res.end(JSON.stringify(corps))
}
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
}
const lireCorps = (req) => new Promise((ok) => {
  let d = ''
  req.on('data', (c) => { d += c })
  req.on('end', () => { try { ok(JSON.parse(d || '{}')) } catch { ok({}) } })
})

/* ------------------------------------------------------------ fausse API */

createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end() }
  const route = req.url.split('?')[0]
  const corps = await lireCorps(req)

  // — formulaire —
  if (route === '/functions/v1/lead/upload-url') {
    return json(res, { chemin: `2026/09/${randomUUID()}.pdf`, url: `${API}/faux-upload`, signature: 'demo' })
  }
  if (route === '/faux-upload') { res.writeHead(200, CORS); return res.end('ok') }
  if (route === '/functions/v1/lead') {
    if (corps['bot-field']) return json(res, { erreur: 'Envoi refusé. Si vous êtes bien un humain, appelez-nous directement.' }, 422)
    if (corps.remplissage_ms < 3000) return json(res, { erreur: 'Envoi refusé. Si vous êtes bien un humain, appelez-nous directement.' }, 422)
    const reference = createHash('sha1').update(randomUUID()).digest('hex').slice(0, 8).toUpperCase()
    leads.unshift({
      id: randomUUID(), reference, created_at: new Date().toISOString(),
      garage: corps.garage, dirigeant: corps.dirigeant, telephone: corps.telephone,
      email: corps.email, salaries: corps.salaries, interets: corps.interet,
      bilan_fourni: !!corps.bilan_chemin, bilan_nom_origine: corps.bilan_nom ?? null,
      bilan_taille: corps.bilan_chemin ? 1_048_576 : null,
      commercial: corps.commercial || null, mail_statut: 'envoye', mail_erreur: null,
    })
    console.log(`  → lead reçu : ${corps.garage} (réf. ${reference})`)
    return json(res, { ok: true, id: randomUUID(), reference })
  }

  // — admin —
  if (route === '/functions/v1/admin/session') {
    if (corps.motdepasse !== MOT_DE_PASSE) return json(res, { erreur: 'Mot de passe incorrect.' }, 401)
    const jeton = randomUUID()
    jetons.add(jeton)
    return json(res, { jeton, expire_at: new Date(Date.now() + 8 * 3600e3).toISOString() })
  }
  if (route.startsWith('/functions/v1/admin/')) {
    if (!jetons.has(corps.jeton)) return json(res, { erreur: 'Session expirée.' }, 401)
    const quoi = route.split('/').pop()
    if (quoi === 'leads') {
      const q = (corps.recherche || '').toLowerCase()
      let liste = leads
      if (q) liste = liste.filter((l) => [l.garage, l.dirigeant, l.email, l.telephone, l.commercial, l.reference]
        .some((v) => (v || '').toLowerCase().includes(q)))
      if (corps.a_traiter) liste = liste.filter((l) => l.mail_statut !== 'envoye')
      return json(res, { leads: liste, total: liste.length, page: 0, parPage: 50 })
    }
    if (quoi === 'bilan') return json(res, { url: `${API}/faux-bilan` })
    if (quoi === 'export') {
      res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', ...CORS })
      return res.end('﻿' + ['Référence;Garage;Dirigeant;E-mail',
        ...leads.map((l) => `${l.reference};${l.garage};${l.dirigeant};${l.email}`)].join('\r\n'))
    }
  }
  if (route === '/faux-bilan') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', ...CORS })
    return res.end('Démonstration : en production, ce lien sert le vrai PDF depuis Supabase Storage.')
  }
  json(res, { erreur: 'route inconnue' }, 404)
}).listen(4002)

/* --------------------------------------------------------- sites statiques */

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.txt': 'text/plain' }

function servir(dossier, port, nom) {
  createServer(async (req, res) => {
    let chemin = normalize(decodeURIComponent(req.url.split('?')[0]))
    if (chemin.endsWith('/')) chemin += 'index.html'
    const fichier = join(RACINE, dossier, chemin)
    if (!fichier.startsWith(join(RACINE, dossier))) { res.writeHead(403); return res.end() }
    try {
      let contenu = await readFile(fichier, 'utf8')
      // Injection à la volée : les fichiers du dépôt gardent leur URL de production.
      // Quel que soit le projet configuré, la démo tape TOUJOURS l'API locale :
      // sans cette réécriture, ouvrir localhost enverrait de vrais leads en
      // production. Le motif couvre aussi bien le gabarit que l'URL réelle.
      contenu = contenu.replace(
        /https:\/\/[a-zA-Z0-9-]+\.supabase\.co\/functions\/v1\/(lead|admin)/g,
        `${API}/functions/v1/$1`)
      res.writeHead(200, { 'content-type': `${TYPES[extname(fichier)] ?? 'text/plain'}; charset=utf-8` })
      res.end(contenu)
    } catch {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<p style="font-family:system-ui;padding:40px">404 — ' + chemin + '</p>')
    }
  }).listen(port, () => console.log(`  ${nom.padEnd(12)} http://localhost:${port}`))
}

console.log('\nATLAS — démo locale (données factices, en mémoire)\n')
servir('site', 4000, 'Formulaire')
servir('admin', 4001, 'Admin')
console.log(`  ${'API'.padEnd(12)} ${API}\n`)
console.log(`  Mot de passe de l'admin : ${MOT_DE_PASSE}`)
console.log('  Ctrl+C pour arrêter.\n')
