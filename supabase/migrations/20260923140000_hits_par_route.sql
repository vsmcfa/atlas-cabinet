-- Correctif : la limitation de débit comptait TOUTES les requêtes d'une IP,
-- sans distinguer la route. Conséquence observée en production : les envois du
-- formulaire consommaient le budget de connexion à la console d'administration,
-- et toute l'équipe se retrouvait verrouillée derrière l'IP du bureau parce
-- qu'un prospect avait rempli le formulaire depuis le même réseau.
--
-- Chaque route a désormais son propre compteur.

drop function if exists public.compter_hits(inet, int);

create or replace function public.compter_hits(p_ip inet, p_route text, p_fenetre_minutes int)
returns integer
language sql
security definer
set search_path = public
as $$
  select count(*)::int from public.hits
  where ip = p_ip
    and route = p_route
    and created_at > now() - make_interval(mins => p_fenetre_minutes);
$$;

comment on function public.compter_hits is
  'Compte les requêtes d''une IP SUR UNE ROUTE donnée. Le filtre sur la route
   est essentiel : sans lui, le trafic du formulaire ferme la porte de l''admin.';

-- Remise à zéro unique : la table ne contient que de la comptabilité éphémère
-- (la purge quotidienne la vide déjà au-delà de 24 h). Cela libère les accès
-- bloqués par l'ancien comptage.
delete from public.hits;
