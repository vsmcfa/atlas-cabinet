# Brief — migrer le formulaire ATLAS de Netlify vers un serveur

Tu reprends un projet existant. Le zip `atlas-site.zip` joint contient **le site actuellement en production** sur Netlify (`cabinet-atlas-link.netlify.app`). Lis-le avant toute chose : il est fonctionnel, et une partie de ce qu'il contient est le résultat de bugs déjà rencontrés et corrigés. Ne pars pas d'une page blanche.

---

## 1. Contexte métier

- L'entreprise est **VSM** (`vsmcfa.com`). Elle accompagne des garages automobiles.
- Le site porte la marque **ATLAS × Etchecom**, une offre de comptabilité réservée aux garagistes.
- Un **commercial terrain** démarche des garages. Il montre des pages de démonstration sur son téléphone, puis envoie au dirigeant un lien vers un formulaire.
- Le dirigeant du garage remplit le formulaire, éventuellement avec son dernier bilan comptable.
- Les réponses doivent arriver sur **contact@vsmcfa.com** (boîte Gmail / Google Workspace).

Le remplisseur type : un patron de garage, sur téléphone, peu patient, souvent en atelier. Chaque friction coûte un lead.

---

## 2. État actuel (le zip)

```
index.html                        le formulaire prospect, à la racine
merci/index.html                  page de confirmation après envoi
robots.txt                        Disallow: / (rien ne doit être indexé)
tableau-de-bord/index.html        démo — interne
audit-juridique/index.html        démo — interne
optimisation-ik-karim/index.html  démo — interne
simulateur-cfa-adultes/index.html simulateur — interne
```

Le formulaire fonctionne aujourd'hui via **Netlify Forms** : POST natif multipart, Netlify stocke la soumission et envoie une notification à contact@vsmcfa.com. Le PDF arrive **sous forme de lien**, pas de pièce jointe.

Champs du formulaire (attribut `name` entre parenthèses) :

| Champ | name | Obligatoire |
|---|---|---|
| Nom du garage | `garage` | oui |
| Nom et prénom du dirigeant | `dirigeant` | oui |
| Téléphone portable | `telephone` | oui |
| Adresse e-mail | `email` | oui |
| Nombre de salariés | `salaries` | oui |
| Centres d'intérêt (7 cases) | `interet` (multiple) | au moins une |
| Dernier bilan comptable | `bilan` (fichier) | **non — facultatif** |
| Identifiant commercial | `commercial` (hidden) | rempli depuis `?c=` dans l'URL |
| Piège anti-robot | `bot-field` (hidden) | doit rester vide |

---

## 3. Objectif de la mission

Remplacer Netlify Forms par un **backend qu'on héberge**, avec ces gains attendus, par ordre d'importance :

1. **Le PDF arrive en vraie pièce jointe** dans Gmail, plus en lien.
2. **Zéro perte silencieuse.** Aujourd'hui, un envoi peut disparaître sans trace (voir §5). Le nouveau système doit soit confirmer la réception, soit afficher une erreur — jamais afficher un succès sans avoir enregistré.
3. **Le mail n'est plus l'unique copie.** Chaque soumission est persistée côté serveur (fichier + enregistrement), consultable même si un mail se perd.
4. **Plus de limite à 8 Mo** imposée par Netlify.

Le reste du site (démos, simulateur) est statique et doit continuer à être servi tel quel.

---

## 4. Contraintes dures

- **Les URL des démos ne doivent pas changer.** `/tableau-de-bord/`, `/audit-juridique/`, `/optimisation-ik-karim/`, `/simulateur-cfa-adultes/`. Le dirigeant de l'entreprise a déjà diffusé ces liens. Une 404 sur l'une d'elles est un échec de la mission.
- **Aucun lien ne doit mener du formulaire vers les démos.** Un prospect ne doit pas pouvoir découvrir les pages internes depuis le formulaire. L'inverse (bouton de démo vers le formulaire) est en place et doit rester.
- **`noindex` partout** + `robots.txt` en `Disallow: /`. Rien de ce site n'a vocation à être indexé.
- **Le design ne change pas.** Les pages partagent un système de tokens CSS (navy `#16305C`, blue `#2A5FBF`, Inter + Poppins, `--shadow: none`, coins à 14px). Le formulaire a été aligné dessus. Ne propose pas de refonte visuelle.
- **Données sensibles.** Des bilans comptables et des coordonnées de dirigeants. Prévoir une durée de rétention, une purge, et pas de stockage en clair accessible publiquement.

---

## 5. Pièges déjà rencontrés — ne pas les réintroduire

Cette section est le vrai contenu de ce brief. Chacun de ces points a coûté une session de débogage.

1. **`mailto:` ne peut pas joindre de fichier.** La toute première version du formulaire ouvrait le client mail du prospect en lui demandant de glisser lui-même le PDF. C'est une limite du protocole, pas un bug contournable. Le fichier doit passer par une requête HTTP vers un serveur.

2. **Un `<input type="file" required>` masqué en CSS casse la soumission sans message.** Chrome refuse de soumettre et affiche en console « An invalid form control is not focusable », sans rien montrer à l'utilisateur. Le formulaire actuel utilise une zone de dépôt stylée avec l'input réellement masqué : la validation du fichier se fait donc en JavaScript, jamais via l'attribut `required`. Conserve ce principe.

3. **Le champ piège anti-robot peut être rempli par l'autoremplissage du navigateur.** Il était masqué par `position:absolute; left:-9999px`, et Safari/Chrome le remplissaient parfois automatiquement. Netlify jetait alors la soumission **en silence** tout en affichant la page de confirmation. Symptôme vécu : « il a vu la page merci, on n'a rien reçu ». Il est désormais en `display:none`, `tabindex="-1"`, `autocomplete="off"`. Garde ces trois protections, et côté serveur **journalise** les rejets anti-robot au lieu de les jeter silencieusement.

4. **Netlify n'envoie pas de notification pour une soumission classée spam.** Elle est conservée mais invisible dans la boîte mail. Sur le nouveau serveur, il ne doit exister aucun chemin où une soumission est acceptée sans générer d'alerte.

5. **La page de confirmation ne prouve rien aujourd'hui.** Elle s'affiche parce que le serveur a répondu par une redirection, pas parce que les données sont sauvegardées. Sur la nouvelle version, l'écran de succès ne doit s'afficher **qu'après** une réponse serveur confirmant l'écriture sur disque et la mise en file du mail.

6. **Les champs doivent avoir un `name`, pas seulement un `id`.** La version d'origine n'avait que des `id` : aucune donnée n'aurait été transmise, quel que soit le backend.

7. **Ne pas faire confiance à `window.storage`.** Le simulateur (`/simulateur-cfa-adultes/`) écrit ses leads dans `localStorage` tout en affichant « Dossier transmis — le CFA vous rappelle ». Rien n'est transmis nulle part. Ne réutilise pas ce motif, et ne considère pas ce fichier comme un exemple à suivre.

---

## 6. Architecture cible proposée

À confirmer, mais voici la direction recommandée. Si tu diverges, explique pourquoi.

- **Node.js + Fastify** (ou Express), servant :
  - les fichiers statiques du zip aux mêmes chemins qu'aujourd'hui,
  - un endpoint `POST /api/lead` en `multipart/form-data`.
- **Upload** : `@fastify/multipart` (ou `multer`). Limite à 20 Mo, un seul fichier, types acceptés `application/pdf`, `image/jpeg`, `image/png`, `image/heic`. Vérifier le type réel par les octets d'en-tête, pas seulement par l'extension déclarée.
- **Persistance** : le fichier sur disque sous un nom généré (jamais le nom d'origine tel quel), et un enregistrement en **SQLite** avec tous les champs + horodatage + IP + identifiant commercial.
- **Envoi du mail** : **Nodemailer**. Destination `contact@vsmcfa.com`, `replyTo` = l'e-mail du garage saisi dans le formulaire, sujet `Nouveau lead — {garage}`, PDF en pièce jointe réelle. Deux options pour le transport, à trancher avec le client :
  - SMTP Google Workspace avec mot de passe d'application (gratuit, limites d'envoi quotidiennes, suffisant ici) ;
  - un service transactionnel (Resend, Brevo) avec le domaine `vsmcfa.com` vérifié — meilleure délivrabilité, journal des envois, nécessite un accès DNS.
- **Robustesse de l'envoi** : si le mail échoue, la soumission est **déjà enregistrée** et l'utilisateur voit quand même un succès. Prévoir une file de reprise simple et une alerte en cas d'échec répété.
- **Anti-abus** : champ piège + contrôle du temps de remplissage (rejet sous 3 secondes) + limitation de débit par IP. Pas de captcha, il ferait chuter le taux de complétion.
- **Écran d'administration** protégé par mot de passe, listant les soumissions avec téléchargement du PDF et export CSV. Le client avait renoncé à cette idée faute de temps ; sur un serveur qu'on maîtrise elle devient quasi gratuite, et c'est le filet de sécurité qui manque aujourd'hui.
- **HTTPS obligatoire**, reverse proxy (Caddy conseillé pour la simplicité des certificats).

---

## 7. Changement fonctionnel demandé

**Le bilan comptable devient facultatif.** C'était le plus gros point d'abandon du formulaire : beaucoup de dirigeants remplissent tout puis bloquent sur la demande de document.

- Retirer l'astérisque et la validation JavaScript sur ce champ.
- Ajouter une mention du type « Facultatif — vous pouvez nous l'envoyer plus tard ».
- Côté mail, indiquer explicitement **« Aucun bilan joint »** quand il n'y en a pas, pour que l'équipe sache qu'il faut le réclamer au rappel.
- Côté base, un booléen `bilan_fourni` pour pouvoir mesurer le taux de pièces jointes.

*(Ce changement est déjà appliqué dans le zip joint, côté front. Reporte-le dans la nouvelle version.)*

---

## 8. Décisions à faire confirmer avant de coder

Pose ces trois questions, ne devine pas :

1. **Où héberge-t-on ?** VPS existant, nouveau VPS, ou plateforme managée ? Cela conditionne le déploiement et la persistance des fichiers.
2. **Quel nom de domaine ?** Un sous-domaine de `vsmcfa.com` est préférable à une URL générique : ça rassure un garagiste à qui on demande son bilan comptable.
3. **Quel transport mail**, SMTP Google Workspace ou service transactionnel ? A-t-on accès aux DNS de `vsmcfa.com` ?

---

## 9. Critères de validation

La mission est terminée quand tout ceci est vrai :

- [ ] Les quatre URL internes répondent exactement comme avant, au même chemin.
- [ ] Un envoi complet avec PDF de 12 Mo aboutit ; le mail arrive avec le PDF **en pièce jointe**.
- [ ] Un envoi **sans** bilan aboutit ; le mail indique clairement qu'aucun bilan n'est joint.
- [ ] Un envoi avec le champ piège rempli est rejeté **et journalisé**.
- [ ] Couper le réseau pendant l'envoi affiche une erreur explicite, les données saisies restent dans le formulaire, et rien ne prétend avoir réussi.
- [ ] Un fichier `.exe` renommé en `.pdf` est refusé.
- [ ] Si le serveur mail est injoignable, la soumission apparaît quand même dans l'écran d'administration.
- [ ] `?c=DUPONT` sur le formulaire se retrouve dans le mail et en base.
- [ ] `Répondre` dans Gmail vise l'adresse du garage, pas le serveur.
- [ ] Aucune page ne renvoie vers les démos depuis le formulaire.

---

## 10. Hors périmètre pour l'instant

Le simulateur `/simulateur-cfa-adultes/` a les mêmes défauts que le formulaire d'origine : ses leads restent dans le navigateur, son écran de confirmation ment, et son panneau de paramètres n'est protégé par aucun code par défaut. **Ne le refais pas dans cette mission**, mais signale-le et propose un chiffrage séparé : le brancher sur le même endpoint `POST /api/lead` serait une extension naturelle une fois le backend en place.
