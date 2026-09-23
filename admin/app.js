/* ------------------------------------------------------------------------
   ATLAS — console de consultation des réponses.

   Aucune clé, aucun secret dans ce fichier : il est public, comme toute page
   servie par Netlify. Le mot de passe est vérifié par l'Edge Function, qui
   renvoie un jeton de session signé, valable 8 h. Sans ce jeton, aucune donnée
   n'est accessible — les tables Supabase sont en RLS sans policy.
------------------------------------------------------------------------- */

// ⚠️ À REMPLACER par l'URL de votre projet Supabase (cf. README).
var API = 'https://lioymgigpojlqzrggkff.supabase.co/functions/v1/admin';

// sessionStorage et non localStorage : la session tombe à la fermeture de
// l'onglet. Sur un téléphone posé sur un comptoir, ça compte.
var CLE = 'atlas-admin-jeton';

var etat = { jeton: null, jetonLead: null, page: 0, total: 0, recherche: '', aTraiter: false, leads: [] };
var minuteur = null;

var $ = function(id){ return document.getElementById(id); };

/* ------------------------------------------------------------ transport */

function appel(route, corps){
  return fetch(API + '/' + route, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(corps || {})
  }).then(function(r){
    if(r.status === 401 && route !== 'session'){ deconnecter('Session expirée.'); throw { silencieux: true }; }
    return r.json().catch(function(){ return {}; }).then(function(d){
      if(!r.ok) throw { message: d.erreur || 'Erreur ' + r.status };
      return d;
    });
  });
}

/* ------------------------------------------------------------ connexion */

$('loginForm').addEventListener('submit', function(e){
  e.preventDefault();
  var btn = $('loginBtn'), err = $('loginError');
  err.style.display = 'none';
  btn.disabled = true; btn.textContent = 'Vérification…';

  appel('session', { motdepasse: $('mdp').value })
    .then(function(d){
      try { sessionStorage.setItem(CLE, JSON.stringify(d)); } catch(_){ /* navigation privée */ }
      ouvrir(d);
    })
    .catch(function(ex){
      err.textContent = (ex && ex.message) ||
        'Connexion impossible. Vérifiez votre réseau et réessayez.';
      err.style.display = 'block';
      $('mdp').value = ''; $('mdp').focus();
    })
    .finally(function(){ btn.disabled = false; btn.textContent = 'Ouvrir'; });
});

function ouvrir(session){
  etat.jeton = session.jeton;
  $('gate').style.display = 'none';
  $('entete').style.display = 'block';
  $('console').style.display = 'block';
  $('liensBtn').style.display = '';
  $('expire').textContent = 'Session jusqu’à ' +
    new Date(session.expire_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  charger();
}

function deconnecter(motif){
  try { sessionStorage.removeItem(CLE); } catch(_){}
  etat.jeton = null;
  etat.jetonLead = null;
  $('exportBtn').style.display = '';
  $('liensBtn').style.display = '';
  $('liens').style.display = 'none';
  $('liensBtn').textContent = 'Liens';
  $('logoutBtn').textContent = 'Déconnexion';
  $('logoutBtn').className = 'lien-discret';
  fermerPanneau();
  $('entete').style.display = 'none';
  $('console').style.display = 'none';
  $('gate').style.display = 'block';
  if(motif){ $('loginError').textContent = motif; $('loginError').style.display = 'block'; }
  $('mdp').value = '';
}

$('logoutBtn').addEventListener('click', function(){ deconnecter(null); });

/* ------------------------------------------------------------- affichage */

function dateCourte(iso){
  var d = new Date(iso);
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit' }) +
    ' ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

/* Tout texte venant de la base est inséré par textContent, jamais par
   innerHTML : un nom de garage contenant du HTML ne doit rien pouvoir faire. */
function cell(texte, classe){
  var td = document.createElement('td');
  if(classe) td.className = classe;
  td.textContent = texte == null ? '' : String(texte);
  return td;
}
function tag(texte, classe){
  var s = document.createElement('span');
  s.className = 'tag ' + classe;
  s.textContent = texte;
  var td = document.createElement('td');
  td.appendChild(s);
  return td;
}

function charger(){
  appel('leads', {
    jeton: etat.jeton, page: etat.page,
    recherche: etat.recherche, a_traiter: etat.aTraiter
  }).then(function(d){
    etat.leads = d.leads; etat.total = d.total;
    dessiner(d);
  }).catch(function(ex){
    if(ex && ex.silencieux) return;
    $('vide').textContent = (ex && ex.message) || 'Chargement impossible.';
    $('vide').style.display = 'block';
  });
}

function dessiner(d){
  var tbody = $('lignes');
  tbody.textContent = '';

  $('compteur').textContent = d.total === 0 ? '' :
    d.total + (d.total > 1 ? ' réponses' : ' réponse');

  if(!d.leads.length){
    $('vide').textContent = etat.recherche || etat.aTraiter
      ? 'Aucune réponse ne correspond.'
      : 'Aucune réponse pour l’instant.';
    $('vide').style.display = 'block';
  } else {
    $('vide').style.display = 'none';
  }

  d.leads.forEach(function(l){
    var tr = document.createElement('tr');
    var ref = cell(l.reference); ref.className = 'ref nowrap';
    tr.appendChild(ref);
    tr.appendChild(cell(dateCourte(l.created_at), 'nowrap muted'));
    tr.appendChild(cell(l.garage));
    tr.appendChild(cell(l.dirigeant, 'opt'));
    tr.appendChild(cell(l.telephone, 'opt nowrap'));
    tr.appendChild(l.bilan_fourni ? tag('joint', 'ok') : tag('aucun', 'no'));
    tr.appendChild(cell(l.commercial || '—', 'opt muted'));
    tr.appendChild(
      l.mail_statut === 'envoye' ? tag('parti', 'ok')
      : l.mail_statut === 'echec' ? tag('échec', 'no')
      : tag('en attente', 'wait'));
    tr.addEventListener('click', function(){ detail(l); });
    tbody.appendChild(tr);
  });

  var pages = Math.ceil(d.total / d.parPage);
  $('prec').style.display = etat.page > 0 ? 'inline-flex' : 'none';
  $('suiv').style.display = etat.page + 1 < pages ? 'inline-flex' : 'none';
}

/* --------------------------------------------------------------- détail */

function ligne(dl, cle, valeur){
  var dt = document.createElement('dt'); dt.textContent = cle;
  var dd = document.createElement('dd');
  if(valeur && valeur.href){
    var a = document.createElement('a');
    a.href = valeur.href; a.textContent = valeur.texte; dd.appendChild(a);
  } else {
    dd.textContent = valeur || '—';
  }
  dl.appendChild(dt); dl.appendChild(dd);
}

function detail(l){
  var p = $('panel');
  p.textContent = '';

  var close = document.createElement('button');
  close.className = 'close'; close.textContent = '×';
  close.setAttribute('aria-label', 'Fermer');
  close.addEventListener('click', fermerPanneau);
  p.appendChild(close);

  var h2 = document.createElement('h2'); h2.textContent = l.garage; p.appendChild(h2);
  var sub = document.createElement('p');
  sub.className = 'muted';
  sub.textContent = 'Référence ' + l.reference + ' · reçu le ' + dateCourte(l.created_at);
  p.appendChild(sub);

  var dl = document.createElement('dl'); dl.className = 'kv';
  ligne(dl, 'Dirigeant', l.dirigeant);
  ligne(dl, 'Téléphone', { href: 'tel:' + String(l.telephone).replace(/\s/g, ''), texte: l.telephone });
  ligne(dl, 'E-mail', { href: 'mailto:' + l.email, texte: l.email });
  ligne(dl, 'Salariés', String(l.salaries));
  ligne(dl, 'Commercial', l.commercial);
  p.appendChild(dl);

  var h3 = document.createElement('h3'); h3.textContent = 'CENTRES D’INTÉRÊT'; p.appendChild(h3);
  var ul = document.createElement('ul');
  (l.interets || []).forEach(function(i){
    var li = document.createElement('li'); li.textContent = i; ul.appendChild(li);
  });
  p.appendChild(ul);

  var h3b = document.createElement('h3'); h3b.textContent = 'BILAN COMPTABLE'; p.appendChild(h3b);
  if(l.bilan_fourni){
    var box = document.createElement('div'); box.className = 'box ok';
    var nom = document.createElement('div');
    nom.textContent = l.bilan_nom_origine || 'bilan';
    box.appendChild(nom);
    var dl2 = document.createElement('button');
    dl2.className = 'btn small'; dl2.textContent = 'Télécharger';
    dl2.style.marginTop = '10px';
    dl2.addEventListener('click', function(){
      dl2.disabled = true; dl2.textContent = 'Préparation…';
      appel('bilan', { jeton: etat.jeton, jeton_lead: etat.jetonLead, id: l.id })
        .then(function(d){ window.location.href = d.url; })
        .catch(function(ex){ if(!(ex && ex.silencieux)) alert((ex && ex.message) || 'Téléchargement impossible.'); })
        .finally(function(){ dl2.disabled = false; dl2.textContent = 'Télécharger'; });
    });
    box.appendChild(dl2);
    p.appendChild(box);
  } else {
    var no = document.createElement('div'); no.className = 'box no';
    no.textContent = 'Aucun bilan joint.';
    p.appendChild(no);
  }

  if(l.mail_statut !== 'envoye'){
    var w = document.createElement('div');
    w.className = 'box warn'; w.style.marginTop = '14px';
    w.textContent = l.mail_statut === 'echec'
      ? 'La notification par e-mail n’est pas partie. La réponse est bien enregistrée ici. Dernière erreur : ' + (l.mail_erreur || 'inconnue')
      : 'Notification en attente d’envoi.';
    p.appendChild(w);
  }

  var pdf = document.createElement('button');
  pdf.className = 'btn small';
  pdf.textContent = 'Fiche PDF';
  pdf.style.marginTop = '22px';
  pdf.addEventListener('click', function(){ imprimer(l); });
  p.appendChild(pdf);

  $('overlay').style.display = 'block';
  p.style.display = 'block';
}

/* ---------------------------------------------------------- fiche PDF */

/* Pas de bibliothèque : on remplit une fiche cachée, mise en page par la
   feuille d'impression, et on laisse le navigateur produire le PDF. Le texte
   reste vectoriel et sélectionnable, et il n'y a rien à maintenir. */
function imprimer(l){
  var f = $('fiche');
  f.textContent = '';

  var ajout = function(parent, balise, texte, classe){
    var e = document.createElement(balise);
    if(classe) e.className = classe;
    if(texte != null) e.textContent = texte;
    parent.appendChild(e);
    return e;
  };

  var tete = ajout(f, 'div', null, 'f-tete');
  var logo = ajout(tete, 'div', null, 'f-logo');
  logo.appendChild(document.createTextNode('ATLAS'));
  ajout(logo, 'span', '.');
  ajout(tete, 'div', 'ATLAS × Etchecom — Comptabilité réservée aux garagistes', 'f-marque');

  ajout(f, 'h1', l.garage);
  ajout(f, 'div', 'Référence ' + l.reference + ' · réponse reçue le ' + dateLongue(l.created_at), 'f-sous');

  ajout(f, 'h2', 'Contact');
  var dl = document.createElement('dl');
  var paire = function(cle, valeur){
    ajout(dl, 'dt', cle);
    ajout(dl, 'dd', valeur || '—');
  };
  paire('Dirigeant', l.dirigeant);
  paire('Téléphone', l.telephone);
  paire('E-mail', l.email);
  paire('Nombre de salariés', String(l.salaries));
  paire('Commercial', l.commercial);
  f.appendChild(dl);

  ajout(f, 'h2', 'Centres d\u2019intérêt');
  var ul = document.createElement('ul');
  (l.interets || []).forEach(function(i){ ajout(ul, 'li', i); });
  f.appendChild(ul);

  ajout(f, 'h2', 'Bilan comptable');
  ajout(f, 'div', l.bilan_fourni
    ? 'Bilan joint — ' + (l.bilan_nom_origine || 'document')
    : 'Aucun bilan joint.', 'f-bilan');

  ajout(f, 'div', 'Document interne VSM — coordonnées de dirigeant et données comptables. ' +
    'Édité le ' + dateLongue(new Date().toISOString()) + '.', 'f-pied');

  window.print();
}

function dateLongue(iso){
  return new Date(iso).toLocaleDateString('fr-FR', {
    day: 'numeric', month: 'long', year: 'numeric'
  }) + ' à ' + new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

function fermerPanneau(){
  $('panel').style.display = 'none';
  $('overlay').style.display = 'none';
  // Arrivé par le lien d'un mail : il n'y a pas de liste derrière, on propose
  // d'ouvrir la console complète plutôt que de laisser un écran vide.
  if(etat.jetonLead && !etat.jeton) deconnecter(null);
}
$('overlay').addEventListener('click', fermerPanneau);
document.addEventListener('keydown', function(e){ if(e.key === 'Escape') fermerPanneau(); });

/* ----------------------------------------------------- recherche, pages */

$('recherche').addEventListener('input', function(e){
  clearTimeout(minuteur);
  minuteur = setTimeout(function(){
    etat.recherche = e.target.value.trim();
    etat.page = 0;
    charger();
  }, 280);
});

$('filtreTraiter').addEventListener('click', function(){
  etat.aTraiter = !etat.aTraiter;
  $('filtreTraiter').classList.toggle('on', etat.aTraiter);
  etat.page = 0;
  charger();
});

$('prec').addEventListener('click', function(){ etat.page--; charger(); window.scrollTo(0, 0); });
$('suiv').addEventListener('click', function(){ etat.page++; charger(); window.scrollTo(0, 0); });

/* L'export passe par la fonction, qui renvoie le CSV : le jeton ne doit pas
   se retrouver dans une URL (historique du navigateur, journaux serveur). */
$('exportBtn').addEventListener('click', function(){
  var b = $('exportBtn');
  b.disabled = true; b.textContent = 'Export…';
  fetch(API + '/export', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jeton: etat.jeton })
  }).then(function(r){
    if(r.status === 401){ deconnecter('Session expirée.'); return null; }
    if(!r.ok) throw new Error('export');
    return r.blob();
  }).then(function(blob){
    if(!blob) return;
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'atlas-leads-' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
    URL.revokeObjectURL(url);
  }).catch(function(){
    alert('Export impossible. Réessayez dans un instant.');
  }).finally(function(){
    b.disabled = false; b.textContent = 'Export CSV';
  });
});

/* --------------------------------- ouverture directe depuis un lien de mail */

/* Le mail de notification porte ?r=<jeton>. Ce jeton n'ouvre QUE la fiche
   concernée : la liste complète reste derrière le mot de passe. */
var jetonMail = new URLSearchParams(window.location.search).get('r');
if(jetonMail){
  etat.jetonLead = jetonMail;
  // L'URL est nettoyée tout de suite : le jeton ne doit pas rester dans la
  // barre d'adresse, l'historique, ni partir en Referer.
  history.replaceState(null, '', window.location.pathname);

  $('gate').style.display = 'none';
  appel('reponse', { jeton_lead: jetonMail })
    .then(function(d){
      $('entete').style.display = 'block';
      $('expire').textContent = 'Réponse ouverte depuis votre e-mail';
      $('exportBtn').style.display = 'none';
      $('liensBtn').style.display = 'none';
      $('logoutBtn').textContent = 'Voir toutes les réponses';
      $('logoutBtn').className = 'btn ghost';
      detail(d.lead);
    })
    .catch(function(ex){
      if(ex && ex.silencieux) return;
      $('gate').style.display = 'block';
      $('loginError').textContent = (ex && ex.message) ||
        'Ce lien n\u2019a pas pu être ouvert. Connectez-vous pour retrouver la réponse.';
      $('loginError').style.display = 'block';
    });
}

/* ------------------------------------------------------ page des liens */

/* Réservée à une vraie session : un jeton de mail n'ouvre qu'une fiche et ne
   doit pas donner les accès techniques. Le bouton reste donc caché dans ce cas. */
function basculerLiens(){
  var ouverte = $('liens').style.display === 'block';
  $('liens').style.display = ouverte ? 'none' : 'block';
  $('console').style.display = ouverte ? 'block' : 'none';
  $('liensBtn').textContent = ouverte ? 'Liens' : 'Retour aux réponses';
  window.scrollTo(0, 0);
}
$('liensBtn').addEventListener('click', basculerLiens);

function copier(texte, bouton){
  var fini = function(){
    var avant = bouton.textContent;
    bouton.textContent = 'Copié';
    bouton.classList.add('fait');
    setTimeout(function(){ bouton.textContent = avant; bouton.classList.remove('fait'); }, 1600);
  };
  // navigator.clipboard exige HTTPS ; on garde un repli pour http://localhost
  // et les navigateurs anciens.
  if(navigator.clipboard && window.isSecureContext){
    navigator.clipboard.writeText(texte).then(fini, function(){ replique(texte, fini); });
  } else {
    replique(texte, fini);
  }
}
function replique(texte, fini){
  var z = document.createElement('textarea');
  z.value = texte;
  z.style.position = 'fixed'; z.style.opacity = '0';
  document.body.appendChild(z);
  z.select();
  try { document.execCommand('copy'); fini(); } catch(_){ window.prompt('Copiez ce lien :', texte); }
  document.body.removeChild(z);
}

Array.prototype.forEach.call(document.querySelectorAll('[data-copier]'), function(b){
  b.addEventListener('click', function(){ copier(b.getAttribute('data-copier'), b); });
});

/* Générateur du lien commercial : c'est le geste le plus fréquent. */
var BASE_FORMULAIRE = 'https://cabinet-atlas-link.netlify.app';
function lienCommercial(){
  var c = $('genCommercial').value.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
  return c ? BASE_FORMULAIRE + '/?c=' + encodeURIComponent(c) : BASE_FORMULAIRE;
}
function rafraichirApercu(){
  $('genApercu').textContent = lienCommercial();
}
$('genCommercial').addEventListener('input', rafraichirApercu);
$('genCopier').addEventListener('click', function(){ copier(lienCommercial(), $('genCopier')); });
rafraichirApercu();

/* --------------------------------------------- reprise de session ouverte */

try {
  var brut = jetonMail ? null : sessionStorage.getItem(CLE);
  if(brut){
    var s = JSON.parse(brut);
    if(s && s.jeton && new Date(s.expire_at) > new Date()) ouvrir(s);
    else sessionStorage.removeItem(CLE);
  }
} catch(_){ /* navigation privée, stockage bloqué : on reste sur l'écran de connexion */ }
