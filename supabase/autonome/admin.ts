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
  const { data, error } = await sb.rpc("compter_hits", { p_ip: ip, p_fenetre_minutes: fenetreMin });
  if (error) { console.error("compter_hits", error); return false; }  // en cas de doute, on laisse passer
  await sb.from("hits").insert({ ip, route });
  return (data as number) >= max;
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
//   POST /admin/session  { motdepasse }        -> { jeton, expire_at }
//   POST /admin/leads    { jeton, recherche? } -> { leads, total }
//   POST /admin/bilan    { jeton, id }         -> { url }      (signée 1 h)
//   POST /admin/export   { jeton }             -> CSV

const SESSION_HEURES = 8;
const MAX_TENTATIVES_10MIN = 10;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== "POST") return json(req, { erreur: "Méthode non autorisée." }, 405);

  const route = new URL(req.url).pathname.split("/").filter(Boolean).pop() ?? "";
  try {
    if (route === "session") return await ouvrirSession(req);

    const corps = await req.json().catch(() => ({}));
    if (!await jetonValide(corps.jeton)) {
      return json(req, { erreur: "Session expirée. Reconnectez-vous." }, 401);
    }
    if (route === "leads") return await listerLeads(req, corps);
    if (route === "bilan") return await lienBilan(req, corps);
    if (route === "export") return await exporterCsv(req);
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

/* --------------------------------------------------------------- leads */

const CHAMPS =
  "id, reference, created_at, garage, dirigeant, telephone, email, salaries, interets, " +
  "bilan_fourni, bilan_nom_origine, bilan_taille, commercial, mail_statut, mail_erreur";

// `CHAMPS` étant une constante calculée, supabase-js ne peut pas en déduire la
// forme des lignes : on la déclare une fois ici.
type LeadLigne = {
  id: string; reference: string; created_at: string;
  garage: string; dirigeant: string; telephone: string; email: string; salaries: number;
  interets: string[]; bilan_fourni: boolean; bilan_nom_origine: string | null;
  bilan_taille: number | null; commercial: string | null;
  mail_statut: string; mail_erreur: string | null;
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

/* ---------------------------------------------- téléchargement du bilan */

async function lienBilan(req: Request, corps: Record<string, unknown>): Promise<Response> {
  const sb = admin();
  const { data: lead, error } = await sb.from("leads")
    .select("bilan_chemin, bilan_nom_origine").eq("id", String(corps.id ?? "")).maybeSingle();

  if (error || !lead?.bilan_chemin) return json(req, { erreur: "Aucun bilan pour ce lead." }, 404);

  const { data, error: e2 } = await sb.storage.from(BUCKET)
    .createSignedUrl(lead.bilan_chemin, 3600, { download: lead.bilan_nom_origine ?? "bilan" });
  if (e2 || !data) return json(req, { erreur: "Lien indisponible." }, 500);

  return json(req, { url: data.signedUrl });
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
    "Centres d'intérêt", "Bilan", "Taille (Mo)", "Commercial", "Statut mail",
  ];
  const lignes = (data ?? []).map((l) => [
    l.reference,
    new Date(l.created_at).toLocaleString("fr-FR", { timeZone: "Europe/Paris" }),
    l.garage, l.dirigeant, l.telephone, l.email, l.salaries,
    (l.interets ?? []).join(" | "),
    l.bilan_fourni ? (l.bilan_nom_origine ?? "oui") : "AUCUN BILAN",
    l.bilan_taille ? (l.bilan_taille / 1048576).toFixed(1).replace(".", ",") : "",
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

