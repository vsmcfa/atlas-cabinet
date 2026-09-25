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

// Chaîne commune d'ajout d'une pièce jointe, partagée par le formulaire public
// et la console d'administration : même validation des deux côtés.

const TAILLE_MAX = 50 * 1024 * 1024;

/** Le nom d'origine n'est jamais réutilisé comme chemin : seulement conservé pour l'affichage. */
function assainirNom(nom: string): string {
  return nom.normalize("NFKD").replace(/[^\w.\- ]+/g, "_").replace(/_{2,}/g, "_").slice(0, 120) || "document";
}

/** Étape 1 — autorise un envoi direct du navigateur vers le Storage. */
async function urlUpload(taille: unknown, type: unknown): Promise<
  { ok: true; chemin: string; url: string; signature: string }
  | { ok: false; code: number; erreur: string; motif: string }
> {
  const t = Number(taille);
  if (!Number.isFinite(t) || t <= 0 || t > TAILLE_MAX) {
    return { ok: false, code: 413, motif: `taille annoncée ${taille}`,
      erreur: `Le fichier dépasse ${TAILLE_MAX / 1048576} Mo.` };
  }
  const mime = String(type ?? "") as TypeAccepte;
  const extension = TYPES_ACCEPTES[mime];
  if (!extension) {
    return { ok: false, code: 415, motif: `type annoncé « ${type} »`,
      erreur: "Format non accepté. Envoyez un PDF ou une image (JPEG, PNG, HEIC)." };
  }

  const now = new Date();
  const chemin = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/` +
    `${crypto.randomUUID()}${extension}`;

  const { data, error } = await admin().storage.from(BUCKET).createSignedUploadUrl(chemin);
  if (error || !data) {
    console.error("createSignedUploadUrl", error);
    return { ok: false, code: 502, motif: String(error?.message), erreur: "Envoi de fichier indisponible. Réessayez dans un instant." };
  }
  return { ok: true, chemin, url: data.signedUrl, signature: await signer(chemin) };
}

/**
 * Étape 2 — vérifie l'objet déposé puis l'enregistre sur le lead.
 * La signature empêche d'associer à un lead un objet du Storage qu'on n'a pas
 * soi-même obtenu à l'étape 1. Le type réel est relu dans les octets : rien de
 * ce que le navigateur a déclaré n'est cru sur parole.
 */
async function enregistrerPiece(
  leadId: string, chemin: string, signature: string, nom: unknown,
  origine: "formulaire" | "console",
): Promise<{ ok: true; id: string } | { ok: false; code: number; erreur: string; motif: string }> {
  const sb = admin();

  if (!await signatureValide(chemin, signature)) {
    return { ok: false, code: 400, motif: `signature de chemin invalide (${chemin})`,
      erreur: "Le fichier joint n'a pas pu être vérifié. Retirez-le et réessayez." };
  }

  const verif = await verifierObjet(chemin);
  if (!verif.ok) {
    await sb.storage.from(BUCKET).remove([chemin]);        // on ne garde pas un fichier refusé
    return { ok: false, code: 415, motif: verif.motif, erreur: verif.erreur };
  }

  const propre = assainirNom(
    typeof nom === "string" && nom.trim() ? nom.trim() : `document${chemin.slice(chemin.lastIndexOf("."))}`,
  );

  const { data, error } = await sb.from("pieces_jointes")
    .insert({ lead_id: leadId, chemin, nom: propre, taille: verif.taille, type: verif.type, origine })
    .select("id").single();

  if (error || !data) {
    await sb.storage.from(BUCKET).remove([chemin]);        // pas de fichier orphelin
    console.error("insert pieces_jointes", error);
    return { ok: false, code: 500, motif: String(error?.message), erreur: "Le document n'a pas pu être enregistré." };
  }
  return { ok: true, id: data.id };
}

/** Existence, taille réelle et type réel en une seule requête Range. */
async function verifierObjet(chemin: string): Promise<
  { ok: true; taille: number; type: string } | { ok: false; motif: string; erreur: string }
> {
  const sb = admin();
  const { data: signee, error } = await sb.storage.from(BUCKET).createSignedUrl(chemin, 60);
  if (error || !signee) {
    return { ok: false, motif: `objet introuvable : ${error?.message ?? "sans détail"}`,
      erreur: "Le fichier n'est pas arrivé jusqu'à nous. Réessayez." };
  }

  const r = await fetch(signee.signedUrl, { headers: { range: "bytes=0-63" } });
  if (!r.ok && r.status !== 206) {
    return { ok: false, motif: `lecture impossible (HTTP ${r.status})`, erreur: "Le fichier n'a pas pu être lu. Réessayez." };
  }

  const entete = new Uint8Array(await r.arrayBuffer());
  const taille = Number(r.headers.get("content-range")?.split("/")[1] ?? r.headers.get("content-length") ?? 0);

  if (!Number.isFinite(taille) || taille <= 0) {
    return { ok: false, motif: "taille réelle indéterminable", erreur: "Le fichier semble vide." };
  }
  if (taille > TAILLE_MAX) {
    return { ok: false, motif: `taille réelle ${taille}`, erreur: `Le fichier dépasse ${TAILLE_MAX / 1048576} Mo.` };
  }

  const type = detecterType(entete);
  if (!type) {
    return {
      ok: false,
      motif: `signature inconnue : ${[...entete.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join(" ")}`,
      erreur: "Ce fichier n'est pas un PDF ni une image.",
    };
  }
  return { ok: true, taille, type };
}

// Envoi de la notification de lead via l'API transactionnelle Brevo.

// Les documents ne sont pas mis en pièce jointe : ils vivent dans le bucket
// privé et se consultent depuis la fiche. Aucune limite de taille imposée par
// Brevo, et aucun bilan comptable dupliqué dans des boîtes mail qu'on ne
// maîtrise pas.

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
  nb_pieces: number;
  pieces: string[];            // noms des documents rattachés
  commercial: string | null;
  created_at: string;
};

const echapper = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

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
       <p style="color:#66707F;font-size:12px;margin:0 0 4px">Lien valable ${JETON_JOURS} jours.</p>`
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
    Réponse dirigée vers ${echapper(l.email)}.
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

  const noms = l.pieces ?? [];
  const bilanHtml = noms.length === 0
    // §7 du brief : l'absence doit être dite explicitement, et seulement dite.
    ? encadre("#FBEAE8", "<b>Aucun document joint.</b>")
    : encadre("#E7F7F0",
        `<b>${noms.length} document${noms.length > 1 ? "s" : ""} joint${noms.length > 1 ? "s" : ""}</b><br>` +
        noms.map((n) => echapper(n)).join("<br>"));

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
    }),
  });

  if (!reponse.ok) {
    throw new Error(`Brevo ${reponse.status} : ${(await reponse.text()).slice(0, 500)}`);
  }
  return { pieceJointe: noms.length > 0 };
}

// POST /functions/v1/lead/upload-url  -> autorise un envoi de fichier direct vers le Storage
// POST /functions/v1/lead             -> enregistre la soumission, puis notifie par mail
//
// Le fichier ne transite PAS par cette fonction : le navigateur l'envoie
// directement au Storage avec une URL signée à usage unique. Aucune limite de
// taille imposée par la fonction, et un PDF de 12 Mo passe sans difficulté.

const REMPLISSAGE_MIN_MS = 3000;       // §6 : rejet sous 3 secondes
const MAX_PIECES = 10;
const MAX_UPLOADS_10MIN = 20;
const MAX_ENVOIS_10MIN = 8;

const texte = (v: unknown, max: number) =>
  typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, max) : "";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== "POST") return json(req, { erreur: "Méthode non autorisée." }, 405);

  const etape = new URL(req.url).pathname.endsWith("/upload-url") ? "upload-url" : "lead";
  try {
    return etape === "upload-url" ? await demanderUrlUpload(req) : await enregistrer(req);
  } catch (e) {
    console.error(`[${etape}] exception`, e);
    return json(req, { erreur: "Une erreur est survenue côté serveur. Réessayez dans un instant." }, 500);
  }
});

/* ------------------------------------------------ étape 1 : URL d'upload */

async function demanderUrlUpload(req: Request): Promise<Response> {
  const sb = admin();
  const corps = await req.json().catch(() => null);
  if (!corps) return json(req, { erreur: "Requête illisible." }, 400);

  if (await limiteDebitDepassee(sb, req, "upload-url", MAX_UPLOADS_10MIN)) {
    await journaliserRejet(sb, "rate_limit", "trop d'URL d'upload demandées", req);
    return json(req, { erreur: "Trop de tentatives. Patientez quelques minutes." }, 429);
  }

  const r = await urlUpload(corps.taille, corps.type);
  if (!r.ok) {
    await journaliserRejet(sb, "type_fichier", r.motif, req, corps);
    return json(req, { erreur: r.erreur }, r.code);
  }
  return json(req, { chemin: r.chemin, url: r.url, signature: r.signature });
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

  // --- les documents sont FACULTATIFS (§7), et il peut y en avoir plusieurs --
  const annonces = Array.isArray(c.pieces) ? c.pieces.slice(0, MAX_PIECES) : [];

  // Le lead est écrit AVANT les pièces : si une pièce est rejetée, la réponse
  // du dirigeant reste acquise. §5.5 — rien ne se perd en silence.
  const { data: lead, error } = await sb.from("leads").insert({
    garage, dirigeant, telephone, email, salaries, interets,
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

  const refusees: string[] = [];
  for (const p of annonces) {
    const r = await enregistrerPiece(
      lead.id, String(p?.chemin ?? ""), String(p?.signature ?? ""), p?.nom, "formulaire",
    );
    if (!r.ok) {
      refusees.push(String(p?.nom ?? "document"));
      await journaliserRejet(sb, "type_fichier", `${r.motif} (lead ${lead.reference})`, req, p);
    }
  }
  if (refusees.length) {
    await alerter(sb, "avertissement",
      `Document refusé — lead ${lead.reference} (${garage})`,
      `Non enregistré(s) : ${refusees.join(", ")}. La réponse, elle, est bien conservée.`, lead.id);
  }

  // Le compteur est tenu par un déclencheur : on relit la ligne pour que le
  // mail sache ce qui a réellement été rattaché.
  const { data: complet } = await sb.from("leads").select("*").eq("id", lead.id).single();
  const { data: pieces } = await sb.from("pieces_jointes")
    .select("nom").eq("lead_id", lead.id).order("created_at");

  // --- notification. Un échec ici ne perd plus rien : la ligne existe. -----
  try {
    const { pieceJointe } = await envoyerNotification(
      sb, { ...(complet ?? lead), pieces: (pieces ?? []).map((p) => p.nom) } as Lead);
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

