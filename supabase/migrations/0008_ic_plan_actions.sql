-- Phase 2: plan screens. Only ic_ objects are created or changed.
--   * ic_sku_stock(hub): stock estimates for the generator, without e-mails (anon).
--   * ic_now(): the server clock and Monterrey date, so phones with a wrong clock show the right day (anon).
--   * ic_slot_units gets positive_est ("esperados con stock") and walk_rank (walking order).
--   * ic_plan_save_draft / ic_plan_move / ic_plan_activate: called by the ic-admin Edge Function
--     (service role) after the admin PIN check. Each one is a single transaction and logs to ic_plan_log.

-- ───────────── slot units: what the route shows ─────────────
alter table public.ic_slot_units
  add column positive_est numeric(8,2) not null default 0 check (positive_est >= 0), -- SKUs expected with stock
  add column walk_rank    int not null default 0 check (walk_rank >= 0);            -- position in the hub's walking order

-- ───────────── reads for the anon app ─────────────

-- Last known quantity per SKU at one hub (60 days, view ic_sku_stock_est): [[sku, last_qty], ...].
-- No logins, no dates: only what the generator needs.
create function public.ic_sku_stock(p_hub text)
returns jsonb
language sql
stable security definer
set search_path to ''
as $$
  select coalesce(jsonb_agg(jsonb_build_array(s.sku, s.last_qty) order by s.sku), '[]'::jsonb)
  from public.ic_sku_stock_est s
  where s.hub_slug = p_hub and s.last_qty is not null
$$;
revoke all on function public.ic_sku_stock(text) from public;
grant execute on function public.ic_sku_stock(text) to anon, authenticated;

create function public.ic_now()
returns jsonb
language sql
stable
set search_path to ''
as $$
  select jsonb_build_object('now', now(), 'today_local', (now() at time zone 'America/Monterrey')::date)
$$;
revoke all on function public.ic_now() from public;
grant execute on function public.ic_now() to anon, authenticated;

-- ───────────── plan actions (service role only) ─────────────

-- Save a generated plan as the hub's draft. Earlier drafts of the hub are replaced (drafts are not
-- history); active and closed plans are never touched.
-- p: { hub_slug, cycle_start, cycle_weeks, rotation_mode, generator_version, params, report,
--      slots: [{ week, global_week, day, role, capacity, extra, notes,
--                items: [{ unit_key, unit_kind, layer, load, sku_count, loose_count, positive_est, walk_rank }] }] }
create function public.ic_plan_save_draft(p jsonb, p_actor text)
returns jsonb
language plpgsql
set search_path to ''
as $$
declare
  v_hub      text := p->>'hub_slug';
  v_plan     bigint;
  v_cycle    int;
  v_slot     jsonb;
  v_slot_id  bigint;
  v_role_id  bigint;
  v_replaced int;
  v_slots    int := 0;
  v_units    int := 0;
begin
  if not exists (select 1 from public.ic_hub_config where hub_slug = v_hub) then
    raise exception 'IC_HUB_UNKNOWN: %', v_hub;
  end if;

  delete from public.ic_plans where hub_slug = v_hub and status = 'draft';
  get diagnostics v_replaced = row_count;

  select coalesce(max(cycle_no), 0) + 1 into v_cycle
  from public.ic_plans where hub_slug = v_hub and status in ('active', 'closed');

  insert into public.ic_plans (hub_slug, cycle_no, cycle_start, status, generator_version, params, cycle_weeks, rotation_mode, report)
  values (v_hub, v_cycle, (p->>'cycle_start')::date, 'draft', p->>'generator_version',
          coalesce(p->'params', '{}'), (p->>'cycle_weeks')::int, p->>'rotation_mode', coalesce(p->'report', '{}'))
  returning id into v_plan;

  for v_slot in select * from jsonb_array_elements(p->'slots') loop
    select id into v_role_id from public.ic_roles where hub_slug = v_hub and role_key = v_slot->>'role';
    if v_role_id is null then
      raise exception 'IC_ROLE_UNKNOWN: %', v_slot->>'role';
    end if;
    insert into public.ic_slots (plan_id, week, global_week, day, role_id, capacity, extra, notes)
    values (v_plan, (v_slot->>'week')::int, (v_slot->>'global_week')::int, (v_slot->>'day')::date, v_role_id,
            (v_slot->>'capacity')::numeric, coalesce((v_slot->>'extra')::boolean, false),
            coalesce(array(select jsonb_array_elements_text(v_slot->'notes')), '{}'))
    returning id into v_slot_id;
    v_slots := v_slots + 1;

    insert into public.ic_slot_units (plan_id, slot_id, unit_key, unit_kind, seq, origin, layer, load, sku_count, loose_count, positive_est, walk_rank)
    select v_plan, v_slot_id, i->>'unit_key', i->>'unit_kind', (n)::int, 'generated', i->>'layer',
           (i->>'load')::numeric, (i->>'sku_count')::int, (i->>'loose_count')::numeric,
           (i->>'positive_est')::numeric, (i->>'walk_rank')::int
    from jsonb_array_elements(coalesce(v_slot->'items', '[]')) with ordinality as t(i, n);
    v_units := v_units + (select jsonb_array_length(coalesce(v_slot->'items', '[]')));
  end loop;

  insert into public.ic_plan_log (plan_id, actor, action, detail)
  values (v_plan, p_actor, 'save_draft', jsonb_build_object('slots', v_slots, 'units', v_units, 'replaced_drafts', v_replaced,
          'cycle_start', p->>'cycle_start', 'generator_version', p->>'generator_version'));

  return jsonb_build_object('plan_id', v_plan, 'cycle_no', v_cycle, 'slots', v_slots, 'units', v_units, 'replaced_drafts', v_replaced);
end
$$;

-- Move one location (one slot unit) to another day and/or role, in a draft only.
-- Days before today (Monterrey) are never rewritten, neither as source nor as target.
create function public.ic_plan_move(p_plan_id bigint, p_slot_unit_id bigint, p_day date, p_role text, p_actor text)
returns jsonb
language plpgsql
set search_path to ''
as $$
declare
  v_today   date := (now() at time zone 'America/Monterrey')::date;
  v_status  text;
  v_hub     text;
  v_su      record;
  v_target  record;
  v_seq     int;
begin
  select status, hub_slug into v_status, v_hub from public.ic_plans where id = p_plan_id for update;
  if v_status is null then raise exception 'IC_PLAN_NOT_FOUND'; end if;
  if v_status <> 'draft' then raise exception 'IC_NOT_DRAFT'; end if;

  select su.id, su.unit_key, su.slot_id, s.day, r.role_key, s.extra into v_su
  from public.ic_slot_units su
  join public.ic_slots s on s.id = su.slot_id
  join public.ic_roles r on r.id = s.role_id
  where su.id = p_slot_unit_id and su.plan_id = p_plan_id;
  if not found then raise exception 'IC_UNIT_NOT_FOUND'; end if;
  if v_su.day < v_today then raise exception 'IC_PAST_DAY'; end if;
  if p_day < v_today then raise exception 'IC_PAST_DAY'; end if;

  select s.id into v_target
  from public.ic_slots s join public.ic_roles r on r.id = s.role_id
  where s.plan_id = p_plan_id and s.day = p_day and r.role_key = p_role and not s.extra;
  if not found then raise exception 'IC_NO_SLOT'; end if;
  if v_target.id = v_su.slot_id then raise exception 'IC_SAME_SLOT'; end if;

  select coalesce(max(seq), 0) + 1 into v_seq from public.ic_slot_units where slot_id = v_target.id;
  update public.ic_slot_units set slot_id = v_target.id, seq = v_seq, origin = 'coordinator', added_at = now()
  where id = p_slot_unit_id;

  insert into public.ic_plan_log (plan_id, actor, action, detail)
  values (p_plan_id, p_actor, 'move', jsonb_build_object('slot_unit_id', p_slot_unit_id, 'unit_key', v_su.unit_key,
          'from', jsonb_build_object('day', v_su.day, 'role', v_su.role_key, 'extra', v_su.extra),
          'to', jsonb_build_object('day', p_day, 'role', p_role)));

  return jsonb_build_object('ok', true, 'unit_key', v_su.unit_key, 'slot_id', v_target.id);
end
$$;

-- Activate a draft. The hub's current active plan (if any) becomes 'closed': its rows are kept as
-- they are, so past weeks are never rewritten. Only one active plan per hub (ic_plans_one_active).
create function public.ic_plan_activate(p_plan_id bigint, p_actor text)
returns jsonb
language plpgsql
set search_path to ''
as $$
declare
  v_status   text;
  v_hub      text;
  v_previous bigint;
begin
  select status, hub_slug into v_status, v_hub from public.ic_plans where id = p_plan_id for update;
  if v_status is null then raise exception 'IC_PLAN_NOT_FOUND'; end if;
  if v_status <> 'draft' then raise exception 'IC_NOT_DRAFT'; end if;
  if not exists (select 1 from public.ic_slots where plan_id = p_plan_id) then raise exception 'IC_EMPTY_PLAN'; end if;

  select id into v_previous from public.ic_plans where hub_slug = v_hub and status = 'active' for update;
  if v_previous is not null then
    update public.ic_plans set status = 'closed' where id = v_previous;
    insert into public.ic_plan_log (plan_id, actor, action, detail)
    values (v_previous, p_actor, 'close', jsonb_build_object('replaced_by', p_plan_id));
  end if;

  update public.ic_plans set status = 'active', activated_at = now() where id = p_plan_id;
  insert into public.ic_plan_log (plan_id, actor, action, detail)
  values (p_plan_id, p_actor, 'activate', jsonb_build_object('previous_plan', v_previous));

  return jsonb_build_object('ok', true, 'plan_id', p_plan_id, 'previous_plan', v_previous);
end
$$;

revoke all on function public.ic_plan_save_draft(jsonb, text) from public, anon, authenticated;
revoke all on function public.ic_plan_move(bigint, bigint, date, text, text) from public, anon, authenticated;
revoke all on function public.ic_plan_activate(bigint, text) from public, anon, authenticated;
grant execute on function public.ic_plan_save_draft(jsonb, text) to service_role;
grant execute on function public.ic_plan_move(bigint, bigint, date, text, text) to service_role;
grant execute on function public.ic_plan_activate(bigint, text) to service_role;
