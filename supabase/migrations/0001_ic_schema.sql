-- inventario-conf: schema (spec section 3, phase 0 setup 0.2)
-- Every object is prefixed ic_. Nothing outside ic_ is altered.
-- Access model:
--   anon/authenticated: SELECT on config, plan, live-input and freshness tables only.
--   All writes go through Edge Functions using the service role (bypasses RLS).
--   Confirmation events and logins hold e-mail addresses, so they are NOT readable by anon;
--   the app reads aggregates through security-definer RPCs instead.

-- ───────────────────────── config ─────────────────────────

create table public.ic_hub_config (
  hub_slug          text primary key,                       -- 'mh-contry'
  login_id          text not null unique,                   -- 'con' (suffix in aux.*.<id>)
  display_name      text not null,
  active            boolean not null default true,
  workdays          int[] not null default '{2,3,4,5}',     -- 1=Mon .. 7=Sun
  turno_split       time not null default '14:00',
  sizing_basis      text not null default 'positive' check (sizing_basis in ('positive','catalog')),
  moved_threshold   int not null default 20 check (moved_threshold > 0),
  done_ratio        numeric(4,3) not null default 0.8 check (done_ratio > 0 and done_ratio <= 1),
  late_window_days  int not null default 2 check (late_window_days >= 0),
  sheet_aliases     text[] not null default '{}',           -- extra spellings of the sheet's Hub column
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check (workdays <@ '{1,2,3,4,5,6,7}'::int[] and cardinality(workdays) > 0)
);

create table public.ic_roles (
  id               bigint generated always as identity primary key,
  hub_slug         text not null references public.ic_hub_config(hub_slug) on update cascade,
  role_key         text not null check (role_key in ('aux_inv','lider_am','lider_pm','aux_rec','aux_cal')),
  label            text not null,
  weekly_capacity  int not null default 0 check (weekly_capacity >= 0),  -- SKUs / week
  days             int[] not null,                                       -- 1=Mon .. 7=Sun
  active           boolean not null default true,
  unique (hub_slug, role_key),
  check (days <@ '{1,2,3,4,5,6,7}'::int[])
);

-- login → role. Matched on the full e-mail first, then on the local part (before '@').
-- assign = a role_key, 'by_turno' (lider_am / lider_pm from the Turno column),
-- or 'by_category' (role from category_map, keyed by Categoría Final, '*' = fallback).
-- Logins not listed here are attributed to 'extra'.
create table public.ic_logins (
  hub_slug      text not null references public.ic_hub_config(hub_slug) on update cascade,
  login         text not null check (login = lower(login)),
  assign        text not null check (assign in ('aux_inv','lider_am','lider_pm','aux_rec','aux_cal','by_turno','by_category')),
  category_map  jsonb check (category_map is null or jsonb_typeof(category_map) = 'object'),
  note          text,
  primary key (hub_slug, login),
  check ((assign = 'by_category') = (category_map is not null))
);

-- Per-hub location rules, first match (lowest priority) wins.
-- match_regex / normalize_to use JavaScript RegExp syntax ($1 back-references); they are
-- evaluated by the TS generator, not by Postgres.
create table public.ic_location_rules (
  id            bigint generated always as identity primary key,
  hub_slug      text not null references public.ic_hub_config(hub_slug) on update cascade,
  priority      int not null,
  match_regex   text not null,
  normalize_to  text,                 -- null = keep the matched code
  kind          text not null check (kind in ('shelf_aisle','freezer','cold_room','ignore')),
  group_label   text,
  note          text,
  active        boolean not null default true,
  unique (hub_slug, priority)
);

-- Single-row table: the global week index anchor.
create table public.ic_cycle (
  id             boolean primary key default true check (id),
  anchor_monday  date not null check (extract(isodow from anchor_monday) = 1)
);

-- ───────────────────────── live inputs ─────────────────────────

create table public.ic_sku_locations (
  id               bigint generated always as identity primary key,
  hub_slug         text not null references public.ic_hub_config(hub_slug) on update cascade,
  barcode          text,
  sku              text,
  name             text,
  unit_key         text,
  unit_kind        text check (unit_kind in ('shelf_aisle','freezer','cold_room','ignore')),
  raw_pos          text,
  nivel            text,
  temp             text,
  calii_unit       text,
  assembly_cat     text,
  tier0            boolean not null default false,
  exception_code   text check (exception_code in ('NO_POSITION','AISLE_ONLY','UNKNOWN_CODE','FROZEN_NO_FREEZER','NOT_IN_MV','DUP_POSITION')),
  sorting_version  text not null,
  updated_at       timestamptz not null default now()
);
create index ic_sku_locations_hub_unit on public.ic_sku_locations (hub_slug, unit_key);
create index ic_sku_locations_hub_sku  on public.ic_sku_locations (hub_slug, sku);

-- ───────────────────────── plan ─────────────────────────

create table public.ic_plans (
  id                 bigint generated always as identity primary key,
  hub_slug           text not null references public.ic_hub_config(hub_slug) on update cascade,
  cycle_no           int not null,
  cycle_start        date not null check (extract(isodow from cycle_start) = 1),
  status             text not null default 'draft' check (status in ('draft','active','closed')),
  generator_version  text not null,
  params             jsonb not null default '{}',
  created_at         timestamptz not null default now(),
  activated_at       timestamptz
);
-- At most one active plan per hub.
create unique index ic_plans_one_active on public.ic_plans (hub_slug) where status = 'active';

create table public.ic_slots (
  id        bigint generated always as identity primary key,
  plan_id   bigint not null references public.ic_plans(id) on delete cascade,
  week      int not null check (week between 1 and 4),
  day       date not null,
  role_id   bigint not null references public.ic_roles(id),
  capacity  int not null check (capacity >= 0),
  unique (plan_id, day, role_id)
);

create table public.ic_slot_units (
  id         bigint generated always as identity primary key,
  plan_id    bigint not null references public.ic_plans(id) on delete cascade,
  slot_id    bigint not null references public.ic_slots(id) on delete cascade,
  unit_key   text not null,
  unit_kind  text not null check (unit_kind in ('shelf_aisle','freezer','cold_room')),
  seq        int not null,
  origin     text not null default 'generated' check (origin in ('generated','coordinator','auto_new_unit','rebalance')),
  added_at   timestamptz not null default now()
);
create index ic_slot_units_slot on public.ic_slot_units (slot_id, seq);
create index ic_slot_units_plan_unit on public.ic_slot_units (plan_id, unit_key);

create table public.ic_plan_log (
  id       bigint generated always as identity primary key,
  plan_id  bigint not null references public.ic_plans(id) on delete cascade,
  at       timestamptz not null default now(),
  actor    text not null,
  action   text not null,
  detail   jsonb not null default '{}'
);
create index ic_plan_log_plan on public.ic_plan_log (plan_id, at);

-- ───────────────────────── weekly close ─────────────────────────

create table public.ic_week_closes (
  plan_id          bigint not null references public.ic_plans(id) on delete cascade,
  week             int not null check (week between 1 and 4),
  closed_at        timestamptz not null default now(),
  sorting_version  text not null,
  summary          jsonb not null default '{}',
  primary key (plan_id, week)
);

create table public.ic_unit_week_state (
  plan_id                bigint not null references public.ic_plans(id) on delete cascade,
  week                   int not null check (week between 1 and 4),
  unit_key               text not null,
  skus_at_close          int not null default 0,
  skus_confirmed         int not null default 0,
  skus_pending           int not null default 0,
  moved_in_after_visit   int not null default 0,
  primary key (plan_id, week, unit_key)
);

-- ───────────────────────── confirmations ─────────────────────────

create table public.ic_conf_imports (
  id            bigint generated always as identity primary key,
  source        text not null,
  rows_in       int not null default 0,
  rows_new      int not null default 0,
  duplicates    int not null default 0,
  rejected      int not null default 0,
  first_row     int,
  last_row      int,
  max_event_ts  timestamptz,
  at            timestamptz not null default now()
);
create index ic_conf_imports_at on public.ic_conf_imports (source, at desc);

create table public.ic_conf_events (
  id                bigint generated always as identity primary key,
  hub_slug          text not null references public.ic_hub_config(hub_slug) on update cascade,
  sku               text not null,
  barcode           text,
  login             text,
  role_key          text not null check (role_key in ('aux_inv','lider_am','lider_pm','aux_rec','aux_cal','extra')),
  turno             text,
  local_date        date not null,                 -- event_ts in America/Monterrey
  event_ts          timestamptz not null,          -- Actualización confirmación
  fecha_inventario  date,
  qty_manual        numeric,                       -- Nro. de unidades [MANUAL]
  qty_auto          numeric,                       -- Final [AUTO]
  qty_app           numeric,                       -- Inv. disponible app
  delta             numeric,                       -- Delta Final
  delta_money       numeric,                       -- Delta $
  categoria         text,                          -- Categoría Final
  tiers             text,
  kg_pz             text,
  posicion          text,                          -- Posición inventario
  src_key           text not null unique,          -- hub_slug|sku|event_ts (UTC ISO)
  import_id         bigint references public.ic_conf_imports(id)
);
create index ic_conf_events_hub_date on public.ic_conf_events (hub_slug, local_date);
create index ic_conf_events_hub_sku  on public.ic_conf_events (hub_slug, sku, event_ts desc);

create table public.ic_ingest_cursors (
  source_name     text primary key,
  last_row        int not null default 1,          -- last sheet row stored (1 = header)
  last_event_ts   timestamptz,
  row_count_seen  int,
  updated_at      timestamptz not null default now()
);

create table public.ic_exceptions (
  id             bigint generated always as identity primary key,
  hub_slug       text not null references public.ic_hub_config(hub_slug) on update cascade,
  sku            text,
  barcode        text,
  code           text not null check (code in ('NO_POSITION','AISLE_ONLY','UNKNOWN_CODE','FROZEN_NO_FREEZER','NOT_IN_MV','DUP_POSITION')),
  owner_role_id  bigint references public.ic_roles(id),
  status         text not null default 'open' check (status in ('open','closed')),
  first_seen     timestamptz not null default now(),
  last_seen      timestamptz not null default now(),
  note           text,
  check (sku is not null or barcode is not null)
);
create index ic_exceptions_hub_open on public.ic_exceptions (hub_slug) where status = 'open';

-- Last confirmation per hub+sku within 60 days (spec 2.4).
-- security_invoker: callers only see what RLS on ic_conf_events lets them see.
create view public.ic_sku_stock_est with (security_invoker = true) as
select distinct on (e.hub_slug, e.sku)
  e.hub_slug,
  e.sku,
  coalesce(e.qty_app, e.qty_auto) as last_qty,
  e.event_ts                      as last_conf_at
from public.ic_conf_events e
where e.event_ts >= now() - interval '60 days'
order by e.hub_slug, e.sku, e.event_ts desc;

-- ───────────────────────── RLS ─────────────────────────

do $$
declare
  t text;
  all_tables text[] := array[
    'ic_hub_config','ic_roles','ic_logins','ic_location_rules','ic_cycle',
    'ic_sku_locations','ic_plans','ic_slots','ic_slot_units','ic_plan_log',
    'ic_week_closes','ic_unit_week_state','ic_conf_imports','ic_conf_events',
    'ic_ingest_cursors','ic_exceptions'];
  -- readable by the public app (no e-mails in these)
  public_read text[] := array[
    'ic_hub_config','ic_roles','ic_location_rules','ic_cycle',
    'ic_sku_locations','ic_plans','ic_slots','ic_slot_units','ic_plan_log',
    'ic_week_closes','ic_unit_week_state','ic_conf_imports',
    'ic_ingest_cursors','ic_exceptions'];
begin
  foreach t in array all_tables loop
    execute format('alter table public.%I enable row level security', t);
    -- defense in depth: no direct writes from client roles, even if a policy is added by mistake
    execute format('revoke insert, update, delete, truncate on public.%I from anon, authenticated', t);
  end loop;
  foreach t in array public_read loop
    execute format('create policy ic_public_read on public.%I for select to anon, authenticated using (true)', t);
  end loop;
end $$;

revoke all on public.ic_sku_stock_est from anon, authenticated;

-- ───────────────────────── RPCs ─────────────────────────

-- Masterview columns this app needs, for the anon client (mv_products is authenticated-only).
-- Returns one jsonb array of [sku, barcode, main_category, calii_unit, temp] so PostgREST's
-- row cap does not truncate the ~5.5k products.
create function public.ic_mv_products()
returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_array(p.sku, p.barcode, p.main_category, p.calii_unit, p.temp) order by p.sku), '[]'::jsonb)
  from public.mv_products p
  where p.raw->>'retired_at' is null
$$;

-- Freshness for Admin › Fuentes: Masterview import, ingest cursors, per-hub confirmations.
create function public.ic_source_freshness()
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
        'last_event_ts', (select max(e.event_ts) from public.ic_conf_events e where e.hub_slug = h.hub_slug),
        'total', (select count(*) from public.ic_conf_events e where e.hub_slug = h.hub_slug),
        'daily', (
          select coalesce(jsonb_agg(jsonb_build_object('d', g.d, 'n', coalesce(x.n, 0)) order by g.d), '[]'::jsonb)
          from (select (select d from today) - i as d from generate_series(0, 13) i) g
          left join (
            select e.local_date, count(*) n from public.ic_conf_events e
            where e.hub_slug = h.hub_slug and e.local_date >= (select d from today) - 13
            group by e.local_date) x on x.local_date = g.d)
      ) order by h.hub_slug), '[]'::jsonb)
      from public.ic_hub_config h)
  )
$$;

revoke all on function public.ic_mv_products() from public;
revoke all on function public.ic_source_freshness() from public;
grant execute on function public.ic_mv_products() to anon, authenticated;
grant execute on function public.ic_source_freshness() to anon, authenticated;

-- Ingest a batch of already-parsed confirmation rows (called by sheet-ingest, service role only).
-- p_rows: jsonb array of objects with ic_conf_events column names (minus id/import_id).
create function public.ic_ingest_conf(
  p_source text, p_rows jsonb, p_first_row int, p_last_row int,
  p_sheet_row_count int, p_rejected int, p_dry boolean)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_import_id bigint;
  v_in        int;
  v_inserted  int := 0;
  v_existing  int := 0;
  v_max_ts    timestamptz;
begin
  create temp table _ic_in on commit drop as
  select * from jsonb_to_recordset(p_rows) as r(
    hub_slug text, sku text, barcode text, login text, role_key text, turno text,
    local_date date, event_ts timestamptz, fecha_inventario date,
    qty_manual numeric, qty_auto numeric, qty_app numeric, delta numeric, delta_money numeric,
    categoria text, tiers text, kg_pz text, posicion text, src_key text);

  select count(*), max(event_ts) into v_in, v_max_ts from _ic_in;

  if p_dry then
    select count(*) into v_existing from _ic_in i join public.ic_conf_events e using (src_key);
    return jsonb_build_object('dry', true, 'received', v_in, 'would_insert', v_in - v_existing,
                              'duplicates', v_existing, 'rejected', p_rejected, 'max_event_ts', v_max_ts);
  end if;

  insert into public.ic_conf_imports (source, rows_in, rejected, first_row, last_row, max_event_ts)
  values (p_source, v_in, p_rejected, p_first_row, p_last_row, v_max_ts)
  returning id into v_import_id;

  insert into public.ic_conf_events (
    hub_slug, sku, barcode, login, role_key, turno, local_date, event_ts, fecha_inventario,
    qty_manual, qty_auto, qty_app, delta, delta_money, categoria, tiers, kg_pz, posicion, src_key, import_id)
  select hub_slug, sku, barcode, login, role_key, turno, local_date, event_ts, fecha_inventario,
    qty_manual, qty_auto, qty_app, delta, delta_money, categoria, tiers, kg_pz, posicion, src_key, v_import_id
  from _ic_in
  on conflict (src_key) do nothing;
  get diagnostics v_inserted = row_count;

  update public.ic_conf_imports set rows_new = v_inserted, duplicates = v_in - v_inserted where id = v_import_id;

  insert into public.ic_ingest_cursors as c (source_name, last_row, last_event_ts, row_count_seen, updated_at)
  values (p_source, p_last_row, v_max_ts, p_sheet_row_count, now())
  on conflict (source_name) do update set
    last_row       = excluded.last_row,
    last_event_ts  = greatest(c.last_event_ts, excluded.last_event_ts),
    row_count_seen = excluded.row_count_seen,
    updated_at     = now();

  return jsonb_build_object('dry', false, 'import_id', v_import_id, 'received', v_in,
                            'inserted', v_inserted, 'duplicates', v_in - v_inserted,
                            'rejected', p_rejected, 'cursor', p_last_row);
end
$$;

revoke all on function public.ic_ingest_conf(text, jsonb, int, int, int, int, boolean) from public, anon, authenticated;
grant execute on function public.ic_ingest_conf(text, jsonb, int, int, int, int, boolean) to service_role;
