# ATLAS — passation

Document destiné à la personne qui reprendra ce projet sans avoir participé à sa
construction. Il répond à trois questions : **où sont les choses**, **qu'est-ce
qui peut casser et comment s'en apercevoir**, **que faire dans ce cas**.

Pour l'installation initiale, voir [README.md](README.md). Ce document-ci
suppose que le système tourne déjà.

---

## 1. À quoi sert ce projet

Un commercial VSM démarche des garages automobiles. Il envoie au dirigeant un
lien vers un formulaire. Le dirigeant le remplit, éventuellement avec son dernier
bilan comptable. L'équipe reçoit un e-mail et traite le lead sous 48 h.

La marque affichée est **ATLAS × Etchecom**, une offre de comptabilité réservée
aux garagistes. L'entreprise derrière est **VSM** (`vsmcfa.com`).

Le remplisseur type est un patron de garage, sur téléphone, en atelier, peu
patient. **Chaque friction ajoutée au formulaire coûte des leads.** C'est le
critère qui doit trancher les arbitrages d'interface.

---

## 2. Les cinq pièces et qui en dépend

| Pièce | Où | Casse si… |
|---|---|---|
| Site prospect | Netlify, dossier `site/` | — |
| Console de consultation | Netlify **séparé**, dossier `admin/` | — |
| Fonctions serveur | Supabase Edge Functions | Supabase en panne |
| Base + fichiers | Supabase (Postgres + Storage) | Supabase en panne |
| Envoi des e-mails | Brevo, compte partagé avec VSM Connect | clé révoquée, quota atteint |

**Les deux sites Netlify sont séparés volontairement.** La console d'admin n'a
aucun lien avec le site prospect, et son URL ne doit être connue que de l'équipe.

**Le compte Brevo est partagé avec VSM Connect** (le CRM, dépôt `vsm-crm`).
Révoquer la clé `BREVO_API_KEY` casse **les deux projets**, y compris l'envoi
des conventions et des CERFA. Ne jamais la regénérer sans prévenir.

---

## 3. Contraintes à ne pas casser

Ces points ont chacun une raison précise. Les enfreindre ne produit pas d'erreur
visible — c'est bien le problème.

1. **Les quatre URL de démonstration ne changent jamais.**
   `/tableau-de-bord/`, `/audit-juridique/`, `/optimisation-ik-karim/`,
   `/simulateur-cfa-adultes/`. Le dirigeant les a déjà diffusées à des
   prospects. Une 404 sur l'une d'elles est un incident.

2. **Aucun lien du formulaire vers les démos.** Un prospect ne doit pas pouvoir
   découvrir les pages internes. L'inverse (démo → formulaire) est voulu.

3. **`noindex` sur toutes les pages + `robots.txt` en `Disallow: /`.** Rien de
   ce site n'a vocation à être indexé.

4. **Jamais d'attribut `required` sur le champ fichier.** Il est masqué en CSS.
   Chrome refuse alors de soumettre le formulaire et affiche en console
   « An invalid form control is not focusable » — **sans rien montrer à
   l'utilisateur**. La validation du fichier se fait en JavaScript, exclusivement.

5. **Le champ piège reste en `display:none`.** Il était autrefois masqué par
   `position:absolute; left:-9999px`, et Safari comme Chrome le remplissaient
   parfois automatiquement. Les soumissions étaient alors rejetées en silence.
   Garder les trois protections : `display:none`, `tabindex="-1"`,
   `autocomplete="off"`.

6. **Aucun écran de succès sans confirmation du serveur.** La page `/merci/`
   ne doit s'afficher qu'après une réponse `200` portant une référence.

7. **La clé `service_role` ne sort jamais du serveur.** Ni dans `site/`, ni
   dans `admin/`, ni dans le dépôt. Les deux pages publiques ne contiennent
   aucun secret : vérifier que ça reste vrai à chaque modification.

---

## 4. Surveillance quotidienne

Une seule chose à regarder, dans la console d'admin : le filtre
**⚠️ Mail non parti**. S'il est vide, tout va bien.

S'il ne l'est pas, **les leads ne sont pas perdus** — ils sont en base, c'est
tout l'intérêt du dispositif. Seule la notification a échoué. La colonne
« dernière erreur » du panneau de détail dit pourquoi :

| Erreur | Cause probable | Que faire |
|---|---|---|
| `Brevo 401` | clé révoquée ou expirée | regénérer dans Brevo, mettre à jour le secret **des deux projets** |
| `Brevo 402` / quota | plafond d'envoi atteint | vérifier le plan Brevo |
| `BREVO_API_KEY manquante` | secret absent du projet Supabase | le rajouter dans Edge Functions → Secrets |
| `lecture du bilan impossible` | fichier absent du Storage | le lead reste exploitable, le bilan est à redemander |

La fonction `relance-mail` réessaie automatiquement toutes les 15 minutes,
jusqu'à 6 tentatives. Après quoi elle écrit dans la table `alertes` et cesse.

Les autres tables à connaître : `rejets` (soumissions refusées — un vrai
prospect faussement rejeté s'y retrouve **avec ses données**, donc récupérable)
et `alertes` (incidents, `traitee = false` = en attente).

---

## 5. Décisions prises, et pourquoi

Les revenir sur ces points est possible, mais sachez ce que vous défaites.

**Le bilan n'est pas en pièce jointe, mais en lien signé.** Brevo plafonne les
pièces jointes aux alentours de 10 Mo ; un bilan scanné les dépasse souvent. Le
lien supprime toute limite et évite de dupliquer un document comptable dans des
boîtes mail non maîtrisées. Pour revenir en arrière :
`MAIL_MODE_BILAN=piece_jointe`.

**Le fichier ne transite pas par la fonction.** Il va du navigateur au Storage
via une URL signée. C'est ce qui fait sauter la limite de 8 Mo de Netlify sans
se heurter à la taille maximale d'une requête de fonction.

**Rétention illimitée** (décision dirigeant). `RETENTION_BILAN_JOURS` et
`RETENTION_LEAD_JOURS` valent `0`, ce qui désactive les purges. Le code est
prêt si une durée est arrêtée un jour : il suffit de mettre une valeur non nulle.
**Point ouvert** : le formulaire promet une suppression sur demande, elle est
aujourd'hui manuelle (supprimer la ligne dans `leads` **et** le fichier dans
Storage).

**Mot de passe unique partagé pour la console** (décision dirigeant). Il est
vérifié côté serveur contre une empreinte SHA-256 ; la page ne le contient pas.
Limite assumée : on ne sait pas qui consulte, et il faut le changer pour tout le
monde dès qu'une personne quitte l'équipe. Passer à des comptes nominatifs
demanderait d'activer Supabase Auth et d'ajouter des policies RLS — environ une
demi-journée.

**Pas de captcha.** Il ferait chuter le taux de complétion sur un public déjà
peu patient. À la place : champ piège, contrôle du temps de remplissage
(rejet sous 3 secondes) et limitation de débit par IP.

---

## 6. Modifier le projet

```bash
npm install                      # CLI Supabase
node outils/demo-locale.mjs      # démo locale avec données factices
```

La démo locale sert le formulaire sur `:4000` et la console sur `:4001`, avec
une fausse API sur `:4002`. Aucun accès à Supabase n'est nécessaire. C'est le
moyen de voir une modification d'interface sans rien déployer.

Après toute modification des fonctions :

```bash
deno check supabase/functions/*/index.ts    # vérification des types
node supabase/grouper.mjs                   # régénère supabase/autonome/
npx supabase functions deploy lead          # déploiement
```

**`supabase/autonome/` est généré, ne jamais l'éditer à la main.** Ces fichiers
n'existent que parce que le Dashboard Supabase ne sait pas charger les fichiers
voisins (`Module not found` sur `_partage/`) — piège déjà rencontré sur VSM
Connect. La source fait foi, c'est `supabase/functions/`.

---

## 7. Hors périmètre, et connu

**Le simulateur `/simulateur-cfa-adultes/`.** Ses dossiers restent dans le
`localStorage` de l'appareil ; l'écran « Dossier transmis — le CFA vous
rappelle » **n'envoie rien nulle part** ; le panneau Paramètres est sans code
par défaut alors qu'il expose les dossiers déjà saisis, noms et téléphones
compris. Le lien ne doit être donné qu'au commercial, jamais à un prospect.

Le brancher sur le backend existant est maintenant court : ajouter une table
`simulations` et remplacer l'écriture `localStorage` par le même appel `fetch`.
Compter une demi-journée, **dont la récupération des dossiers déjà stockés sur
le téléphone du commercial** via l'export CSV du panneau Paramètres — à faire
avant de vider quoi que ce soit.

---

## 8. Ce qui n'a jamais été vérifié en conditions réelles

Honnêtement listé, pour que personne ne le découvre au mauvais moment :

- le SQL de `supabase/migrations/` n'a pas été exécuté sur un Postgres lors de
  son écriture (pas d'instance disponible) — il l'a été à l'installation ;
- l'envoi réel via Brevo depuis ce projet n'a été testé qu'à l'installation ;
- la charge n'a pas été éprouvée : le volume attendu est de quelques leads par
  jour, très loin des limites de Supabase comme de Brevo.
