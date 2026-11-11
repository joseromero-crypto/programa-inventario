-- Plan storage for the phase 1 generator (src/generator), plus Masterview reads it needs.
-- Only ic_ objects are changed. mv_products / mv_product_city are read, never altered.
-- All plan tables are empty when this runs (no plan has been saved yet).

-- ───────────── plans: cycle length and mode are part of the plan ─────────────
alter table public.ic_plans
  add column cycle_weeks   int  not null default 4 check (cycle_weeks between 1 and 8),
  add column rotation_mode text not null default 'physical' check (rotation_mode in ('physical','tier_order')),
  add column report        jsonb not null default '{}';   -- generator load report (Spanish messages included)

-- ───────────── slots: up to 8 weeks, global week, the extra block ─────────────
alter table public.ic_slots drop constraint ic_slots_week_check;
alter table public.ic_slots add constraint ic_slots_week_check check (week between 1 and 8);
alter table public.ic_slots
  add column global_week int not null check (global_week >= 1),
  add column extra boolean not null default false,          -- "Ubicaciones sin identificar" block, outside capacity
  add column notes text[] not null default '{}';
-- Capacity per day is weekly capacity ÷ workdays (e.g. 240 / 5 = 48, 300 / 4 = 75, 700 / 6 = 116.7).
alter table public.ic_slots alter column capacity type numeric(8,2);
-- A role can have its normal slot and the extra block on the same day.
alter table public.ic_slots drop constraint ic_slots_plan_id_day_role_id_key;
alter table public.ic_slots add constraint ic_slots_plan_day_role_extra_key unique (plan_id, day, role_id, extra);

-- ───────────── slot units: generator location kinds, layer, load ─────────────
alter table public.ic_slot_units drop constraint ic_slot_units_unit_kind_check;
alter table public.ic_slot_units add constraint ic_slot_units_unit_kind_check
  check (unit_kind in ('shelf','aisle_only','freezer','cold_room','unidentified'));
alter table public.ic_slot_units
  add column layer text not null check (layer in ('tier0','freezer','rotation','tier_weekly','unidentified')),
  add column load numeric(8,2) not null default 0 check (load >= 0),        -- SKUs per sizing_basis
  add column sku_count int not null default 0 check (sku_count >= 0),       -- SKUs placed on the location
  add column loose_count numeric(8,2) not null default 0 check (loose_count >= 0); -- share of the aisle's sin-estante SKUs
create index ic_slot_units_plan_layer on public.ic_slot_units (plan_id, layer);

-- ───────────── weekly close tables follow the cycle length ─────────────
alter table public.ic_week_closes drop constraint ic_week_closes_week_check;
alter table public.ic_week_closes add constraint ic_week_closes_week_check check (week between 1 and 8);
alter table public.ic_unit_week_state drop constraint ic_unit_week_state_week_check;
alter table public.ic_unit_week_state add constraint ic_unit_week_state_week_check check (week between 1 and 8);

-- ───────────── Masterview reads ─────────────
-- Same return type as before (jsonb array of arrays); a 6th element is appended: the
-- "Assembly Category" (Frutas y verduras / Carnes / Abarrotes). main_category is the web taxonomy.
create or replace function public.ic_mv_products()
returns jsonb
language sql
stable security definer
set search_path to ''
as $$
  select coalesce(jsonb_agg(jsonb_build_array(
           p.sku, p.barcode, p.main_category, p.calii_unit, p.temp,
           p.raw->>'Assembly Category (options are: frutas y verduras, carnes, abarrotes)'
         ) order by p.sku), '[]'::jsonb)
  from public.mv_products p
  where p.raw->>'retired_at' is null
$$;

-- Tiers for one city (hub-rules 2.1): [[sku, tiers], ...]. city as in ic_hub_config (lowercase).
create function public.ic_mv_tiers(p_city text)
returns jsonb
language sql
stable security definer
set search_path to ''
as $$
  select coalesce(jsonb_agg(jsonb_build_array(c.sku, c.tiers) order by c.sku), '[]'::jsonb)
  from public.mv_product_city c
  where lower(c.city) = lower(p_city)
$$;
revoke all on function public.ic_mv_tiers(text) from public;
grant execute on function public.ic_mv_tiers(text) to anon, authenticated;
