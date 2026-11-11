-- Hub profiles (hub-rules §1, §1.1, §3): city for per-city tiers, cycle length,
-- rotation mode and walking order. Condesa and Zapopan move to Mon–Fri.

alter table public.ic_hub_config
  add column city          text,
  add column cycle_weeks   int  not null default 4 check (cycle_weeks between 1 and 8),
  add column rotation_mode text not null default 'physical' check (rotation_mode in ('physical','tier_order')),
  add column walking_order text[] not null default '{}';   -- aisles in walking order; empty = alphabetical

update public.ic_hub_config h set city = s.city
from (values
  ('mh-contry',      'monterrey'),
  ('mh-cumbres',     'monterrey'),
  ('mh-guadalupe',   'monterrey'),
  ('mh-san-nicolas', 'monterrey'),
  ('ch-guadalupe',   'monterrey'),
  ('mh-avicola',     'saltillo'),
  ('mh-condesa',     'cdmx'),
  ('mh-zapopan',     'guadalajara')
) as s(slug, city)
where h.hub_slug = s.slug;

-- Fails loudly if a hub was left without a city.
alter table public.ic_hub_config
  alter column city set not null,
  add constraint ic_hub_config_city_check check (city in ('monterrey','saltillo','cdmx','guadalajara'));

-- Centro/Oeste profile: Mon–Fri. Contry stays Tue–Fri.
update public.ic_hub_config
set workdays = '{1,2,3,4,5}', updated_at = now()
where hub_slug in ('mh-condesa', 'mh-zapopan');

update public.ic_roles
set days = '{1,2,3,4,5}'
where hub_slug in ('mh-condesa', 'mh-zapopan');
