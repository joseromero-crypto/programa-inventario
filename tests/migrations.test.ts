// Runs every migration on PGlite (in-memory Postgres) and checks 0006 (plan storage) and 0007.
// Shared tables (mv_*) and Supabase roles are stubbed: only their shape matters here.
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';

const files = import.meta.glob('../supabase/migrations/*.sql', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

const STUBS = `
  create role anon; create role authenticated; create role service_role;
  create table public.mv_products (sku text primary key, name text, barcode text, calii_unit text, main_category text, temp text, raw jsonb);
  create table public.mv_product_city (sku text, city text, barcode text, raw jsonb);
  create table public.mv_imports (id serial primary key, uploaded_at timestamptz);
`;

let db: PGlite;
const one = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0]!;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(STUBS);
  for (const name of Object.keys(files).sort()) await db.exec(files[name]!);
  await db.exec(`
    insert into public.mv_products (sku, name, barcode, calii_unit, main_category, temp, raw) values
      ('AAA111', 'Aceite de oliva 500ml', '750001', 'pz', 'Despensa', 'Ambiente', '{"Assembly Category (options are: frutas y verduras, carnes, abarrotes)": "Abarrotes"}'),
      ('BBB222', 'Manzana roja', null, 'kg', 'Frutas', '8', '{"Assembly Category (options are: frutas y verduras, carnes, abarrotes)": "Frutas y verduras"}'),
      ('CCC333', 'Viejo producto', '750003', 'pz', 'Viejo', 'Ambiente', '{"retired_at": "2026-01-01"}');
    insert into public.mv_product_city (sku, city, tiers) values ('AAA111', 'Monterrey', '1; 0'), ('AAA111', 'Saltillo', '4'), ('BBB222', 'CDMX', '2');
  `);
}, 60_000);

async function newPlan(cycleWeeks = 6) {
  const { id } = await one<{ id: number }>(
    `insert into public.ic_plans (hub_slug, cycle_no, cycle_start, generator_version, cycle_weeks, rotation_mode)
     values ('mh-cumbres', 1, '2026-11-09', 'v1.0.0', $1, 'tier_order') returning id`, [cycleWeeks]);
  const { role_id } = await one<{ role_id: number }>(`select id as role_id from public.ic_roles where hub_slug = 'mh-cumbres' and role_key = 'aux_inv'`);
  return { id, role_id };
}

describe('migrations 0001–0007 on PGlite', () => {
  it('apply cleanly in order', () => {
    expect(Object.keys(files).map((f) => f.split('/').pop())).toEqual(expect.arrayContaining(['0006_ic_plan_storage.sql', '0007_ic_mv_products_name.sql']));
  });

  it('store a plan longer than 4 weeks, with fractional day capacity and the extra block', async () => {
    const { id, role_id } = await newPlan(6);
    const slot = await one<{ id: number; capacity: string }>(
      `insert into public.ic_slots (plan_id, week, global_week, day, role_id, capacity) values ($1, 6, 6, '2026-12-14', $2, 116.67) returning id, capacity`, [id, role_id]);
    expect(Number(slot.capacity)).toBe(116.67);
    await db.query(`insert into public.ic_slots (plan_id, week, global_week, day, role_id, capacity, extra, notes) values ($1, 6, 6, '2026-12-14', $2, 4, true, '{"Bloque extra"}')`, [id, role_id]);
    await db.query(
      `insert into public.ic_slot_units (plan_id, slot_id, unit_key, unit_kind, seq, layer, load, sku_count, loose_count) values
         ($1, $2, 'G-10', 'shelf', 1, 'rotation', 89.4, 99, 3.2),
         ($1, $2, 'N (sin estante)', 'aisle_only', 2, 'rotation', 10, 10, 0),
         ($1, $2, 'Sin identificar: G}', 'unidentified', 3, 'unidentified', 1, 1, 0),
         ($1, $2, 'Cuarto frío Q', 'cold_room', 4, 'tier0', 268, 309, 0)`, [id, slot.id]);
    expect(Number((await one<{ n: string }>(`select count(*) n from public.ic_slot_units where plan_id = $1`, [id])).n)).toBe(4);
  });

  it('reject what the generator never produces', async () => {
    const { id, role_id } = await newPlan(4);
    await expect(db.query(`insert into public.ic_slots (plan_id, week, global_week, day, role_id, capacity) values ($1, 9, 9, '2027-01-04', $2, 10)`, [id, role_id])).rejects.toThrow();
    await expect(db.query(`insert into public.ic_plans (hub_slug, cycle_no, cycle_start, generator_version, cycle_weeks) values ('mh-cumbres', 2, '2026-11-09', 'v', 9)`)).rejects.toThrow();
    const s = await one<{ id: number }>(`insert into public.ic_slots (plan_id, week, global_week, day, role_id, capacity) values ($1, 1, 1, '2026-11-10', $2, 10) returning id`, [id, role_id]);
    await expect(db.query(`insert into public.ic_slot_units (plan_id, slot_id, unit_key, unit_kind, seq, layer) values ($1, $2, 'X', 'shelf', 1, 'monthly')`, [id, s.id])).rejects.toThrow();
    await expect(db.query(`insert into public.ic_slot_units (plan_id, slot_id, unit_key, unit_kind, seq, layer) values ($1, $2, 'X', 'shelf_aisle', 1, 'rotation')`, [id, s.id])).rejects.toThrow();
    await expect(db.query(`insert into public.ic_slots (plan_id, week, global_week, day, role_id, capacity) values ($1, 1, 1, '2026-11-10', $2, 10)`, [id, role_id])).rejects.toThrow(); // same normal slot twice
  });

  it('allow weeks 5–8 in the weekly close tables', async () => {
    const { id } = await newPlan(8);
    await db.query(`insert into public.ic_week_closes (plan_id, week, sorting_version) values ($1, 8, 'v1')`, [id]);
    await db.query(`insert into public.ic_unit_week_state (plan_id, week, unit_key) values ($1, 7, 'G-10')`, [id]);
  });

  it('ic_mv_products adds the assembly category and the name, and skips retired products', async () => {
    const { r } = await one<{ r: unknown[][] }>(`select public.ic_mv_products() r`);
    expect(r).toEqual([
      ['AAA111', '750001', 'Despensa', 'pz', 'Ambiente', 'Abarrotes', 'Aceite de oliva 500ml'],
      ['BBB222', null, 'Frutas', 'kg', '8', 'Frutas y verduras', 'Manzana roja'],
    ]);
  });

  it('ic_mv_tiers returns one city, matched on lower(city)', async () => {
    expect((await one<{ r: unknown }>(`select public.ic_mv_tiers('monterrey') r`)).r).toEqual([['AAA111', '1; 0']]);
    expect((await one<{ r: unknown }>(`select public.ic_mv_tiers('cdmx') r`)).r).toEqual([['BBB222', '2']]);
  });

  it('lets anon call the read RPCs', async () => {
    const { ok } = await one<{ ok: boolean }>(`select has_function_privilege('anon', 'public.ic_mv_tiers(text)', 'execute') and has_function_privilege('anon', 'public.ic_mv_products()', 'execute') ok`);
    expect(ok).toBe(true);
  });
});

// ───────────── 0008: plan actions ─────────────
const today = async () => (await one<{ d: string }>(`select ((now() at time zone 'America/Monterrey')::date)::text d`)).d;
const plusDays = async (n: number) => (await one<{ d: string }>(`select (((now() at time zone 'America/Monterrey')::date) + $1::int)::text d`, [n])).d;

async function draftPayload(day: string, day2: string) {
  const item = (unit_key: string, layer: string, walk_rank: number) => ({ unit_key, unit_kind: 'shelf', layer, load: 10.5, sku_count: 12, loose_count: 1.5, positive_est: 10.5, walk_rank });
  return {
    hub_slug: 'mh-contry', cycle_start: '2026-11-09', cycle_weeks: 4, rotation_mode: 'physical', generator_version: 'v1.0.0',
    params: { sorting_version: 'x' }, report: { messages: ['hola'] },
    slots: [
      { week: 1, global_week: 1, day, role: 'aux_inv', capacity: 175, extra: false, notes: ['Ubicar en congelador: 3 SKUs'], items: [item('A-1', 'tier0', 3), item('A-2', 'rotation', 4)] },
      { week: 1, global_week: 1, day, role: 'aux_inv', capacity: 0, extra: true, notes: [], items: [{ ...item('Sin identificar: G}', 'unidentified', 99), unit_kind: 'unidentified' }] },
      { week: 1, global_week: 1, day: day2, role: 'lider_am', capacity: 60, extra: false, notes: [], items: [] },
    ],
  };
}

describe('migration 0008 on PGlite', () => {
  it('ic_sku_stock returns [sku, last_qty] for one hub only, and anon may call it', async () => {
    await db.exec(`
      insert into public.ic_conf_events (hub_slug, sku, login, role_key, local_date, event_ts, qty_app, qty_auto, src_key) values
        ('mh-contry', 'AAA111', 'aux.inventario.con', 'aux_inv', current_date, now() - interval '2 days', 4, 4, 'k1'),
        ('mh-contry', 'AAA111', 'aux.inventario.con', 'aux_inv', current_date, now() - interval '1 days', 0, 0, 'k2'),
        ('mh-contry', 'DDD444', 'aux.inventario.con', 'aux_inv', current_date, now() - interval '1 days', null, null, 'k3'),
        ('mh-contry', 'EEE555', 'aux.inventario.con', 'aux_inv', current_date, now() - interval '90 days', 7, 7, 'k4'),
        ('mh-cumbres', 'BBB222', 'aux.inventario.cu', 'aux_inv', current_date, now(), 9, 9, 'k5');`);
    expect((await one<{ r: unknown }>(`select public.ic_sku_stock('mh-contry') r`)).r).toEqual([['AAA111', 0]]);
    const { ok } = await one<{ ok: boolean }>(`select has_function_privilege('anon', 'public.ic_sku_stock(text)', 'execute') and has_function_privilege('anon', 'public.ic_now()', 'execute') ok`);
    expect(ok).toBe(true);
    const { r } = await one<{ r: { today_local: string } }>(`select public.ic_now() r`);
    expect(r.today_local).toBe(await today());
  });

  it('keeps plan actions away from anon', async () => {
    const { ok } = await one<{ ok: boolean }>(`select not has_function_privilege('anon', 'public.ic_plan_save_draft(jsonb, text)', 'execute')
      and not has_function_privilege('anon', 'public.ic_plan_move(bigint, bigint, date, text, text)', 'execute')
      and not has_function_privilege('anon', 'public.ic_plan_activate(bigint, text)', 'execute')
      and has_function_privilege('service_role', 'public.ic_plan_activate(bigint, text)', 'execute') ok`);
    expect(ok).toBe(true);
  });

  it('saves a draft with layer, load, counts, the extra block and the report, and replaces older drafts', async () => {
    const p = await draftPayload(await plusDays(1), await plusDays(2));
    const first = (await one<{ r: { plan_id: number } }>(`select public.ic_plan_save_draft($1::jsonb, 'test') r`, [JSON.stringify(p)])).r;
    const r = (await one<{ r: { plan_id: number; slots: number; units: number; replaced_drafts: number } }>(`select public.ic_plan_save_draft($1::jsonb, 'test') r`, [JSON.stringify(p)])).r;
    expect(r).toMatchObject({ slots: 3, units: 3, replaced_drafts: 1 });
    expect(Number((await one<{ n: string }>(`select count(*) n from public.ic_plans where id = $1`, [first.plan_id])).n)).toBe(0);
    const plan = await one<{ status: string; report: unknown; cycle_no: number }>(`select status, report, cycle_no from public.ic_plans where id = $1`, [r.plan_id]);
    expect(plan).toMatchObject({ status: 'draft', report: { messages: ['hola'] }, cycle_no: 1 });
    const units = (await db.query<{ unit_key: string; layer: string; seq: number; positive_est: string; walk_rank: number; extra: boolean; notes: string[] }>(
      `select su.unit_key, su.layer, su.seq, su.positive_est, su.walk_rank, s.extra, s.notes from public.ic_slot_units su join public.ic_slots s on s.id = su.slot_id where su.plan_id = $1 order by su.walk_rank`, [r.plan_id])).rows;
    expect(units.map((u) => [u.unit_key, u.layer, u.seq, Number(u.positive_est), u.extra])).toEqual([
      ['A-1', 'tier0', 1, 10.5, false], ['A-2', 'rotation', 2, 10.5, false], ['Sin identificar: G}', 'unidentified', 1, 10.5, true]]);
    expect(units[0]!.notes).toEqual(['Ubicar en congelador: 3 SKUs']);
    expect((await one<{ action: string }>(`select action from public.ic_plan_log where plan_id = $1`, [r.plan_id])).action).toBe('save_draft');
  });

  it('moves a location in a draft only, never into or out of a past day', async () => {
    const d1 = await plusDays(1);
    const d2 = await plusDays(2);
    const { plan_id } = (await one<{ r: { plan_id: number } }>(`select public.ic_plan_save_draft($1::jsonb, 'test') r`, [JSON.stringify(await draftPayload(d1, d2))])).r;
    const su = await one<{ id: number }>(`select id from public.ic_slot_units where plan_id = $1 and unit_key = 'A-2'`, [plan_id]);
    const move = (day: string, role: string, id = su.id, plan = plan_id) => db.query(`select public.ic_plan_move($1, $2, $3::date, $4, 'test')`, [plan, id, day, role]);

    await expect(move(d1, 'aux_inv')).rejects.toThrow(/IC_SAME_SLOT/);
    await expect(move(d1, 'lider_pm')).rejects.toThrow(/IC_NO_SLOT/);
    await expect(move(await plusDays(-1), 'lider_am')).rejects.toThrow(/IC_PAST_DAY/);
    await move(d2, 'lider_am');
    const moved = await one<{ day: string; role_key: string; origin: string; seq: number }>(
      `select s.day::text, r.role_key, su.origin, su.seq from public.ic_slot_units su join public.ic_slots s on s.id = su.slot_id join public.ic_roles r on r.id = s.role_id where su.id = $1`, [su.id]);
    expect(moved).toEqual({ day: d2, role_key: 'lider_am', origin: 'coordinator', seq: 1 });
    const log = await one<{ detail: { unit_key: string; to: { role: string } } }>(`select detail from public.ic_plan_log where plan_id = $1 and action = 'move'`, [plan_id]);
    expect(log.detail).toMatchObject({ unit_key: 'A-2', to: { role: 'lider_am' } });

    // a slot unit sitting on a past day can't be moved out
    const past = await one<{ id: number }>(`update public.ic_slots set day = $2::date where plan_id = $1 and role_id = (select id from public.ic_roles where hub_slug = 'mh-contry' and role_key = 'aux_inv') and not extra returning id`, [plan_id, await plusDays(-2)]);
    const a1 = await one<{ id: number }>(`select id from public.ic_slot_units where slot_id = $1`, [past.id]);
    await expect(move(d2, 'lider_am', a1.id)).rejects.toThrow(/IC_PAST_DAY/);
  });

  it('activates one draft per hub, closes the previous plan without touching its rows, and refuses non-drafts', async () => {
    const d1 = await plusDays(1);
    const d2 = await plusDays(2);
    const save = async () => (await one<{ r: { plan_id: number } }>(`select public.ic_plan_save_draft($1::jsonb, 'test') r`, [JSON.stringify(await draftPayload(d1, d2))])).r.plan_id;
    const a = await save();
    await db.query(`select public.ic_plan_activate($1, 'test')`, [a]);
    const unitsBefore = (await db.query(`select * from public.ic_slot_units where plan_id = $1 order by id`, [a])).rows;
    await expect(db.query(`select public.ic_plan_activate($1, 'test')`, [a])).rejects.toThrow(/IC_NOT_DRAFT/);
    const su = await one<{ id: number }>(`select id from public.ic_slot_units where plan_id = $1 and unit_key = 'A-2'`, [a]);
    await expect(db.query(`select public.ic_plan_move($1, $2, $3::date, 'lider_am', 'test')`, [a, su.id, d2])).rejects.toThrow(/IC_NOT_DRAFT/);

    const b = await save(); // a new draft does not replace the active plan
    expect((await one<{ status: string }>(`select status from public.ic_plans where id = $1`, [a])).status).toBe('active');
    expect((await one<{ cycle_no: number }>(`select cycle_no from public.ic_plans where id = $1`, [b])).cycle_no).toBe(2);
    const r = (await one<{ r: { previous_plan: number } }>(`select public.ic_plan_activate($1, 'test') r`, [b])).r;
    expect(r.previous_plan).toBe(a);
    const statuses = (await db.query<{ id: number; status: string }>(`select id, status from public.ic_plans where id in ($1, $2) order by id`, [a, b])).rows;
    expect(statuses.map((s) => s.status)).toEqual(['closed', 'active']);
    expect((await db.query(`select * from public.ic_slot_units where plan_id = $1 order by id`, [a])).rows).toEqual(unitsBefore);
    expect(Number((await one<{ n: string }>(`select count(*) n from public.ic_plans where hub_slug = 'mh-contry' and status = 'active'`)).n)).toBe(1);
  });
});
