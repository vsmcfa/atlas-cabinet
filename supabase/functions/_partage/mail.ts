// Envoi de la notification de lead via l'API transactionnelle Brevo.
import { type SupabaseClient } from "jsr:@supabase/supabase-js@2.116.0";
import { signer } from "./commun.ts";

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
export async function envoyerNotification(sb: SupabaseClient, l: Lead): Promise<{ pieceJointe: boolean }> {
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
