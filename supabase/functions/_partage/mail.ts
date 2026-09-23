// Envoi de la notification de lead via l'API transactionnelle Brevo.
import { type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { BUCKET } from "./commun.ts";

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

function corpsHtml(l: Lead, bilan: string): string {
  const ligne = (k: string, v: string) =>
    `<tr><td style="padding:7px 14px 7px 0;color:#66707F;font-size:13px;white-space:nowrap;vertical-align:top">${k}</td>` +
    `<td style="padding:7px 0;color:#202B3D;font-size:14px;font-weight:600">${v}</td></tr>`;

  return `<div style="font-family:-apple-system,Segoe UI,Inter,sans-serif;max-width:620px">
  <h2 style="color:#16305C;font-size:19px;margin:0 0 4px">Nouveau lead — ${echapper(l.garage)}</h2>
  <p style="color:#66707F;font-size:13px;margin:0 0 18px">Référence <b>${l.reference}</b> · ${new Date(l.created_at).toLocaleString("fr-FR", { timeZone: "Europe/Paris" })}</p>
  <table style="border-collapse:collapse;width:100%">
    ${ligne("Garage", echapper(l.garage))}
    ${ligne("Dirigeant", echapper(l.dirigeant))}
    ${ligne("Téléphone", `<a href="tel:${echapper(l.telephone.replace(/\s/g, ""))}" style="color:#2A5FBF">${echapper(l.telephone)}</a>`)}
    ${ligne("E-mail", `<a href="mailto:${echapper(l.email)}" style="color:#2A5FBF">${echapper(l.email)}</a>`)}
    ${ligne("Salariés", String(l.salaries))}
    ${ligne("Commercial", l.commercial ? echapper(l.commercial) : "<span style='color:#66707F;font-weight:400'>non renseigné</span>")}
  </table>
  <p style="color:#16305C;font-size:13px;font-weight:700;margin:20px 0 6px">Centres d'intérêt</p>
  <ul style="margin:0;padding-left:18px;color:#202B3D;font-size:14px;line-height:1.7">
    ${l.interets.map((i) => `<li>${echapper(i)}</li>`).join("")}
  </ul>
  <p style="color:#16305C;font-size:13px;font-weight:700;margin:20px 0 6px">Bilan comptable</p>
  ${bilan}
  <p style="color:#66707F;font-size:12px;margin-top:22px;border-top:1px solid #E4E9F1;padding-top:12px">
    Répondre à ce message écrit directement au garage (${echapper(l.email)}).<br>
    Le dossier complet reste consultable dans Supabase sous la référence ${l.reference}.
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
      bilanHtml = encadre("#E7F7F0", `📎 <b>${echapper(nom)}</b> — ${mo} Mo, en pièce jointe de ce message.`);
    } else {
      const { data, error } = await sb.storage.from(BUCKET)
        .createSignedUrl(l.bilan_chemin, LIEN_JOURS * 86400, { download: nom });
      if (error || !data) throw new Error(`URL signée impossible : ${error?.message}`);
      bilanHtml = encadre(
        "#E7F7F0",
        `📄 <b>${echapper(nom)}</b> — ${mo} Mo<br>` +
        `<a href="${data.signedUrl}" style="color:#2A5FBF;font-weight:700">Télécharger le bilan</a> ` +
        `<span style="color:#66707F;font-size:12px">— lien valable ${LIEN_JOURS} jours. Passé ce délai, le fichier reste dans Supabase.</span>`,
      );
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
      subject: `Nouveau lead — ${l.garage}`,
      htmlContent: corpsHtml(l, bilanHtml),
      tags: ["atlas-lead"],
      ...(pieces.length ? { attachment: pieces } : {}),
    }),
  });

  if (!reponse.ok) {
    throw new Error(`Brevo ${reponse.status} : ${(await reponse.text()).slice(0, 500)}`);
  }
  return { pieceJointe };
}
