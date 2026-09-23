// File de reprise : réessaie les notifications qui ont échoué.
// Déclenchée par pg_cron (cf. README, §5). Protégée par CRON_SECRET.

import { admin, alerter } from "../_partage/commun.ts";
import { envoyerNotification, type Lead } from "../_partage/mail.ts";

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
