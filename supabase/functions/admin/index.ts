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

import {
  admin, BUCKET, cors, ipDe, json, journaliserRejet, limiteDebitDepassee, signer, signatureValide,
} from "../_partage/commun.ts";
import { enregistrerPiece, urlUpload } from "../_partage/pieces.ts";

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
