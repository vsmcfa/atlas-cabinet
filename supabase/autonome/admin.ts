// ─────────────────────────────────────────────────────────────────────────
// ATLAS — fonction « admin », version autonome (un seul fichier).
// GÉNÉRÉ AUTOMATIQUEMENT : ne pas modifier ici.
// Source : supabase/functions/admin/  ·  Régénérer : node supabase/grouper.mjs
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

// Consultation des réponses — backend de la page d'administration.
//
// Accès par MOT DE PASSE UNIQUE PARTAGÉ (choix dirigeant). Le mot de passe
// n'est JAMAIS dans la page : il est vérifié ici, contre une empreinte SHA-256
// rangée dans les secrets Supabase. En échange, la fonction délivre un jeton de
// session signé, valable 8 h, que la page présente à chaque requête.
//
// Conséquence : ni la clé anon, ni la moindre ligne de « leads » ne sont
// atteignables sans le mot de passe. Le code source de la page ne révèle rien.
//
//   POST /admin/reponse  { jeton_lead }        -> { lead }   (lien du mail)
//   POST /admin/session  { motdepasse }        -> { jeton, expire_at }
//   POST /admin/leads    { jeton, recherche? } -> { leads, total }
//   POST /admin/bilan    { jeton, piece_id }   -> { url }      (signée 1 h)
//   POST /admin/export   { jeton }             -> CSV
//
//   POST /admin/piece-url        { jeton, taille, type }             -> URL d'envoi
//   POST /admin/piece-ajouter    { jeton, lead_id, chemin, … }       -> { piece }
//   POST /admin/piece-supprimer  { jeton, piece_id }                 -> { ok }

const SESSION_HEURES = 8;
const MAX_TENTATIVES_10MIN = 10;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== "POST") return json(req, { erreur: "Méthode non autorisée." }, 405);

  const route = new URL(req.url).pathname.split("/").filter(Boolean).pop() ?? "";
  try {
    if (route === "session") return await ouvrirSession(req);
    if (route === "reponse") return await parJetonLead(req);

    const corps = await req.json().catch(() => ({}));
    // Le bilan s'ouvre soit avec une session, soit avec le jeton de la fiche
    // reçue par mail — mais uniquement pour CETTE fiche (vérifié plus bas).
    const parLien = route === "bilan" && await jetonLeadValide(corps.jeton_lead, corps.lead_id);
    if (!parLien && !await jetonValide(corps.jeton)) {
      return json(req, { erreur: "Session expirée. Reconnectez-vous." }, 401);
    }
    if (route === "leads") return await listerLeads(req, corps);
    if (route === "bilan") return await lienPiece(req, corps);
    if (route === "export") return await exporterCsv(req);
    if (route === "piece-url") return await urlEnvoiPiece(req, corps);
    if (route === "piece-ajouter") return await ajouterPiece(req, corps);
    if (route === "piece-supprimer") return await supprimerPiece(req, corps);
    return json(req, { erreur: "Route inconnue." }, 404);
  } catch (e) {
    console.error(`[admin/${route}]`, e);
    return json(req, { erreur: "Erreur serveur." }, 500);
  }
});

/* ------------------------------------------------------------- session */

async function empreinte(texte: string): Promise<string> {
  const oct = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texte));
  return [...new Uint8Array(oct)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function ouvrirSession(req: Request): Promise<Response> {
  const sb = admin();
  const { motdepasse } = await req.json().catch(() => ({ motdepasse: "" }));

  // Un mot de passe partagé se force par essais successifs : on plafonne.
  if (await limiteDebitDepassee(sb, req, "admin-session", MAX_TENTATIVES_10MIN)) {
    await journaliserRejet(sb, "rate_limit", "trop de tentatives de connexion admin", req);
    return json(req, { erreur: "Trop de tentatives. Patientez dix minutes." }, 429);
  }

  const attendu = (Deno.env.get("ADMIN_MOTDEPASSE_HASH") ?? "").toLowerCase().trim();
  if (!attendu) {
    console.error("ADMIN_MOTDEPASSE_HASH non défini");
    return json(req, { erreur: "Accès non configuré." }, 503);
  }
  if (await empreinte(String(motdepasse ?? "")) !== attendu) {
    // Journalisé : une série de lignes ici, c'est une tentative d'intrusion.
    await journaliserRejet(sb, "admin_mdp", `mot de passe incorrect depuis ${ipDe(req) ?? "?"}`, req);
    return json(req, { erreur: "Mot de passe incorrect." }, 401);
  }

  const expire = Date.now() + SESSION_HEURES * 3600_000;
  return json(req, {
    jeton: `${expire}.${await signer(`admin:${expire}`)}`,
    expire_at: new Date(expire).toISOString(),
  });
}

async function jetonValide(jeton: unknown): Promise<boolean> {
  if (typeof jeton !== "string") return false;
  const [expire, signature] = jeton.split(".");
  if (!expire || !signature) return false;
  if (Number(expire) < Date.now()) return false;
  return await signatureValide(`admin:${expire}`, signature);
}

/* ------------------------------------------ accès direct depuis le mail */

/**
 * Le mail de notification contient un lien signé vers UNE fiche. Le jeton
 * n'ouvre que celle-là, et il expire. Il ne donne aucun accès à la liste
 * complète : celle-ci reste derrière le mot de passe.
 *
 * Contrepartie assumée : quiconque reçoit ce lien voit cette fiche sans mot de
 * passe. Le mail part sur une boîte interne ; ne pas le faire suivre à
 * l'extérieur.
 */
async function parJetonLead(req: Request): Promise<Response> {
  const sb = admin();
  const { jeton_lead } = await req.json().catch(() => ({ jeton_lead: "" }));

  if (await limiteDebitDepassee(sb, req, "admin-reponse", 60)) {
    return json(req, { erreur: "Trop de tentatives. Patientez quelques minutes." }, 429);
  }

  const [id, expire, signature] = String(jeton_lead ?? "").split(".");
  if (!id || !expire || !signature) return json(req, { erreur: "Lien invalide." }, 400);

  if (Number(expire) < Date.now()) {
    return json(req, { erreur: "Ce lien a expiré. Ouvrez la console avec le mot de passe." }, 410);
  }
  if (!await signatureValide(`lead:${id}:${expire}`, signature)) {
    await journaliserRejet(sb, "jeton_lead", `signature invalide pour ${id}`, req);
    return json(req, { erreur: "Lien invalide." }, 401);
  }

  const { data, error } = await sb.from("leads").select(CHAMPS).eq("id", id)
    .maybeSingle<LeadLigne>();
  if (error || !data) return json(req, { erreur: "Réponse introuvable." }, 404);

  return json(req, { lead: data });
}

/** Le jeton doit être valide ET désigner exactement la fiche demandée. */
async function jetonLeadValide(jeton: unknown, idDemande: unknown): Promise<boolean> {
  const [id, expire, signature] = String(jeton ?? "").split(".");
  if (!id || !expire || !signature) return false;
  if (id !== String(idDemande ?? "")) return false;
  if (Number(expire) < Date.now()) return false;
  return await signatureValide(`lead:${id}:${expire}`, signature);
}

/* --------------------------------------------------------------- leads */

const CHAMPS =
  "id, reference, created_at, garage, dirigeant, telephone, email, salaries, interets, " +
  "bilan_fourni, nb_pieces, commercial, mail_statut, mail_erreur, " +
  "pieces_jointes(id, nom, taille, type, origine, created_at)";

// `CHAMPS` étant une constante calculée, supabase-js ne peut pas en déduire la
// forme des lignes : on la déclare une fois ici.
type LeadLigne = {
  id: string; reference: string; created_at: string;
  garage: string; dirigeant: string; telephone: string; email: string; salaries: number;
  interets: string[]; bilan_fourni: boolean; nb_pieces: number;
  commercial: string | null; mail_statut: string; mail_erreur: string | null;
  pieces_jointes: { id: string; nom: string; taille: number; type: string; origine: string; created_at: string }[];
};

async function listerLeads(req: Request, corps: Record<string, unknown>): Promise<Response> {
  const sb = admin();
  const recherche = String(corps.recherche ?? "").trim().slice(0, 100);
  const page = Math.max(0, Number(corps.page) || 0);
  const parPage = 50;

  // Les filtres d'abord, les transformations (.order/.range/.returns) ensuite :
  // supabase-js ne laisse plus filtrer une fois la requête transformée.
  let f = sb.from("leads").select(CHAMPS, { count: "exact" });

  if (recherche) {
    // Le motif vient de l'utilisateur et finit dans un .or() : on retire les
    // caractères qui ont un sens pour PostgREST avant de l'interpoler.
    const motif = recherche.replace(/[%,().*\\:"]/g, " ");
    f = f.or(`garage.ilike.%${motif}%,dirigeant.ilike.%${motif}%,email.ilike.%${motif}%,` +
      `telephone.ilike.%${motif}%,commercial.ilike.%${motif}%,reference.ilike.%${motif}%`);
  }
  if (corps.a_traiter === true) f = f.neq("mail_statut", "envoye");

  const { data, count, error } = await f
    .order("created_at", { ascending: false })
    .range(page * parPage, page * parPage + parPage - 1)
    .returns<LeadLigne[]>();
  if (error) {
    console.error("listerLeads", error);
    return json(req, { erreur: "Lecture impossible." }, 500);
  }
  return json(req, { leads: data ?? [], total: count ?? 0, page, parPage });
}

/* ------------------------------------------------- pièces jointes */

async function lienPiece(req: Request, corps: Record<string, unknown>): Promise<Response> {
  const sb = admin();
  const { data: piece, error } = await sb.from("pieces_jointes")
    .select("chemin, nom, lead_id").eq("id", String(corps.piece_id ?? "")).maybeSingle();

  if (error || !piece) return json(req, { erreur: "Document introuvable." }, 404);
  // Un jeton de mail n'ouvre que les pièces de SA fiche.
  if (corps.lead_id && piece.lead_id !== String(corps.lead_id)) {
    return json(req, { erreur: "Document introuvable." }, 404);
  }

  const { data, error: e2 } = await sb.storage.from(BUCKET)
    .createSignedUrl(piece.chemin, 3600, { download: piece.nom });
  if (e2 || !data) return json(req, { erreur: "Lien indisponible." }, 500);
  return json(req, { url: data.signedUrl });
}

/** Étape 1 de l'ajout depuis la console : autorise l'envoi vers le Storage. */
async function urlEnvoiPiece(req: Request, corps: Record<string, unknown>): Promise<Response> {
  const sb = admin();
  if (await limiteDebitDepassee(sb, req, "admin-piece-url", 60)) {
    return json(req, { erreur: "Trop d'envois. Patientez quelques minutes." }, 429);
  }
  const r = await urlUpload(corps.taille, corps.type);
  if (!r.ok) {
    await journaliserRejet(sb, "type_fichier", `console : ${r.motif}`, req, corps);
    return json(req, { erreur: r.erreur }, r.code);
  }
  return json(req, { chemin: r.chemin, url: r.url, signature: r.signature });
}

/** Étape 2 : vérifie le fichier déposé et le rattache à la fiche. */
async function ajouterPiece(req: Request, corps: Record<string, unknown>): Promise<Response> {
  const sb = admin();
  const leadId = String(corps.lead_id ?? "");

  const { data: lead } = await sb.from("leads").select("id, reference").eq("id", leadId).maybeSingle();
  if (!lead) return json(req, { erreur: "Réponse introuvable." }, 404);

  const r = await enregistrerPiece(
    leadId, String(corps.chemin ?? ""), String(corps.signature ?? ""), corps.nom, "console",
  );
  if (!r.ok) {
    await journaliserRejet(sb, "type_fichier", `console : ${r.motif}`, req, corps);
    return json(req, { erreur: r.erreur }, r.code);
  }

  const { data: piece } = await sb.from("pieces_jointes")
    .select("id, nom, taille, type, origine, created_at").eq("id", r.id).single();
  console.log(`[admin] document ajouté au lead ${lead.reference} : ${piece?.nom}`);
  return json(req, { ok: true, piece });
}

/** Suppression définitive : le fichier quitte aussi le Storage. */
async function supprimerPiece(req: Request, corps: Record<string, unknown>): Promise<Response> {
  const sb = admin();
  const { data: piece } = await sb.from("pieces_jointes")
    .select("id, chemin, nom, lead_id").eq("id", String(corps.piece_id ?? "")).maybeSingle();

  if (!piece) return json(req, { erreur: "Document introuvable." }, 404);

  // Le fichier d'abord : une ligne sans fichier est récupérable, un fichier
  // sans ligne est un orphelin que plus personne ne relie à son dossier.
  const { error: eStorage } = await sb.storage.from(BUCKET).remove([piece.chemin]);
  if (eStorage) {
    console.error("suppression Storage", eStorage);
    return json(req, { erreur: "Le fichier n'a pas pu être supprimé. Réessayez." }, 500);
  }

  const { error } = await sb.from("pieces_jointes").delete().eq("id", piece.id);
  if (error) {
    console.error("suppression pieces_jointes", error);
    return json(req, { erreur: "Le document a été retiré du stockage mais la fiche n'a pas pu être mise à jour." }, 500);
  }

  // Une suppression définitive laisse une trace : qui a supprimé quoi, et quand.
  await sb.from("alertes").insert({
    niveau: "info", sujet: "Document supprimé",
    detail: `« ${piece.nom} » supprimé définitivement depuis la console (IP ${ipDe(req) ?? "?"}).`,
    lead_id: piece.lead_id, traitee: true,
  });

  return json(req, { ok: true });
}

/* ----------------------------------------------------------- export CSV */

const cellule = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function exporterCsv(req: Request): Promise<Response> {
  const sb = admin();
  const { data, error } = await sb.from("leads").select(CHAMPS)
    .order("created_at", { ascending: false }).returns<LeadLigne[]>();
  if (error) return json(req, { erreur: "Export impossible." }, 500);

  const colonnes = [
    "Référence", "Date", "Garage", "Dirigeant", "Téléphone", "E-mail", "Salariés",
    "Centres d'intérêt", "Documents", "Commercial", "Statut mail",
  ];
  const lignes = (data ?? []).map((l) => [
    l.reference,
    new Date(l.created_at).toLocaleString("fr-FR", { timeZone: "Europe/Paris" }),
    l.garage, l.dirigeant, l.telephone, l.email, l.salaries,
    (l.interets ?? []).join(" | "),
    (l.pieces_jointes ?? []).map((p) => p.nom).join(" | ") || "AUCUN DOCUMENT",
    l.commercial ?? "", l.mail_statut,
  ].map(cellule).join(";"));

  // BOM UTF-8 + point-virgule : Excel français ouvre le fichier correctement.
  return new Response("﻿" + [colonnes.join(";"), ...lignes].join("\r\n"), {
    headers: {
      ...cors(req),
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="atlas-leads-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}

