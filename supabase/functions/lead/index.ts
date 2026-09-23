// POST /functions/v1/lead/upload-url  -> autorise un envoi de fichier direct vers le Storage
// POST /functions/v1/lead             -> enregistre la soumission, puis notifie par mail
//
// Le fichier ne transite PAS par cette fonction : le navigateur l'envoie
// directement au Storage avec une URL signée à usage unique. Aucune limite de
// taille imposée par la fonction, et un PDF de 12 Mo passe sans difficulté.

import {
  admin, alerter, BUCKET, cors, detecterType, ipDe, json,
  journaliserRejet, limiteDebitDepassee, signatureValide, signer, TYPES_ACCEPTES, type TypeAccepte,
} from "../_partage/commun.ts";
import { envoyerNotification, type Lead } from "../_partage/mail.ts";

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
  // Une seule requête Range donne à la fois l'existence, la taille réelle
  // et les octets d'en-tête. On ne fait confiance à rien de ce que le
  // navigateur a déclaré.
  const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/storage/v1/object/${BUCKET}/${chemin}`, {
    headers: {
      authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
      range: "bytes=0-63",
    },
  });

  if (!r.ok && r.status !== 206) {
    return { ok: false, motif: `objet introuvable (${r.status})`, message: "Le fichier n'est pas arrivé jusqu'à nous. Retirez-le et réessayez." };
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
