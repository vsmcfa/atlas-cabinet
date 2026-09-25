// POST /functions/v1/lead/upload-url  -> autorise un envoi de fichier direct vers le Storage
// POST /functions/v1/lead             -> enregistre la soumission, puis notifie par mail
//
// Le fichier ne transite PAS par cette fonction : le navigateur l'envoie
// directement au Storage avec une URL signée à usage unique. Aucune limite de
// taille imposée par la fonction, et un PDF de 12 Mo passe sans difficulté.

import { admin, alerter, cors, ipDe, json, journaliserRejet, limiteDebitDepassee } from "../_partage/commun.ts";
import { enregistrerPiece, urlUpload } from "../_partage/pieces.ts";
import { envoyerNotification, type Lead } from "../_partage/mail.ts";

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
