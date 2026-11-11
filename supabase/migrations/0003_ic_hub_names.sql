-- Hub display: "MH <name>", picker order, and CH Guadalupe listed last (v2: shown, not in the plan yet).

alter table public.ic_hub_config
  add column sort_order int not null default 100,
  add column in_plan boolean not null default true;

-- login_id only feeds the aux.*.<id> login seeds; CH Guadalupe has none yet.
alter table public.ic_hub_config alter column login_id drop not null;

update public.ic_hub_config h set display_name = 'MH ' || h.display_name, sort_order = s.ord
from (values
  ('mh-avicola', 10), ('mh-condesa', 20), ('mh-contry', 30), ('mh-cumbres', 40),
  ('mh-guadalupe', 50), ('mh-san-nicolas', 60), ('mh-zapopan', 70)
) as s(slug, ord)
where h.hub_slug = s.slug;

insert into public.ic_hub_config (hub_slug, login_id, display_name, workdays, sort_order, in_plan)
values ('ch-guadalupe', null, 'CH Guadalupe', '{1,2,3,4,5}', 900, false);

-- Freshness lists hubs in picker order.
create or replace function public.ic_source_freshness()
returns jsonb
language sql stable security definer
set search_path = ''
as $$
  with today as (select (now() at time zone 'America/Monterrey')::date as d)
  select jsonb_build_object(
    'now', now(),
    'today_local', (select d from today),
    'mv', jsonb_build_object(
      'last_import', (select max(uploaded_at) from public.mv_imports),
      'products', (select count(*) from public.mv_products where raw->>'retired_at' is null)),
    'cursors', (select coalesce(jsonb_agg(to_jsonb(c)), '[]'::jsonb) from public.ic_ingest_cursors c),
    'last_import', (select to_jsonb(i) from public.ic_conf_imports i order by at desc limit 1),
    'hubs', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'hub_slug', h.hub_slug,
        'display_name', h.display_name,
        'in_plan', h.in_plan,
        'last_event_ts', (select max(e.event_ts) from public.ic_conf_events e where e.hub_slug = h.hub_slug),
        'total', (select count(*) from public.ic_conf_events e where e.hub_slug = h.hub_slug),
        'daily', (
          select coalesce(jsonb_agg(jsonb_build_object('d', g.d, 'n', coalesce(x.n, 0)) order by g.d), '[]'::jsonb)
          from (select (select d from today) - i as d from generate_series(0, 13) i) g
          left join (
            select e.local_date, count(*) n from public.ic_conf_events e
            where e.hub_slug = h.hub_slug and e.local_date >= (select d from today) - 13
            group by e.local_date) x on x.local_date = g.d)
      ) order by h.sort_order, h.hub_slug), '[]'::jsonb)
      from public.ic_hub_config h
      where h.active)
  )
$$;
