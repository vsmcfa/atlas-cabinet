-- ATLAS — schéma des soumissions du formulaire garage
-- Tout est en schéma public (visible dans le Table Editor Supabase),
-- mais RLS est activé SANS AUCUNE POLICY : seule la clé service_role
-- (utilisée par les Edge Functions) peut lire et écrire.

-- ---------------------------------------------------------------- leads

create table if not exists public.leads (
  id                uuid primary key default gen_random_uuid(),
  reference         text generated always as (upper(substr(replace(id::text,'-',''),1,8))) stored,
  created_at        timestamptz not null default now(),

  -- champs du formulaire
  garage            text        not null,
  dirigeant         text        not null,
  telephone         text        not null,
  email             text        not null,
  salaries          integer     not null,
  interets          text[]      not null,

  -- bilan comptable (facultatif — cf. §7 du brief)
  bilan_fourni      boolean     not null default false,
  bilan_chemin      text,                 -- chemin dans le bucket privé "bilans"
  bilan_nom_origine text,                 -- nom déclaré par le navigateur, assaini
  bilan_taille      bigint,
  bilan_type        text,                 -- type réel détecté par les octets d'en-tête

  -- traçabilité
  commercial        text,                 -- ?c=DUPONT
  ip                inet,
  user_agent        text,
  remplissage_ms    integer,              -- temps de remplissage, anti-bot

  -- état de la notification e-mail
  mail_statut       text        not null default 'en_attente'
                                check (mail_statut in ('en_attente','envoye','echec')),
  mail_tentatives   integer     not null default 0,
  mail_erreur       text,
  mail_envoye_at    timestamptz,
  mail_piece_jointe boolean     not null default false  -- false = lien signé dans le mail
);

create index if not exists leads_created_at_idx on public.leads (created_at desc);
create index if not exists leads_mail_statut_idx on public.leads (mail_statut) where mail_statut <> 'envoye';
create index if not exists leads_commercial_idx  on public.leads (commercial);

alter table public.leads enable row level security;
-- aucune policy : deny-all pour anon et authenticated. service_role contourne RLS.

comment on table public.leads is
  'Soumissions du formulaire ATLAS. Le mail n''est PAS l''unique copie : cette table fait foi.';

-- --------------------------------------------------------------- rejets
-- §5.3 du brief : les rejets anti-robot sont JOURNALISÉS, jamais jetés en silence.

create table if not exists public.rejets (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  motif       text not null,   -- honeypot | trop_rapide | type_fichier | taille | rate_limit | validation
  detail      text,
  ip          inet,
  user_agent  text,
  charge      jsonb            -- ce qui avait été envoyé, pour pouvoir récupérer un faux positif
);

create index if not exists rejets_created_at_idx on public.rejets (created_at desc);
alter table public.rejets enable row level security;

comment on table public.rejets is
  'Toute soumission refusée atterrit ici. Un vrai prospect faussement rejeté reste récupérable.';

-- ---------------------------------------------------------------- hits
-- Limitation de débit par IP (pas de captcha : il ferait chuter la complétion).

create table if not exists public.hits (
  id         bigserial primary key,
  created_at timestamptz not null default now(),
  ip         inet not null,
  route      text not null
);

create index if not exists hits_ip_created_at_idx on public.hits (ip, created_at desc);
alter table public.hits enable row level security;

create or replace function public.compter_hits(p_ip inet, p_fenetre_minutes int)
returns integer
language sql
security definer
set search_path = public
as $$
  select count(*)::int from public.hits
  where ip = p_ip and created_at > now() - make_interval(mins => p_fenetre_minutes);
$$;

-- -------------------------------------------------------------- alertes
-- §5.4 : aucun chemin où une soumission est acceptée sans générer d'alerte.

create table if not exists public.alertes (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  niveau     text not null check (niveau in ('info','avertissement','critique')),
  sujet      text not null,
  detail     text,
  lead_id    uuid references public.leads(id) on delete set null,
  traitee    boolean not null default false
);

create index if not exists alertes_ouvertes_idx on public.alertes (created_at desc) where not traitee;
alter table public.alertes enable row level security;

-- ------------------------------------------------------------ vues admin

create or replace view public.v_leads as
select
  l.reference,
  l.created_at,
  l.garage,
  l.dirigeant,
  l.telephone,
  l.email,
  l.salaries,
  array_to_string(l.interets, ' | ') as interets,
  case when l.bilan_fourni then 'oui' else 'AUCUN BILAN' end as bilan,
  round(l.bilan_taille / 1048576.0, 1) as bilan_mo,
  l.commercial,
  l.mail_statut,
  l.id,
  l.bilan_chemin
from public.leads l
order by l.created_at desc;

comment on view public.v_leads is
  'Écran d''administration : ouvrir dans le Table Editor, exportable en CSV.';

create or replace view public.v_a_traiter as
select l.reference, l.created_at, l.garage, l.email, l.mail_statut, l.mail_tentatives, l.mail_erreur
from public.leads l
where l.mail_statut <> 'envoye'
order by l.created_at;

comment on view public.v_a_traiter is
  'Leads enregistrés dont le mail n''est pas parti. À surveiller quotidiennement.';

-- --------------------------------------------------------------- storage
-- Bucket PRIVÉ. Aucune policy sur storage.objects => seul service_role y accède.
-- Les bilans ne sont jamais servis en URL publique, uniquement en URL signée.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'bilans', 'bilans', false, 20971520,
  array['application/pdf','image/jpeg','image/png','image/heic','image/heif']
)
on conflict (id) do update set
  public             = excluded.public,
  file_size_limit    = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
