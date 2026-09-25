// Chaîne commune d'ajout d'une pièce jointe, partagée par le formulaire public
// et la console d'administration : même validation des deux côtés.
import {
  admin, BUCKET, detecterType, signer, signatureValide, TYPES_ACCEPTES, type TypeAccepte,
} from "./commun.ts";

export const TAILLE_MAX = 50 * 1024 * 1024;

/** Le nom d'origine n'est jamais réutilisé comme chemin : seulement conservé pour l'affichage. */
export function assainirNom(nom: string): string {
  return nom.normalize("NFKD").replace(/[^\w.\- ]+/g, "_").replace(/_{2,}/g, "_").slice(0, 120) || "document";
}

/** Étape 1 — autorise un envoi direct du navigateur vers le Storage. */
export async function urlUpload(taille: unknown, type: unknown): Promise<
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
export async function enregistrerPiece(
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
