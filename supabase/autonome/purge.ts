// ─────────────────────────────────────────────────────────────────────────
// ATLAS — fonction « purge », version autonome (un seul fichier).
// GÉNÉRÉ AUTOMATIQUEMENT : ne pas modifier ici.
// Source : supabase/functions/purge/  ·  Régénérer : node supabase/grouper.mjs
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

// Nettoyage périodique. Déclenchée par pg_cron, protégée par CRON_SECRET.
//
// RÉTENTION ILLIMITÉE par défaut (décision dirigeant) : leads et bilans restent
// en ligne indéfiniment. Les deux purges ci-dessous sont DÉSACTIVÉES tant que
// RETENTION_BILAN_JOURS / RETENTION_LEAD_JOURS valent 0 — c'est le cas par défaut.
// Les suppressions se font alors à la demande, à la main, depuis le Table Editor.
//
//  1. bilans plus vieux que RETENTION_BILAN_JOURS  -> désactivé (0)
//  2. leads plus vieux que RETENTION_LEAD_JOURS    -> désactivé (0)
//  3. fichiers orphelins (upload commencé, formulaire jamais validé) -> supprimés après 7 jours
//  4. journaux de débit (hits) de plus de 24 h     -> supprimés

// 0 = pas de purge automatique. Ne mettre une valeur que sur décision explicite.
const RETENTION_BILAN = Number(Deno.env.get("RETENTION_BILAN_JOURS") ?? 0);
const RETENTION_LEAD = Number(Deno.env.get("RETENTION_LEAD_JOURS") ?? 0);
const ORPHELIN_JOURS = Number(Deno.env.get("ORPHELIN_JOURS") ?? 7);

const ilYA = (jours: number) => new Date(Date.now() - jours * 86400_000).toISOString();

Deno.serve(async (req) => {
  if (req.headers.get("x-cron-secret") !== Deno.env.get("CRON_SECRET")) {
    return new Response("non autorisé", { status: 401 });
  }
  const sb = admin();
  const bilan = { bilansSupprimes: 0, leadsSupprimes: 0, orphelinsSupprimes: 0 };

  // 1. bilans périmés — on garde la ligne (statistiques, historique commercial)
  if (RETENTION_BILAN > 0) {
    const { data: vieux } = await sb.from("leads")
      .select("id, bilan_chemin")
      .eq("bilan_fourni", true).not("bilan_chemin", "is", null)
      .lt("created_at", ilYA(RETENTION_BILAN));

    const chemins = (vieux ?? []).map((l) => l.bilan_chemin!).filter(Boolean);
    if (chemins.length) {
      const { error } = await sb.storage.from(BUCKET).remove(chemins);
      if (error) {
        await alerter(sb, "avertissement", "Purge des bilans incomplète", error.message);
      } else {
        await sb.from("leads")
          .update({ bilan_chemin: null, bilan_type: "supprime_retention" })
          .in("id", (vieux ?? []).map((l) => l.id));
        bilan.bilansSupprimes = chemins.length;
      }
    }
  }

  // 2. leads périmés
  if (RETENTION_LEAD > 0) {
    const { data: expires } = await sb.from("leads")
      .select("id, bilan_chemin").lt("created_at", ilYA(RETENTION_LEAD));
    if (expires?.length) {
      const restants = expires.map((l) => l.bilan_chemin).filter(Boolean) as string[];
      if (restants.length) await sb.storage.from(BUCKET).remove(restants);
      await sb.from("leads").delete().in("id", expires.map((l) => l.id));
      bilan.leadsSupprimes = expires.length;
    }
  }

  // 3. orphelins : fichier envoyé mais formulaire jamais validé. Sans ligne de
  //    lead, un tel fichier n'a ni nom de garage ni contact : il est inexploitable.
  const { data: reference } = await sb.from("leads").select("bilan_chemin").not("bilan_chemin", "is", null);
  const connus = new Set((reference ?? []).map((l) => l.bilan_chemin));
  const limite = Date.now() - ORPHELIN_JOURS * 86400_000;

  for (const dossier of await listerDossiers(sb)) {
    const { data: objets } = await sb.storage.from(BUCKET).list(dossier, { limit: 1000 });
    const aSupprimer = (objets ?? [])
      .filter((o) => !connus.has(`${dossier}/${o.name}`) &&
        new Date(o.created_at ?? 0).getTime() < limite)
      .map((o) => `${dossier}/${o.name}`);
    if (aSupprimer.length) {
      await sb.storage.from(BUCKET).remove(aSupprimer);
      bilan.orphelinsSupprimes += aSupprimer.length;
    }
  }

  // 4. journaux de limitation de débit
  await sb.from("hits").delete().lt("created_at", ilYA(1));

  console.log("[purge]", bilan);
  return Response.json(bilan);
});

/** Le bucket est organisé en AAAA/MM/uuid.ext */
async function listerDossiers(sb: ReturnType<typeof admin>): Promise<string[]> {
  const dossiers: string[] = [];
  const { data: annees } = await sb.storage.from(BUCKET).list("", { limit: 100 });
  for (const annee of annees ?? []) {
    if (annee.id) continue;                                  // id non nul = fichier, pas dossier
    const { data: mois } = await sb.storage.from(BUCKET).list(annee.name, { limit: 100 });
    for (const m of mois ?? []) if (!m.id) dossiers.push(`${annee.name}/${m.name}`);
  }
  return dossiers;
}

