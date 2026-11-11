// Phase 2: generator inputs from the app's rows, the draft payload, and ic-admin request validation.
import { describe, expect, it } from 'vitest';
import { generate } from '../src/generator';
import { ANCHOR_MONDAY, buildGeneratorInput, type RawInputs } from '../src/lib/plan/inputs';
import { slotTotals, toDraftPayload, unitTags, viewFromPayload } from '../src/lib/plan/model';
import { mondayOf } from '../src/lib/time';
import { parseAdminRequest, rpcCall, sqlError } from '../supabase/functions/_shared/plan_admin';
import { CONTRY_RULES, contryInput } from './generator/helpers';

const plan = generate(contryInput());
const payload = toDraftPayload(plan, [], { sorting_version: 'v' });

describe('mondayOf', () => {
  it('gives the Monday of the week', () => {
    expect(['2026-11-09', '2026-11-11', '2026-11-15'].map(mondayOf)).toEqual(['2026-11-09', '2026-11-09', '2026-11-09']);
    expect(mondayOf('2026-11-16')).toBe('2026-11-16');
  });
});

describe('buildGeneratorInput', () => {
  const raw: RawInputs = {
    hub: { hub_slug: 'mh-contry', display_name: 'MH Contry', city: 'monterrey', workdays: [2, 3, 4, 5], cycle_weeks: 4, rotation_mode: 'physical', walking_order: [], sizing_basis: 'positive' },
    roles: [{ id: 1, role_key: 'aux_inv', label: 'Aux. de inventarios', weekly_capacity: 700, days: [2, 3, 4, 5], active: true }],
    rules: CONTRY_RULES,
    sorting: { items: [['Aceite', '0750001', 'G', '10', '2', '', '18']] },
    products: [
      { sku: 'AAA111', name: 'Aceite', barcode: '750001', main_category: null, calii_unit: 'pz', temp: null, category: 'abarrotes' },
      { sku: 'BBB222', name: 'Pollo', barcode: null, main_category: null, calii_unit: 'KG?', temp: null, category: 'carnes' },
    ],
    tiers: [{ sku: 'AAA111', city: 'monterrey', tiers: '1; 0' }],
    stock: [['AAA111', 3], ['BBB222', '0'], ['', 4]],
    today: '2026-11-11',
  };
  const input = buildGeneratorInput(raw);

  it('starts the cycle on the current Monday, with the global anchor', () => {
    expect(input.cycleStart).toBe('2026-11-09');
    expect(input.anchorMonday).toBe(ANCHOR_MONDAY);
  });
  it('maps config, roles, sorting, products and stock', () => {
    expect(input.hub).toMatchObject({ hubSlug: 'mh-contry', city: 'monterrey', cycleWeeks: 4, walkingOrder: [] });
    expect(input.roles).toEqual([{ key: 'aux_inv', label: 'Aux. de inventarios', weeklyCapacity: 700, days: [2, 3, 4, 5], active: true }]);
    expect(input.sorting).toEqual([{ name: 'Aceite', barcode: '0750001', pasillo: 'G', estante: '10', nivel: '2', temp: '18' }]);
    expect(input.products.map((p) => p.unit)).toEqual(['pz', null]);
    expect(input.stock).toEqual({ AAA111: 3, BBB222: 0 });
  });
  it('feeds the generator', () => {
    const p = generate(input);
    expect(p.units.map((u) => u.key)).toEqual(['G-10']);
  });
});

describe('toDraftPayload', () => {
  it('carries every slot and location with layer, load, counts, stock estimate and walking order', () => {
    expect(payload.slots).toHaveLength(plan.slots.length);
    const items = payload.slots.flatMap((s) => s.items);
    expect(items).toHaveLength(plan.slots.reduce((n, s) => n + s.items.length, 0));
    const u = plan.units.find((x) => x.key === items[0]!.unit_key)!;
    expect(items[0]).toMatchObject({ unit_kind: u.kind, sku_count: u.count, positive_est: Math.round(u.positiveEst * 100) / 100 });
    expect(new Set(items.map((i) => i.walk_rank)).size).toBe(new Set(items.map((i) => i.unit_key)).size);
  });
  it('keeps the extra block and stores the exception list in the report', () => {
    expect(payload.slots.some((s) => s.extra && s.items.every((i) => i.layer === 'unidentified'))).toBe(plan.slots.some((s) => s.extra));
    expect((payload.report.exceptionList as unknown[]).length).toBe(plan.exceptions.length);
    expect(payload.report.messages).toEqual(plan.report.messages);
  });
  it('is accepted by ic-admin validation as is', () => {
    const r = parseAdminRequest(JSON.parse(JSON.stringify({ action: 'save_draft', plan: payload })));
    expect(r.ok).toBe(true);
  });
  it('orders each slot by walking order in the view, and totals SKUs and stock', () => {
    const v = viewFromPayload(payload);
    for (const s of v.slots) expect(s.units.map((u) => u.walkRank)).toEqual([...s.units.map((u) => u.walkRank)].sort((a, b) => a - b));
    const s = v.slots.find((x) => x.units.length > 1)!;
    const t = slotTotals(s.units);
    expect(t.locations).toBe(s.units.length);
    expect(t.skus).toBe(Math.round(s.units.reduce((n, u) => n + u.skuCount + u.looseCount, 0)));
  });
});

describe('unitTags', () => {
  it('names the layer, the freezer group by global week, and the sin-estante share', () => {
    const base = { unitKind: 'shelf' as const, looseCount: 0, moved: false };
    expect(unitTags({ ...base, layer: 'tier0' }, 1)).toEqual(['tier 0']);
    expect(unitTags({ ...base, unitKind: 'freezer', layer: 'freezer' }, 1)).toEqual(['congeladores grupo A']);
    expect(unitTags({ ...base, unitKind: 'freezer', layer: 'freezer' }, 2)).toEqual(['congeladores grupo B']);
    expect(unitTags({ ...base, layer: 'tier_weekly' }, 3)).toEqual(['tiers semanales']);
    expect(unitTags({ ...base, unitKind: 'unidentified', layer: 'unidentified' }, 1)).toEqual(['bloque extra: ubicaciones sin identificar']);
    expect(unitTags({ ...base, layer: 'rotation', looseCount: 2.6, moved: true }, 1)).toEqual(['rotación mensual', 'incluye ~3 sin estante', 'movida por coordinador']);
  });
});

describe('parseAdminRequest', () => {
  const draft = () => JSON.parse(JSON.stringify(payload));
  const bad = (plan: unknown) => parseAdminRequest({ action: 'save_draft', plan });

  it('accepts ping, move and activate', () => {
    expect(parseAdminRequest({ action: 'ping' })).toEqual({ ok: true, value: { action: 'ping' } });
    expect(parseAdminRequest({ action: 'move', plan_id: 3, slot_unit_id: 9, day: '2026-11-12', role: 'lider_am' }).ok).toBe(true);
    expect(parseAdminRequest({ action: 'activate', plan_id: 3 }).ok).toBe(true);
  });
  it('rejects unknown actions and bad move/activate fields', () => {
    expect(parseAdminRequest({ action: 'drop_table' })).toEqual({ ok: false, error: 'acción desconocida' });
    expect(parseAdminRequest('x').ok).toBe(false);
    expect(parseAdminRequest({ action: 'move', plan_id: 3, slot_unit_id: 9, day: '12/11/2026', role: 'lider_am' }).ok).toBe(false);
    expect(parseAdminRequest({ action: 'move', plan_id: 3, slot_unit_id: 9, day: '2026-11-12', role: 'jefe' }).ok).toBe(false);
    expect(parseAdminRequest({ action: 'activate', plan_id: '3' }).ok).toBe(false);
    expect(parseAdminRequest({ action: 'activate', plan_id: 0 }).ok).toBe(false);
  });
  it('rejects drafts the generator never produces', () => {
    const notMonday = draft(); notMonday.cycle_start = '2026-11-10';
    expect(bad(notMonday)).toEqual({ ok: false, error: 'cycle_start: debe ser lunes' });
    const outside = draft(); outside.slots[0].day = '2027-03-01';
    expect(bad(outside)).toMatchObject({ ok: false, error: 'slots[0].day: fuera del ciclo' });
    const dup = draft(); dup.slots.push({ ...dup.slots[0] });
    expect(bad(dup)).toMatchObject({ ok: false, error: expect.stringContaining('repetidos') });
    const layer = draft(); layer.slots[0].items[0].layer = 'monthly';
    expect(bad(layer).ok).toBe(false);
    const neg = draft(); neg.slots[0].items[0].load = -1;
    expect(bad(neg).ok).toBe(false);
    const week = draft(); week.slots[0].week = 5;
    expect(bad(week).ok).toBe(false);
    expect(bad({ ...draft(), slots: [] }).ok).toBe(false);
  });
  it('rounds numbers to the column precision', () => {
    const d = draft(); d.slots[0].capacity = 58.3333333;
    const r = bad(d);
    expect(r.ok && r.value.action === 'save_draft' && r.value.plan.slots[0]!.capacity).toBe(58.33);
  });
});

describe('rpcCall and sqlError', () => {
  it('maps actions to the SQL functions with the actor', () => {
    expect(rpcCall({ action: 'ping' }, 'a')).toBeNull();
    expect(rpcCall({ action: 'activate', plan_id: 4 }, 'a')).toEqual({ fn: 'ic_plan_activate', args: { p_plan_id: 4, p_actor: 'a' } });
    expect(rpcCall({ action: 'move', plan_id: 4, slot_unit_id: 7, day: '2026-11-12', role: 'aux_rec' }, 'a')!.fn).toBe('ic_plan_move');
  });
  it('turns SQL errors into Spanish messages', () => {
    expect(sqlError('IC_PAST_DAY')).toEqual({ status: 409, error: 'Los días que ya pasaron no se cambian.' });
    expect(sqlError('ERROR: IC_NO_SLOT')).toMatchObject({ status: 409 });
    expect(sqlError('duplicate key value violates unique constraint "ic_plans_one_active"').status).toBe(409);
    expect(sqlError('something else').status).toBe(500);
  });
});
