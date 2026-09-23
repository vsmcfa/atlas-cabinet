// ─────────────────────────────────────────────────────────────────────────
// ATLAS — fonction « relance-mail », version autonome (un seul fichier).
// GÉNÉRÉ AUTOMATIQUEMENT : ne pas modifier ici.
// Source : supabase/functions/relance-mail/  ·  Régénérer : node supabase/grouper.mjs
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

  const pieces: { content: string; name: string }[] = [];
  let bilanHtml: string;
  let pieceJointe = false;

  if (!l.bilan_fourni || !l.bilan_chemin) {
    // §7 du brief : l'absence doit être dite explicitement, et seulement dite.
    bilanHtml = encadre("#FBEAE8", "<b>Aucun bilan joint.</b>");
  } else {
    const nom = l.bilan_nom_origine ?? `bilan-${l.reference}`;

    if (MODE_PJ && (l.bilan_taille ?? 0) <= PJ_MAX) {
      const { data, error } = await sb.storage.from(BUCKET).download(l.bilan_chemin);
      if (error || !data) throw new Error(`lecture du bilan impossible : ${error?.message}`);
      pieces.push({ content: base64(new Uint8Array(await data.arrayBuffer())), name: nom });
      pieceJointe = true;
      bilanHtml = encadre("#E7F7F0", `<b>Bilan joint</b> — ${echapper(nom)}, en pièce jointe.`);
    } else if (CONSOLE_URL) {
      // Le téléchargement se fait dans la console : pas d'URL de fichier
      // comptable qui traîne un an dans des boîtes mail.
      bilanHtml = encadre("#E7F7F0", `<b>Bilan joint</b> — ${echapper(nom)}.`);
    } else {
      const { data, error } = await sb.storage.from(BUCKET)
        .createSignedUrl(l.bilan_chemin, LIEN_JOURS * 86400, { download: nom });
      if (error || !data) throw new Error(`URL signée impossible : ${error?.message}`);
      bilanHtml = encadre("#E7F7F0",
        `<b>Bilan joint</b> — ${echapper(nom)}<br><a href="${data.signedUrl}" style="color:#2A5FBF;font-weight:700">Télécharger le bilan</a>`);
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

// File de reprise : réessaie les notifications qui ont échoué.
// Déclenchée par pg_cron (cf. README, §5). Protégée par CRON_SECRET.

const MAX_TENTATIVES = 6;

Deno.serve(async (req) => {
  if (req.headers.get("x-cron-secret") !== Deno.env.get("CRON_SECRET")) {
    return new Response("non autorisé", { status: 401 });
  }

  const sb = admin();
  const { data: leads, error } = await sb
    .from("leads")
    .select("*")
    .neq("mail_statut", "envoye")
    .lt("mail_tentatives", MAX_TENTATIVES)
    .order("created_at", { ascending: true })
    .limit(25);

  if (error) return new Response(`lecture impossible : ${error.message}`, { status: 500 });

  let envoyes = 0, echecs = 0;
  for (const lead of leads ?? []) {
    const tentatives = lead.mail_tentatives + 1;
    try {
      const { pieceJointe } = await envoyerNotification(sb, lead as Lead);
      await sb.from("leads").update({
        mail_statut: "envoye",
        mail_tentatives: tentatives,
        mail_envoye_at: new Date().toISOString(),
        mail_piece_jointe: pieceJointe,
        mail_erreur: null,
      }).eq("id", lead.id);
      envoyes++;
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      await sb.from("leads").update({ mail_tentatives: tentatives, mail_erreur: detail }).eq("id", lead.id);
      echecs++;
      if (tentatives >= MAX_TENTATIVES) {
        // Abandon de la reprise automatique : il faut une intervention humaine.
        await alerter(sb, "critique",
          `Mail définitivement abandonné — lead ${lead.reference} (${lead.garage})`,
          `${MAX_TENTATIVES} tentatives échouées. Dernière erreur : ${detail}. ` +
          `Le lead reste consultable dans la vue v_leads.`, lead.id);
      }
    }
  }

  console.log(`[relance-mail] ${envoyes} envoyé(s), ${echecs} échec(s)`);
  return Response.json({ traites: leads?.length ?? 0, envoyes, echecs });
});

