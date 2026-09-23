// ─────────────────────────────────────────────────────────────────────────
// ATLAS — fonction « lead », version autonome (un seul fichier).
// GÉNÉRÉ AUTOMATIQUEMENT : ne pas modifier ici.
// Source : supabase/functions/lead/  ·  Régénérer : node supabase/grouper.mjs
// À coller dans Dashboard > Edge Functions, qui ne sait pas charger _partage/.
// ─────────────────────────────────────────────────────────────────────────

import { SupabaseClient, createClient } from "jsr:@supabase/supabase-js@2.116.0";

// Helpers partagés par les Edge Functions ATLAS.

const BUCKET = "bilans";

function admin(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}

/* ------------------------------------------------------------------ CORS */

function originesAutorisees(): string[] {
  return (Deno.env.get("ORIGINES_AUTORISEES") ?? "")
    .split(",").map((o) => o.trim()).filter(Boolean);
}

function cors(req: Request): Record<string, string> {
  const origine = req.headers.get("origin") ?? "";
  const liste = originesAutorisees();
  const autorisee = liste.length === 0 || liste.includes(origine);
  return {
    "access-control-allow-origin": autorisee && origine ? origine : (liste[0] ?? "*"),
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-max-age": "86400",
    "vary": "origin",
  };
}

function json(req: Request, corps: unknown, status = 200): Response {
  return new Response(JSON.stringify(corps), {
    status,
    headers: { ...cors(req), "content-type": "application/json; charset=utf-8" },
  });
}

/* -------------------------------------------------------------- requête */

function ipDe(req: Request): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("cf-connecting-ip") ?? null;
}

/* ------------------------------------------- signature HMAC d'un chemin */
// Empêche un client d'associer à son lead un objet du Storage qu'il n'a pas
// lui-même obtenu via /upload-url.

function cleSecrete(): ArrayBuffer {
  const s = Deno.env.get("ATLAS_SECRET");
  if (!s) throw new Error("ATLAS_SECRET manquant");
  return new TextEncoder().encode(s).buffer as ArrayBuffer;
}

async function signer(valeur: string): Promise<string> {
  const cle = await crypto.subtle.importKey(
    "raw", cleSecrete(), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cle, new TextEncoder().encode(valeur).buffer as ArrayBuffer);
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function signatureValide(valeur: string, signature: string): Promise<boolean> {
  const attendue = await signer(valeur);
  if (attendue.length !== signature.length) return false;
  let diff = 0;                                   // comparaison à temps constant
  for (let i = 0; i < attendue.length; i++) diff |= attendue.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

/* --------------------------------------------- type réel par les octets */
// §6 du brief : vérifier le type réel, pas l'extension déclarée.
// Un .exe renommé .pdf n'a pas la signature %PDF- et est refusé.

const TYPES_ACCEPTES = {
  "application/pdf": ".pdf",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/heic": ".heic",
  "image/heif": ".heic",
} as const;

type TypeAccepte = keyof typeof TYPES_ACCEPTES;

function detecterType(o: Uint8Array): TypeAccepte | null {
  const a = (i: number, ...oct: number[]) => oct.every((v, k) => o[i + k] === v);

  if (a(0, 0x25, 0x50, 0x44, 0x46, 0x2d)) return "application/pdf";   // %PDF-
  if (a(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (a(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";

  // HEIC/HEIF : boîte ISO-BMFF "ftyp" en octets 4..8, marque en 8..12
  if (a(4, 0x66, 0x74, 0x79, 0x70)) {
    const marque = new TextDecoder().decode(o.slice(8, 12));
    if (["heic", "heix", "hevc", "heim", "heis", "hevm", "hevs", "mif1", "msf1"].includes(marque)) {
      return "image/heic";
    }
  }
  return null;
}

/* ------------------------------------------------------------- journaux */

async function journaliserRejet(
  sb: SupabaseClient,
  motif: string,
  detail: string,
  req: Request,
  charge: unknown = null,
) {
  console.warn(`[rejet] ${motif} — ${detail}`);
  await sb.from("rejets").insert({
    motif, detail,
    ip: ipDe(req),
    user_agent: req.headers.get("user-agent"),
    charge,
  });
}

async function alerter(
  sb: SupabaseClient,
  niveau: "info" | "avertissement" | "critique",
  sujet: string,
  detail: string,
  leadId: string | null = null,
) {
  console.error(`[alerte:${niveau}] ${sujet} — ${detail}`);
  await sb.from("alertes").insert({ niveau, sujet, detail, lead_id: leadId });

  const webhook = Deno.env.get("ALERTE_WEBHOOK_URL");
  if (!webhook) return;
  try {
    await fetch(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: `ATLAS [${niveau}] ${sujet}\n${detail}` }),
    });
  } catch (e) {
    console.error("webhook d'alerte injoignable", e);
  }
}

/* --------------------------------------------------------- rate limiting */

async function limiteDebitDepassee(
  sb: SupabaseClient, req: Request, route: string, max: number, fenetreMin = 10,
): Promise<boolean> {
  const ip = ipDe(req);
  if (!ip) return false;
  // La route fait partie de la clé : le trafic du formulaire ne doit pas
  // pouvoir fermer la porte de la console d'administration.
  const { data, error } = await sb.rpc("compter_hits", {
    p_ip: ip, p_route: route, p_fenetre_minutes: fenetreMin,
  });
  if (error) { console.error("compter_hits", error); return false; }  // en cas de doute, on laisse passer

  const depasse = (data as number) >= max;
  // On n'enregistre PAS les requêtes déjà refusées : sinon chaque nouvel essai
  // repousse la fenêtre, et quelqu'un qui réessaie reste bloqué pour toujours.
  // Le refus, lui, part dans la table « rejets » par l'appelant.
  if (!depasse) await sb.from("hits").insert({ ip, route });
  return depasse;
}

// Envoi de la notification de lead via l'API transactionnelle Brevo.

// Le bilan n'est PAS mis en pièce jointe : il est hébergé sur Supabase Storage
// (bucket privé) et le mail porte une URL signée à durée limitée. Conséquences
// voulues : aucune limite de taille côté Brevo, et le fichier ne se duplique pas
// dans des boîtes mail que l'on ne maîtrise pas.
// Basculer MAIL_MODE_BILAN=piece_jointe pour revenir à la pièce jointe réelle
// (Brevo plafonne alors aux alentours de 10 Mo).
const MODE_PJ = (Deno.env.get("MAIL_MODE_BILAN") ?? "lien") === "piece_jointe";
const PJ_MAX = Number(Deno.env.get("MAIL_PJ_MAX_OCTETS") ?? 9 * 1024 * 1024);
// Les bilans sont conservés indéfiniment (décision dirigeant) : le lien du mail
// doit rester utile longtemps. Le fichier, lui, reste dans Supabase même après
// expiration du lien — on le retrouve alors par sa référence.
const LIEN_JOURS = Number(Deno.env.get("LIEN_BILAN_JOURS") ?? 365);

// Console de consultation. Le mail ne déroule plus les réponses : il annonce,
// et renvoie vers la fiche. Moins de données personnelles recopiées dans des
// boîtes mail, et une seule source de vérité.
const CONSOLE_URL = (Deno.env.get("ADMIN_URL") ?? "").replace(/\/+$/, "");
// Durée de validité du lien direct contenu dans le mail.
const JETON_JOURS = Number(Deno.env.get("JETON_LEAD_JOURS") ?? 30);

/** Jeton signé donnant accès à UNE fiche, et à elle seule. */
async function jetonLead(id: string): Promise<string> {
  const expire = Date.now() + JETON_JOURS * 86400_000;
  return `${id}.${expire}.${await signer(`lead:${id}:${expire}`)}`;
}

type Lead = {
  id: string;
  reference: string;
  garage: string;
  dirigeant: string;
  telephone: string;
  email: string;
  salaries: number;
  interets: string[];
  bilan_fourni: boolean;
  bilan_chemin: string | null;
  bilan_nom_origine: string | null;
  bilan_taille: number | null;
  bilan_type: string | null;
  commercial: string | null;
  created_at: string;
};

const echapper = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function base64(octets: Uint8Array): string {
  let bin = "";
  const pas = 0x8000;
  for (let i = 0; i < octets.length; i += pas) {
    bin += String.fromCharCode(...octets.subarray(i, i + pas));
  }
  return btoa(bin);
}

const encadre = (couleur: string, texte: string) =>
  `<p style="background:${couleur};border-radius:10px;padding:12px 14px;font-size:14px;color:#202B3D;margin:0;line-height:1.6">${texte}</p>`;

function corpsHtml(l: Lead, bilan: string, lien: string): string {
  const fait = (k: string, v: string) =>
    `<tr><td style="padding:5px 14px 5px 0;color:#66707F;font-size:13px;white-space:nowrap">${k}</td>` +
    `<td style="padding:5px 0;color:#202B3D;font-size:14px;font-weight:600">${v}</td></tr>`;

  const bouton = lien
    ? `<table cellpadding="0" cellspacing="0" style="margin:22px 0"><tr><td style="border-radius:100px;background:#2A5FBF">
         <a href="${lien}" style="display:inline-block;padding:14px 30px;font-family:-apple-system,Segoe UI,Inter,sans-serif;
            font-size:15px;font-weight:600;color:#FFFFFF;text-decoration:none">Consulter la réponse →</a>
       </td></tr></table>
       <p style="color:#66707F;font-size:12px;margin:0 0 4px">Ce lien ouvre directement la fiche du garage. Il expire dans ${JETON_JOURS} jours.</p>`
    : `<p style="background:#FDF6E3;border-radius:10px;padding:12px 14px;font-size:13px;color:#B7791F;margin:22px 0">
         La console de consultation n'est pas configurée (variable <b>ADMIN_URL</b> absente) : le lien direct manque.</p>`;

  return `<div style="font-family:-apple-system,Segoe UI,Inter,sans-serif;max-width:560px">
  <p style="color:#66707F;font-size:13px;margin:0 0 6px">ATLAS Cabinet — formulaire garage</p>
  <h2 style="color:#16305C;font-size:20px;margin:0 0 18px">Nouvelle réponse de ${echapper(l.garage)}</h2>

  <table style="border-collapse:collapse">
    ${fait("Dirigeant", echapper(l.dirigeant))}
    ${fait("Téléphone", `<a href="tel:${echapper(l.telephone.replace(/\s/g, ""))}" style="color:#2A5FBF">${echapper(l.telephone)}</a>`)}
    ${fait("Reçu le", new Date(l.created_at).toLocaleString("fr-FR", { timeZone: "Europe/Paris" }))}
  </table>

  ${bilan}
  ${bouton}

  <p style="color:#66707F;font-size:12px;margin-top:20px;border-top:1px solid #E4E9F1;padding-top:12px">
    Référence ${l.reference}${l.commercial ? ` · commercial ${echapper(l.commercial)}` : ""}<br>
    Répondre à ce message écrit directement au garage (${echapper(l.email)}).
  </p>
</div>`;
}

/**
 * Envoie la notification. Lève une exception en cas d'échec : l'appelant
 * marque alors le lead en `echec` — la soumission reste enregistrée.
 */
async function envoyerNotification(sb: SupabaseClient, l: Lead): Promise<{ pieceJointe: boolean }> {
  const cle = Deno.env.get("BREVO_API_KEY");
  if (!cle) throw new Error("BREVO_API_KEY manquante");

  const destinataire = Deno.env.get("MAIL_DESTINATAIRE") ?? "contact@vsmcfa.com";
  // Même expéditeur que VSM Connect : contact@vsmcfa.com est déjà authentifié
  // (DKIM/DMARC) sur le domaine vsmcfa.com dans Brevo. Rien à faire côté DNS.
  const expediteur = Deno.env.get("MAIL_EXPEDITEUR") ?? "contact@vsmcfa.com";

  const lien = CONSOLE_URL ? `${CONSOLE_URL}/?r=${await jetonLead(l.id)}` : "";

  const pieces: { content: string; name: string }[] = [];
  let bilanHtml: string;
  let pieceJointe = false;

  if (!l.bilan_fourni || !l.bilan_chemin) {
    // §7 du brief : le dire explicitement, pour que l'équipe le réclame au rappel.
    bilanHtml = encadre("#FBEAE8", "⚠️ <b>Aucun bilan joint.</b> À réclamer lors du rappel.");
  } else {
    const mo = ((l.bilan_taille ?? 0) / 1048576).toFixed(1).replace(".", ",");
    const nom = l.bilan_nom_origine ?? `bilan-${l.reference}`;

    if (MODE_PJ && (l.bilan_taille ?? 0) <= PJ_MAX) {
      const { data, error } = await sb.storage.from(BUCKET).download(l.bilan_chemin);
      if (error || !data) throw new Error(`lecture du bilan impossible : ${error?.message}`);
      pieces.push({ content: base64(new Uint8Array(await data.arrayBuffer())), name: nom });
      pieceJointe = true;
      bilanHtml = encadre("#E7F7F0", `📎 <b>${echapper(nom)}</b> — ${mo} Mo, en pièce jointe.`);
    } else if (CONSOLE_URL) {
      // Le téléchargement se fait dans la console : pas d'URL de fichier
      // comptable qui traîne un an dans des boîtes mail.
      bilanHtml = encadre("#E7F7F0", `📎 <b>Bilan joint</b> — ${echapper(nom)}, ${mo} Mo. Téléchargeable depuis la fiche.`);
    } else {
      const { data, error } = await sb.storage.from(BUCKET)
        .createSignedUrl(l.bilan_chemin, LIEN_JOURS * 86400, { download: nom });
      if (error || !data) throw new Error(`URL signée impossible : ${error?.message}`);
      bilanHtml = encadre("#E7F7F0",
        `📄 <b>${echapper(nom)}</b> — ${mo} Mo<br><a href="${data.signedUrl}" style="color:#2A5FBF;font-weight:700">Télécharger le bilan</a>`);
    }
  }

  const reponse = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": cle, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      sender: { name: "ATLAS — Formulaire garage", email: expediteur },
      to: [{ email: destinataire }],
      // §9 : « Répondre » dans Gmail doit viser le garage, pas le serveur.
      replyTo: { email: l.email, name: l.dirigeant },
      // Préfixe fixe : repérable d'un coup d'œil et filtrable dans Gmail.
      subject: `ATLAS Cabinet — Nouvelle réponse de ${l.garage}`,
      htmlContent: corpsHtml(l, bilanHtml, lien),
      tags: ["atlas-lead"],
      ...(pieces.length ? { attachment: pieces } : {}),
    }),
  });

  if (!reponse.ok) {
    throw new Error(`Brevo ${reponse.status} : ${(await reponse.text()).slice(0, 500)}`);
  }
  return { pieceJointe };
}

// POST /functions/v1/lead/upload-url  -> autorise un envoi de fichier direct vers le Storage
// POST /functions/v1/lead             -> enregistre la soumission, puis notifie par mail
//
// Le fichier ne transite PAS par cette fonction : le navigateur l'envoie
// directement au Storage avec une URL signée à usage unique. Aucune limite de
// taille imposée par la fonction, et un PDF de 12 Mo passe sans difficulté.

const TAILLE_MAX = 20 * 1024 * 1024;   // §6 du brief
const REMPLISSAGE_MIN_MS = 3000;       // §6 : rejet sous 3 secondes
const MAX_UPLOADS_10MIN = 20;
const MAX_ENVOIS_10MIN = 8;

const texte = (v: unknown, max: number) =>
  typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, max) : "";

/** Le nom d'origine n'est jamais réutilisé comme chemin : seulement conservé pour l'affichage. */
const assainirNom = (nom: string) =>
  nom.normalize("NFKD").replace(/[^\w.\- ]+/g, "_").replace(/_{2,}/g, "_").slice(0, 120) || "bilan";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== "POST") return json(req, { erreur: "Méthode non autorisée." }, 405);

  const etape = new URL(req.url).pathname.endsWith("/upload-url") ? "upload-url" : "lead";
  try {
    return etape === "upload-url" ? await urlUpload(req) : await enregistrer(req);
  } catch (e) {
    console.error(`[${etape}] exception`, e);
    return json(req, { erreur: "Une erreur est survenue côté serveur. Réessayez dans un instant." }, 500);
  }
});

/* ------------------------------------------------ étape 1 : URL d'upload */

async function urlUpload(req: Request): Promise<Response> {
  const sb = admin();
  const corps = await req.json().catch(() => null);
  if (!corps) return json(req, { erreur: "Requête illisible." }, 400);

  if (await limiteDebitDepassee(sb, req, "upload-url", MAX_UPLOADS_10MIN)) {
    await journaliserRejet(sb, "rate_limit", "trop d'URL d'upload demandées", req);
    return json(req, { erreur: "Trop de tentatives. Patientez quelques minutes." }, 429);
  }

  const taille = Number(corps.taille);
  if (!Number.isFinite(taille) || taille <= 0 || taille > TAILLE_MAX) {
    await journaliserRejet(sb, "taille", `taille annoncée ${taille}`, req, corps);
    return json(req, { erreur: `Le fichier dépasse ${TAILLE_MAX / 1048576} Mo.` }, 413);
  }

  const type = String(corps.type ?? "") as TypeAccepte;
  const extension = TYPES_ACCEPTES[type];
  if (!extension) {
    await journaliserRejet(sb, "type_fichier", `type annoncé « ${corps.type} »`, req, corps);
    return json(req, { erreur: "Format non accepté. Envoyez un PDF ou une photo (JPEG, PNG, HEIC)." }, 415);
  }

  const maintenant = new Date();
  const chemin = `${maintenant.getUTCFullYear()}/${String(maintenant.getUTCMonth() + 1).padStart(2, "0")}/` +
    `${crypto.randomUUID()}${extension}`;

  const { data, error } = await sb.storage.from(BUCKET).createSignedUploadUrl(chemin);
  if (error || !data) {
    console.error("createSignedUploadUrl", error);
    return json(req, { erreur: "Envoi de fichier indisponible. Réessayez dans un instant." }, 502);
  }

  return json(req, {
    chemin,
    url: data.signedUrl,               // URL absolue, valable 2 h, un seul objet
    signature: await signer(chemin),   // réinjectée à l'étape 2, empêche d'associer un objet tiers
  });
}

/* ------------------------------------------- étape 2 : enregistrer le lead */

async function enregistrer(req: Request): Promise<Response> {
  const sb = admin();
  const c = await req.json().catch(() => null);
  if (!c) return json(req, { erreur: "Requête illisible." }, 400);

  // --- pièges anti-robot. §5.3 : journalisés, jamais jetés en silence. -----
  if (texte(c["bot-field"], 200)) {
    await journaliserRejet(sb, "honeypot", `champ piège rempli : « ${texte(c["bot-field"], 80)} »`, req, c);
    return json(req, { erreur: "Envoi refusé. Si vous êtes bien un humain, appelez-nous directement." }, 422);
  }
  const remplissage = Number(c.remplissage_ms);
  if (Number.isFinite(remplissage) && remplissage < REMPLISSAGE_MIN_MS) {
    await journaliserRejet(sb, "trop_rapide", `formulaire rempli en ${remplissage} ms`, req, c);
    return json(req, { erreur: "Envoi refusé. Si vous êtes bien un humain, appelez-nous directement." }, 422);
  }
  if (await limiteDebitDepassee(sb, req, "lead", MAX_ENVOIS_10MIN)) {
    await journaliserRejet(sb, "rate_limit", "trop de soumissions", req, c);
    return json(req, { erreur: "Trop de tentatives. Patientez quelques minutes." }, 429);
  }

  // --- validation des champs ---------------------------------------------
  const garage = texte(c.garage, 200);
  const dirigeant = texte(c.dirigeant, 200);
  const telephone = texte(c.telephone, 40);
  const email = texte(c.email, 200).toLowerCase();
  const salaries = Number(c.salaries);
  const interets = Array.isArray(c.interet)
    ? c.interet.map((i: unknown) => texte(i, 200)).filter(Boolean).slice(0, 20)
    : [];

  const manques: string[] = [];
  if (!garage) manques.push("le nom du garage");
  if (!dirigeant) manques.push("le nom du dirigeant");
  if (!telephone) manques.push("le téléphone");
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) manques.push("une adresse e-mail valide");
  if (!Number.isInteger(salaries) || salaries < 0 || salaries > 10000) manques.push("le nombre de salariés");
  if (interets.length === 0) manques.push("au moins un centre d'intérêt");

  if (manques.length) {
    await journaliserRejet(sb, "validation", `manque : ${manques.join(", ")}`, req, c);
    return json(req, { erreur: `Il manque ${manques.join(", ")}.` }, 400);
  }

  // --- bilan : facultatif (§7), mais vérifié pour de vrai s'il est là ------
  let bilan = {
    fourni: false,
    chemin: null as string | null,
    nom: null as string | null,
    taille: null as number | null,
    type: null as string | null,
  };

  if (c.bilan_chemin) {
    const chemin = String(c.bilan_chemin);
    if (!await signatureValide(chemin, String(c.bilan_signature ?? ""))) {
      await journaliserRejet(sb, "type_fichier", `signature de chemin invalide (${chemin})`, req, c);
      return json(req, { erreur: "Le fichier joint n'a pas pu être vérifié. Retirez-le et réessayez." }, 400);
    }

    const verif = await verifierObjet(chemin);
    if (!verif.ok) {
      await sb.storage.from(BUCKET).remove([chemin]);            // on ne garde pas un fichier refusé
      await journaliserRejet(sb, "type_fichier", verif.motif, req, c);
      return json(req, { erreur: verif.message }, 415);
    }

    bilan = {
      fourni: true,
      chemin,
      nom: assainirNom(texte(c.bilan_nom, 160) || `bilan${chemin.slice(chemin.lastIndexOf("."))}`),
      taille: verif.taille,
      type: verif.type,
    };
  }

  // --- écriture en base AVANT toute réponse. §5.5 : le succès ne s'affiche
  //     qu'après confirmation que c'est écrit. ------------------------------
  const { data: lead, error } = await sb.from("leads").insert({
    garage, dirigeant, telephone, email, salaries, interets,
    bilan_fourni: bilan.fourni,
    bilan_chemin: bilan.chemin,
    bilan_nom_origine: bilan.nom,
    bilan_taille: bilan.taille,
    bilan_type: bilan.type,
    commercial: texte(c.commercial, 100) || null,
    ip: ipDe(req),
    user_agent: req.headers.get("user-agent")?.slice(0, 400) ?? null,
    remplissage_ms: Number.isFinite(remplissage) ? Math.min(remplissage, 2_000_000_000) : null,
  }).select().single();

  if (error || !lead) {
    console.error("insert leads", error);
    // Rien n'est enregistré : on ne prétend surtout pas que c'est passé.
    return json(req, { erreur: "Vos informations n'ont pas pu être enregistrées. Réessayez dans un instant." }, 500);
  }

  // --- notification. Un échec ici ne perd plus rien : la ligne existe. -----
  try {
    const { pieceJointe } = await envoyerNotification(sb, lead as Lead);
    await sb.from("leads").update({
      mail_statut: "envoye",
      mail_tentatives: 1,
      mail_envoye_at: new Date().toISOString(),
      mail_piece_jointe: pieceJointe,
    }).eq("id", lead.id);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    await sb.from("leads").update({
      mail_statut: "echec", mail_tentatives: 1, mail_erreur: detail,
    }).eq("id", lead.id);
    // §5.4 : aucune soumission acceptée sans alerte.
    await alerter(sb, "critique", `Mail non parti — lead ${lead.reference} (${garage})`, detail, lead.id);
  }

  return json(req, { ok: true, id: lead.id, reference: lead.reference });
}

/* ------------------------------ vérification du type réel par les octets */

async function verifierObjet(chemin: string): Promise<
  { ok: true; taille: number; type: string } | { ok: false; motif: string; message: string }
> {
  const sb = admin();

  // Une URL signée courte, puis UNE requête Range : on obtient d'un coup
  // l'existence, la taille réelle et les octets d'en-tête. On passe par l'URL
  // signée plutôt que par l'API authentifiée en direct, car c'est le chemin de
  // lecture que le Storage sert de façon identique partout.
  const { data: signee, error: eSign } = await sb.storage.from(BUCKET).createSignedUrl(chemin, 60);
  if (eSign || !signee) {
    return {
      ok: false,
      motif: `objet introuvable dans le Storage : ${eSign?.message ?? "sans détail"}`,
      message: "Le fichier n'est pas arrivé jusqu'à nous. Retirez-le et réessayez.",
    };
  }

  const r = await fetch(signee.signedUrl, { headers: { range: "bytes=0-63" } });
  if (!r.ok && r.status !== 206) {
    return {
      ok: false,
      motif: `lecture impossible (HTTP ${r.status})`,
      message: "Le fichier n'a pas pu être lu. Retirez-le et réessayez.",
    };
  }

  const entete = new Uint8Array(await r.arrayBuffer());
  const contentRange = r.headers.get("content-range");            // « bytes 0-63/12345678 »
  const taille = Number(contentRange?.split("/")[1] ?? r.headers.get("content-length") ?? 0);

  if (!Number.isFinite(taille) || taille <= 0) {
    return { ok: false, motif: "taille réelle indéterminable", message: "Le fichier semble vide. Retirez-le et réessayez." };
  }
  if (taille > TAILLE_MAX) {
    return { ok: false, motif: `taille réelle ${taille}`, message: `Le fichier dépasse ${TAILLE_MAX / 1048576} Mo.` };
  }

  const type = detecterType(entete);
  if (!type) {
    return {
      ok: false,
      motif: `signature inconnue : ${[...entete.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join(" ")}`,
      message: "Ce fichier n'est pas un PDF ni une image. Envoyez un PDF ou une photo de votre bilan.",
    };
  }
  return { ok: true, taille, type };
}

