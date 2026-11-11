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
