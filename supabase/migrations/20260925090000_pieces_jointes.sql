-- Plusieurs pièces jointes par réponse, ajoutables après coup.
--
-- Jusqu'ici un lead portait au plus un bilan, dans ses colonnes bilan_*. Un
-- dirigeant qui envoyait son formulaire sans document ne pouvait plus rien
-- joindre, et l'équipe devait réclamer le bilan par mail sans pouvoir le
-- rattacher au dossier. Les documents deviennent une table à part.

create table if not exists public.pieces_jointes (
  id          uuid primary key default gen_random_uuid(),
  lead_id     uuid not null references public.leads(id) on delete cascade,
  created_at  timestamptz not null default now(),

  chemin      text   not null unique,   -- chemin dans le bucket privé « bilans »
  nom         text   not null,          -- nom déclaré, assaini — jamais utilisé comme chemin
  taille      bigint not null,
  type        text   not null,          -- type réel détecté par les octets d'en-tête

  -- « formulaire » : jointe par le dirigeant. « console » : ajoutée par l'équipe.
  origine     text not null default 'formulaire'
              check (origine in ('formulaire', 'console'))
);

create index if not exists pieces_lead_idx on public.pieces_jointes (lead_id, created_at);
alter table public.pieces_jointes enable row level security;
-- aucune policy : seules les Edge Functions (service_role) y accèdent.

comment on table public.pieces_jointes is
  'Documents rattachés à une réponse. Le fichier vit dans le bucket privé ; ici on
   ne garde que sa référence. La suppression d''un lead emporte ses pièces.';

-- ------------------------------------------------- compteur sur les leads

alter table public.leads add column if not exists nb_pieces integer not null default 0;

/* bilan_fourni et nb_pieces sont dérivés : les tenir à jour par déclencheur
   évite qu'ils divergent de la réalité, ce qui arriverait fatalement si
   chaque appelant devait y penser. */
create or replace function public.maj_compteur_pieces()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  cible uuid := coalesce(new.lead_id, old.lead_id);
begin
  update public.leads l
  set nb_pieces    = c.n,
      bilan_fourni = c.n > 0
  from (select count(*)::int as n from public.pieces_jointes where lead_id = cible) c
  where l.id = cible;
  return null;
end;
$$;

drop trigger if exists trg_compteur_pieces on public.pieces_jointes;
create trigger trg_compteur_pieces
after insert or delete on public.pieces_jointes
for each row execute function public.maj_compteur_pieces();

-- --------------------------------------------- reprise des bilans existants

insert into public.pieces_jointes (lead_id, created_at, chemin, nom, taille, type, origine)
select id, created_at, bilan_chemin,
       coalesce(bilan_nom_origine, 'bilan'),
       coalesce(bilan_taille, 0),
       coalesce(bilan_type, 'application/pdf'),
       'formulaire'
from public.leads
where bilan_chemin is not null
on conflict (chemin) do nothing;

-- Les colonnes bilan_* n'ont plus de raison d'être : laisser des champs morts
-- derrière soi est le meilleur moyen qu'ils soient relus un jour comme vrais.
-- La vue qui s'y appuie est reconstruite plus bas.
drop view if exists public.v_leads;

alter table public.leads
  drop column if exists bilan_chemin,
  drop column if exists bilan_nom_origine,
  drop column if exists bilan_taille,
  drop column if exists bilan_type;

-- ------------------------------------------------------------- vues admin

create or replace view public.v_leads as
select
  l.reference, l.created_at, l.garage, l.dirigeant, l.telephone, l.email, l.salaries,
  array_to_string(l.interets, ' | ') as interets,
  case when l.nb_pieces > 0 then l.nb_pieces::text || ' document(s)' else 'AUCUN' end as pieces,
  l.commercial, l.mail_statut, l.id
from public.leads l
order by l.created_at desc;

comment on view public.v_leads is
  'Écran d''administration : ouvrir dans le Table Editor, exportable en CSV.';
