-- Planification des tâches de fond (à exécuter APRÈS le déploiement des
-- fonctions, dans Dashboard > SQL Editor).
--
-- ⚠️ REMPLACER AVANT D'EXÉCUTER :
--    VOTRE-PROJET   -> la référence de votre projet Supabase
--    VOTRE_SECRET   -> la valeur exacte du secret CRON_SECRET

create extension if not exists pg_cron  with schema extensions;
create extension if not exists pg_net   with schema extensions;

-- Reprise des mails en échec, toutes les 15 minutes.
select cron.schedule(
  'atlas-relance-mail', '*/15 * * * *',
  $$
  select net.http_post(
    url     := 'https://VOTRE-PROJET.supabase.co/functions/v1/relance-mail',
    headers := '{"Content-Type":"application/json","x-cron-secret":"VOTRE_SECRET"}'::jsonb,
    body    := '{}'::jsonb
  );
  $$
);

-- Purge de rétention, tous les jours à 3 h 30 UTC.
select cron.schedule(
  'atlas-purge', '30 3 * * *',
  $$
  select net.http_post(
    url     := 'https://VOTRE-PROJET.supabase.co/functions/v1/purge',
    headers := '{"Content-Type":"application/json","x-cron-secret":"VOTRE_SECRET"}'::jsonb,
    body    := '{}'::jsonb
  );
  $$
);

-- Vérifier :   select jobname, schedule, active from cron.job;
-- Historique : select * from cron.job_run_details order by start_time desc limit 20;
-- Retirer :    select cron.unschedule('atlas-relance-mail');
