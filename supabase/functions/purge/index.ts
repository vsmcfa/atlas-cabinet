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

import { admin, alerter, BUCKET } from "../_partage/commun.ts";

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
