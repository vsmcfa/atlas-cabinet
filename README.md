# ATLAS — formulaire garage sur Supabase

Remplace Netlify Forms par un backend Supabase. Le site statique **reste sur
Netlify, au même endroit** : les quatre URL de démonstration déjà diffusées ne
bougent pas d'un octet.

```
site/                       à redéployer sur Netlify (glisser-déposer)
  index.html                le formulaire — POSTe désormais vers Supabase
  merci/index.html          confirmation, affiche la référence renvoyée par le serveur
  robots.txt                Disallow: /   (inchangé)
  tableau-de-bord/          \
  audit-juridique/           |  démos — strictement identiques à l'original,
  optimisation-ik-karim/     |  vérifié par diff. Ne pas y toucher.
  simulateur-cfa-adultes/   /

supabase/
  migrations/…_atlas_init.sql   tables, vues, bucket privé
  planification.sql             tâches pg_cron (à lancer à la fin)
  functions/lead/               endpoint public du formulaire
  functions/relance-mail/       file de reprise des mails échoués
  functions/purge/              rétention + nettoyage des fichiers orphelins
  functions/_partage/           helpers communs (validation, CORS, Brevo)
  autonome/                     mêmes fonctions en 1 fichier, pour le Dashboard
  grouper.mjs                   régénère supabase/autonome/

.env.example                    les secrets à définir, avec leur mode d'emploi
```

---

## Comment ça marche

Le fichier **ne transite pas** par l'Edge Function : le navigateur l'envoie
directement au Storage avec une URL signée à usage unique. C'est ce qui fait
sauter la limite des 8 Mo de Netlify sans se heurter à la taille maximale
d'une requête de fonction.

```
navigateur                     Edge Function « lead »              Supabase
    │
    ├─ 1. POST /lead/upload-url ──────────►  vérifie taille + type + débit
    │                                        crée une URL signée + signature HMAC
    │   ◄───────────────────────────────────  { chemin, url, signature }
    │
    ├─ 2. PUT <url signée> ───────────────────────────────────────►  Storage (bucket privé)
    │      (avec barre de progression)
    │
    ├─ 3. POST /lead  { champs, chemin, signature } ──►  honeypot ? temps < 3 s ? débit ?
    │                                        relit les 64 premiers octets du fichier
    │                                        → type réel : un .exe renommé .pdf est refusé
    │                                        INSERT dans « leads »        ← fait foi
    │                                        envoie le mail via Brevo
    │   ◄───────────────────────────────────  { ok, reference }
    │
    └─ 4. l'écran de succès s'affiche SEULEMENT ici, jamais avant.
```

**Le bilan n'est pas mis en pièce jointe.** Il reste dans le bucket privé
Supabase ; le mail porte un lien signé valable 60 jours. Conséquence voulue :
aucune limite de taille, et le fichier ne se duplique pas dans des boîtes mail
que l'on ne maîtrise pas. Pour revenir à la pièce jointe réelle, passer
`MAIL_MODE_BILAN=piece_jointe` — Brevo plafonne alors aux alentours de 10 Mo.

---

## Installation pas à pas

### 1. Créer le projet Supabase

[supabase.com](https://supabase.com) → **New project**.

| Champ | Valeur |
|---|---|
| Name | `atlas` |
| Region | **Frankfurt (eu-central-1)** — données de dirigeants français, on reste en UE |
| Database password | générer et le ranger dans votre gestionnaire de mots de passe |

Notez la **référence du projet** (le `abcdefghij` de `https://abcdefghij.supabase.co`),
elle revient partout ci-dessous.

### 2. Créer les tables

Dashboard → **SQL Editor** → **New query** → coller tout le contenu de
`supabase/migrations/20260923120000_atlas_init.sql` → **Run**.

Vérifiez dans **Table Editor** que `leads`, `rejets`, `hits` et `alertes`
existent, et dans **Storage** que le bucket `bilans` apparaît, marqué privé.

### 3. Récupérer la clé Brevo

**Rien à faire côté DNS.** VSM Connect envoie déjà ses conventions et ses CERFA
depuis `contact@vsmcfa.com` via Brevo : le domaine `vsmcfa.com` y est authentifié
(DKIM/DMARC) et l'expéditeur est rodé en production. ATLAS réutilise le même
compte Brevo et le même expéditeur.

Récupérez la clé existante dans le projet Supabase de vsm-crm →
**Edge Functions** → **Secrets** → `BREVO_API_KEY`. À défaut,
[app.brevo.com](https://app.brevo.com) → **SMTP & API** → **API Keys** →
**Generate a new API key** (elle n'est affichée qu'une fois).

Pour envoyer depuis `atlas@vsmcfa.com` plutôt que `contact@`, il faut d'abord
ajouter cette adresse dans Brevo → **Senders**. Sans cette étape, laissez
`MAIL_EXPEDITEUR=contact@vsmcfa.com`.

### 4. Définir les secrets

Générez d'abord deux secrets :

```bash
openssl rand -hex 32   # -> ATLAS_SECRET
openssl rand -hex 32   # -> CRON_SECRET
```

Dashboard → **Project Settings** → **Edge Functions** → **Secrets** → ajoutez
une à une les variables de `.env.example`. `SUPABASE_URL` et
`SUPABASE_SERVICE_ROLE_KEY` sont fournies automatiquement : **ne pas les
recréer**.

`ORIGINES_AUTORISEES` doit contenir l'URL exacte du site Netlify, sans barre
oblique finale :

```
ORIGINES_AUTORISEES=https://cabinet-atlas-link.netlify.app
```

Si vous branchez plus tard un sous-domaine `vsmcfa.com`, ajoutez-le ici séparé
par une virgule, **avant** de diffuser la nouvelle URL.

### 5. Déployer les fonctions

```bash
npm install -g supabase          # ou : brew install supabase/tap/supabase
supabase login
supabase link --project-ref VOTRE-PROJET

supabase functions deploy lead         --no-verify-jwt
supabase functions deploy relance-mail --no-verify-jwt
supabase functions deploy purge        --no-verify-jwt
```

`--no-verify-jwt` est indispensable pour `lead` : le formulaire est public et
ne présente aucun jeton. Les deux autres sont protégées par l'en-tête
`x-cron-secret`, vérifié dans le code.

> **Si vous déployez par copier-coller dans le Dashboard plutôt qu'en CLI**,
> n'utilisez surtout pas les fichiers de `functions/` : le Dashboard ne sait pas
> charger les fichiers voisins et vous obtiendrez `Module not found` sur
> `../_partage/commun.ts` — exactement l'erreur rencontrée sur VSM Connect.
> Collez les fichiers de **`supabase/autonome/`**, qui contiennent tout en un
> seul fichier. Pensez alors à régler **Verify JWT = OFF** sur les trois
> fonctions, le réglage ne se déduisant pas de `config.toml`.
>
> Après toute modification dans `functions/`, régénérez-les :
> ```bash
> node supabase/grouper.mjs
> ```

### 6. Pointer le formulaire vers votre projet

Dans `site/index.html`, une seule ligne à changer, au début du `<script>` :

```js
var API = 'https://VOTRE-PROJET.supabase.co/functions/v1/lead';
```

### 7. Redéployer le site sur Netlify

Netlify → le site existant → **Deploys** → **Deploy manually** → glisser le
dossier `site/` **entier**.

Puis, dans **Forms**, vous pouvez supprimer le formulaire `atlas-audit-gratuit`
et la notification vers `contact@vsmcfa.com` : ils ne servent plus. Gardez
l'historique des soumissions déjà reçues avant de supprimer quoi que ce soit.

### 8. Planifier les tâches de fond

SQL Editor → coller `supabase/planification.sql` **après y avoir remplacé**
`VOTRE-PROJET` et `VOTRE_SECRET` → **Run**.

---

## Écran d'administration

Il n'y a rien à développer : le Table Editor Supabase est déjà protégé par
mot de passe et fait le travail.

| Vue | À quoi elle sert |
|---|---|
| `v_leads` | tous les leads, les plus récents d'abord. Bouton **Export CSV** en haut à droite. |
| `v_a_traiter` | **à regarder tous les jours** : leads enregistrés dont le mail n'est pas parti. |
| `rejets` | soumissions refusées. Un vrai prospect faussement rejeté s'y retrouve, avec ses données. |
| `alertes` | incidents à traiter. `traitee = false` = en attente. |

**Télécharger un bilan** : Storage → `bilans` → naviguer par année/mois, ou
copier la valeur `bilan_chemin` de la ligne du lead.

Pour un accès sans donner le mot de passe Supabase à toute l'équipe : Project
Settings → Team → inviter avec le rôle **Read-only**.

---

## Vérifications à faire après installation

Les critères du brief, dans l'ordre où il est commode de les tester.

| # | Test | Attendu |
|---|---|---|
| 1 | Ouvrir les 4 URL de démo | s'affichent comme avant (`diff` déjà vérifié : fichiers identiques) |
| 2 | Envoi complet avec un PDF de 12 Mo | barre de progression, puis page de remerciement avec référence ; mail reçu avec le lien de téléchargement |
| 3 | Envoi **sans** bilan | aboutit ; le mail affiche en rouge « Aucun bilan joint. À réclamer lors du rappel. » |
| 4 | Remplir le champ piège (console : `document.getElementById('botField').value='x'`) | refusé, et une ligne apparaît dans `rejets` avec le motif `honeypot` |
| 5 | Couper le Wi-Fi puis envoyer | message d'erreur explicite, saisie intacte à l'écran, aucune page de succès |
| 6 | Renommer un `.exe` en `.pdf` et le joindre | refusé dès la sélection ; même refusé côté serveur si on force |
| 7 | Mettre une fausse `BREVO_API_KEY`, puis envoyer | la page de succès s'affiche quand même, le lead est dans `v_leads`, et il apparaît dans `v_a_traiter` + `alertes` |
| 8 | Ouvrir `…/?c=DUPONT` et envoyer | `DUPONT` visible dans le mail et dans la colonne `commercial` |
| 9 | Dans Gmail, cliquer **Répondre** | le destinataire est l'adresse du garage, pas le serveur |
| 10 | Chercher un lien vers les démos dans le formulaire | aucun (vérifié : seuls des liens Google Fonts) |

Pour le test 7, n'oubliez pas de remettre la vraie clé, puis d'attendre 15 min :
`relance-mail` doit repartir toute seule et le lead passer en `mail_statut = envoye`.

---

## Sécurité et données personnelles

- Tables en **RLS activé sans aucune policy** : les clés publiques `anon` ne
  peuvent ni lire ni écrire. Seules les Edge Functions, qui utilisent
  `service_role`, ont accès.
- Bucket `bilans` **privé**, sans policy : aucune URL publique n'existe. Les
  seuls accès sont des URL signées à durée limitée.
- Le nom de fichier d'origine n'est **jamais** utilisé comme chemin : les objets
  sont nommés `AAAA/MM/<uuid>.<ext>`, l'extension venant du type réel détecté.
- **Rétention illimitée** (décision dirigeant) : leads et bilans restent en
  ligne indéfiniment. `RETENTION_BILAN_JOURS` et `RETENTION_LEAD_JOURS` valent
  `0`, ce qui désactive complètement les deux purges automatiques. Les
  suppressions se font à la demande, à la main, depuis le Table Editor.
- Un fichier envoyé dont le formulaire n'a jamais été validé est supprimé au
  bout de 7 jours : sans ligne de lead, il n'a ni nom de garage ni contact.
- Le lien de téléchargement présent dans le mail est signé et valable **1 an**.
  Passé ce délai le bilan n'est pas perdu, il se récupère depuis Supabase via la
  référence du lead.
- La clé `service_role` ne doit **jamais** apparaître dans `site/` ni dans un
  dépôt. Le front n'embarque aucune clé : uniquement l'URL de la fonction.

---

## Ce qui reste ouvert

**Durées de conservation à formaliser.** Le message de confidentialité du
formulaire promet une suppression sur demande, et `docs/juridique/conformite-vie-privee-crm.md`
de vsm-crm liste déjà « fixer les durées de conservation » comme point ouvert.
La rétention illimitée est un choix assumé, mais il faudra à un moment pouvoir
répondre à une demande de suppression : la procédure est aujourd'hui manuelle
(supprimer la ligne dans `leads` **et** le fichier dans Storage). Le code est
prêt pour une purge automatique le jour où une durée sera arrêtée : il suffira
de passer `RETENTION_BILAN_JOURS` / `RETENTION_LEAD_JOURS` à une valeur non nulle.

**Le simulateur `/simulateur-cfa-adultes/` n'a pas été touché**, conformément au
§10 du brief. Ses défauts sont intacts et connus : les dossiers restent dans le
`localStorage` de l'appareil, l'écran « Dossier transmis — le CFA vous rappelle »
n'envoie rien nulle part, et le panneau Paramètres est sans code par défaut
alors qu'il expose les dossiers déjà saisis. Le lien ne doit être donné qu'au
commercial.

Le brancher sur `POST /api/lead` est maintenant une extension courte : le
backend existe, il suffit d'ajouter une table `simulations` et de remplacer
l'écriture `localStorage` par le même appel `fetch`. Compter une demi-journée,
dont la reprise des dossiers déjà stockés sur le téléphone du commercial via
l'export CSV du panneau Paramètres, à faire **avant** de vider quoi que ce soit.
