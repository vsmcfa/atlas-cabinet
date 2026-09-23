// Envoi de la notification de lead via l'API transactionnelle Brevo.
import { type SupabaseClient } from "jsr:@supabase/supabase-js@2.116.0";
import { BUCKET, signer } from "./commun.ts";

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

export type Lead = {
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
export async function envoyerNotification(sb: SupabaseClient, l: Lead): Promise<{ pieceJointe: boolean }> {
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
