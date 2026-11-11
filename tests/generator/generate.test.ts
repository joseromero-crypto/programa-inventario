// Whole-plan tests on a real Contry slice, including the v1-plan section 8 tests that apply to the
// generator: determinism, completeness, freezer split ±10%, and a 3-aux hub with Monday added.
import { describe, expect, it } from 'vitest';
import { generate, normalize, tierSource, unitComparator, type Plan, type RoleKey, type Slot } from '../../src/generator';
import { isFrozen } from '../../src/generator/normalize';
import { CONTRY_RULES, contryInput, role } from './helpers';

const items = (p: Plan, layer?: string) => p.slots.flatMap((s) => s.items.filter((i) => !layer || i.layer === layer).map((i) => ({ ...i, s })));
const keysOf = (p: Plan, layer: string) => [...new Set(items(p, layer).map((i) => i.unitKey))];
const unitsIn = (p: Plan) => new Map(p.units.map((u) => [u.key, u]));

describe('generate on Contry (physical, 4 weeks)', () => {
  const input = contryInput();
  const plan = generate(input);

  it('is deterministic: same inputs give an identical plan', () => {
    expect(generate(contryInput())).toEqual(plan);
  });

  it('does not depend on the order of the sorting rows', () => {
    const shuffled = generate(contryInput({ sorting: [...input.sorting].reverse() }));
    const shape = (p: Plan) => p.slots.map((s) => `${s.day} ${s.role} ${s.items.map((i) => `${i.unitKey}/${i.layer}`).join(',')}`);
    expect(shape(shuffled)).toEqual(shape(plan));
  });

  it('only creates slots on workdays, for roles with capacity (aux_cal gets none)', () => {
    expect(new Set(plan.slots.map((s) => s.day.slice(0, 10)))).toEqual(
      new Set(['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27', '2026-12-01', '2026-12-02', '2026-12-03', '2026-12-04']),
    );
    expect(plan.slots.some((s) => s.role === 'aux_cal')).toBe(false);
    expect(plan.slots.filter((s) => !s.extra).map((s) => s.globalWeek)).toContain(4);
  });

  it('completeness: every non-FyV SKU is on a scheduled location or an open exception', () => {
    const scheduled = new Set(items(plan).map((i) => i.unitKey));
    const onUnits = new Set(plan.units.filter((u) => scheduled.has(u.key)).flatMap((u) => u.skus.map((s) => s.barcode)));
    expect(plan.units.every((u) => scheduled.has(u.key))).toBe(true);
    const looseExc = new Set(plan.exceptions.filter((e) => e.unitKey === null).map((e) => e.barcode));
    const fyv = new Set(input.products.filter((p) => p.category === 'fyv').map((p) => p.barcode));
    const missing = input.sorting.map((r) => r.barcode.trim()).filter((b) => b && !fyv.has(b) && !onUnits.has(b) && !looseExc.has(b));
    expect(missing).toEqual([]);
  });

  it('layer 1: the tier-0 route (with the cold room) runs every week on aux_inv, on the same days', () => {
    const route = keysOf(plan, 'tier0');
    expect(route).toContain('Cuarto frío W');
    expect(route.length).toBeGreaterThan(1);
    for (const w of [1, 2, 3, 4]) {
      const wk = items(plan, 'tier0').filter((i) => i.s.week === w);
      expect(wk.map((i) => i.unitKey)).toEqual(route);
      expect(wk.every((i) => i.s.role === 'aux_inv')).toBe(true);
    }
    const dow = (w: number) => items(plan, 'tier0').filter((i) => i.s.week === w).map((i) => new Date(`${i.s.day}T12:00:00Z`).getUTCDay());
    expect(dow(2)).toEqual(dow(1));
  });

  it('layer 2: each freezer is visited every other week, halves balanced within ±10%', () => {
    const f = plan.report.freezers;
    expect(f.a.length + f.b.length).toBe(14);
    for (const [a, b] of [f.kg, f.pz]) expect(Math.abs(a - b) / 2).toBeLessThanOrEqual(0.1 * ((a + b) / 2));
    const weeksOf = (k: string) => items(plan, 'freezer').filter((i) => i.unitKey === k).map((i) => i.s.week);
    expect(weeksOf(f.a[0]!)).toEqual([1, 3]);
    expect(weeksOf(f.b[0]!)).toEqual([2, 4]);
    expect(items(plan, 'freezer').every((i) => i.s.role === 'aux_inv')).toBe(true);
  });

  it('layer 3: every remaining location exactly once per cycle, skipping weekly shelves', () => {
    const rot = items(plan, 'rotation').map((i) => i.unitKey);
    expect(new Set(rot).size).toBe(rot.length);
    const weekly = new Set([...keysOf(plan, 'tier0'), ...keysOf(plan, 'tier_weekly')]);
    expect(rot.filter((k) => weekly.has(k))).toEqual([]);
    const expected = plan.units.filter((u) => ['shelf', 'aisle_only', 'cold_room'].includes(u.kind) && !weekly.has(u.key)).map((u) => u.key);
    expect([...rot].sort()).toEqual([...expected].sort());
  });

  it('physical rule: each role walks one contiguous run, day after day, in walking order', () => {
    const cmp = unitComparator([]);
    const byKey = unitsIn(plan);
    const seq = [...new Set(items(plan, 'rotation').map((i) => i.unitKey))].map((k) => byKey.get(k)!).sort(cmp).map((u) => u.key);
    for (const r of ['lider_am', 'lider_pm', 'aux_rec'] as RoleKey[]) {
      const walk = items(plan, 'rotation').filter((i) => i.s.role === r).map((i) => i.unitKey); // slots are in day order
      if (walk.length === 0) continue;
      const start = seq.indexOf(walk[0]!);
      expect(walk).toEqual(seq.slice(start, start + walk.length)); // contiguous, no A1, G5, F6
    }
  });

  it('spreads each role about evenly over the weeks', () => {
    for (const r of plan.report.roles) {
      const perWeek = [1, 2, 3, 4].map((w) => items(plan, 'rotation').filter((i) => i.s.role === r.role && i.s.week === w).reduce((s, i) => s + i.load, 0));
      const total = perWeek.reduce((s, x) => s + x, 0);
      if (total < 40) continue;
      const biggest = Math.max(...items(plan, 'rotation').filter((i) => i.s.role === r.role).map((i) => i.load));
      for (const x of perWeek) expect(Math.abs(x - total / 4)).toBeLessThanOrEqual(biggest + 1e-6);
    }
  });

  it('layer 4 only uses spare capacity: it never pushes the hub over capacity', () => {
    const r = plan.report;
    const without = generate(contryInput({}, { cycleWeeks: 1 })); // 1-week cycle: layer 4 is off
    expect(without.report.layers.find((l) => l.layer === 'tier_weekly')!.units).toBe(0);
    if (r.weekly.leftoverBeforeTiers > 0) expect(r.cycleLoad).toBeLessThanOrEqual(r.cycleCapacity + 1e-6);
    const tw = keysOf(plan, 'tier_weekly');
    for (const k of tw) expect(items(plan, 'tier_weekly').filter((i) => i.unitKey === k).map((i) => i.s.week)).toEqual([1, 2, 3, 4]);
  });

  it('puts unidentified codes in one extra aux_inv block, outside role capacity', () => {
    const extra = plan.slots.filter((s) => s.extra);
    expect(extra).toHaveLength(1);
    expect(extra[0]!.role).toBe('aux_inv');
    expect(extra[0]!.items.map((i) => i.unitKey).sort()).toEqual(['Sin identificar: 0', 'Sin identificar: G}', 'Sin identificar: |']);
    expect(plan.report.unidentified).toEqual({ codes: 3, skus: 3 });
    expect(plan.report.messages.some((m) => m.startsWith('Ubicaciones sin identificar: 3 SKUs en 3 códigos'))).toBe(true);
  });

  it('reports load per role and the leftover-capacity message', () => {
    const r = plan.report;
    expect(r.roles.map((x) => x.role)).toEqual(['aux_inv', 'lider_am', 'lider_pm', 'aux_rec']);
    expect(r.cycleCapacity).toBe((160 + 40 + 40 + 50) * 4);
    expect(r.messages.some((m) => /^Capacidad sobrante para tiers semanales: \d+ SKUs por semana → /.test(m))).toBe(true);
    expect(r.messages.some((m) => m.startsWith('Tier 0: '))).toBe(true);
    expect(r.exceptions.UNKNOWN_CODE).toBe(3);
  });
});

describe('overload', () => {
  const tight = contryInput({ roles: [role('aux_inv', 100, [2, 3, 4, 5], 'Aux. de inventarios'), role('lider_am', 20, [2, 3, 4, 5], 'Líder turno día'), role('lider_pm', 20, [2, 3, 4, 5], 'Líder turno tarde')] });
  const plan = generate(tight);

  it('still assigns everything (the cycle is never extended) and names the smallest fix', () => {
    const rot = new Set(items(plan, 'rotation').map((i) => i.unitKey));
    const weekly = new Set(items(plan, 'tier0').map((i) => i.unitKey));
    const plannable = plan.units.filter((u) => ['shelf', 'aisle_only', 'cold_room'].includes(u.kind));
    expect(plannable.every((u) => rot.has(u.key) || weekly.has(u.key))).toBe(true);
    expect(Math.max(...plan.slots.map((s) => s.week))).toBe(4);
    const { over, fix } = plan.report.overload;
    expect(over).toBeGreaterThan(0);
    const need = Math.ceil(over / 4);
    expect(fix).toMatch(new RegExp(`subir la capacidad de .+ a \\d+ SKUs por semana`));
    expect(fix).toContain(`faltan ${over.toLocaleString('en-US')} SKUs`);
    expect(fix).toMatch(/agregar lunes/i); // Contry works Tue–Fri
    const m = /de (\d+) a (\d+) SKUs por semana/.exec(fix!)!;
    expect(Number(m[2]) - Number(m[1])).toBe(need);
    expect(plan.report.weekly.tierCoverage.every((c) => c.coveredWeekly <= c.total)).toBe(true);
    expect(keysOf(plan, 'tier_weekly')).toEqual([]);
  });
});

describe('config only (v1-plan section 8)', () => {
  it('a 3-aux hub with Monday added generates without code changes', () => {
    const days = [1, 2, 3, 4, 5];
    const roles = [role('aux_inv', 160, days), role('lider_am', 40, days), role('lider_pm', 40, days), role('aux_cal', 0, days)];
    const base = generate(contryInput({ roles: roles.map((r) => ({ ...r, days: [2, 3, 4, 5] })) }, { hubSlug: 'mh-cumbres' }));
    const plan = generate(contryInput({ roles }, { hubSlug: 'mh-cumbres', workdays: days }));
    expect(new Set(plan.slots.map((s) => s.role))).toEqual(new Set(['aux_inv', 'lider_am', 'lider_pm']));
    expect(plan.slots.filter((s) => s.day === '2026-11-09' && !s.extra).length).toBe(3); // Monday slots
    expect(base.slots.some((s) => s.day === '2026-11-09')).toBe(false);
    expect(plan.slots.find((s) => s.role === 'aux_inv' && !s.extra)!.capacity).toBe(32); // 160 / 5 days
    expect(plan.report.cycleCapacity).toBe(base.report.cycleCapacity);
  });

  it('cycle_weeks = 3 makes 3 weeks; freezer halves follow the global week', () => {
    const plan = generate(contryInput({ cycleStart: '2026-11-16' }, { cycleWeeks: 3 })); // global weeks 2..4
    expect([...new Set(plan.slots.map((s) => s.week))]).toEqual([1, 2, 3]);
    expect([...new Set(plan.slots.map((s) => s.globalWeek))]).toEqual([2, 3, 4]);
    const a = plan.report.freezers.a[0]!;
    expect(items(plan, 'freezer').filter((i) => i.unitKey === a).map((i) => i.s.globalWeek)).toEqual([3]);
    const rot = items(plan, 'rotation').map((i) => i.unitKey);
    expect(new Set(rot).size).toBe(rot.length);
  });

  it('a hub without aux_rec still gets every location', () => {
    const plan = generate(contryInput({ roles: contryRoles3() }));
    expect(plan.units.filter((u) => ['shelf', 'aisle_only', 'cold_room', 'freezer'].includes(u.kind)).every((u) => items(plan).some((i) => i.unitKey === u.key))).toBe(true);
  });

  it('walking order changes the run order', () => {
    const plan = generate(contryInput({}, { walkingOrder: ['M', 'D'] }));
    const am = items(plan, 'rotation').filter((i) => ['lider_am', 'lider_pm', 'aux_rec'].includes(i.s.role));
    expect(am[0]!.unitKey.startsWith('M')).toBe(true);
  });

  it('rejects a cycle start that is not a Monday', () => {
    expect(() => generate(contryInput({ cycleStart: '2026-11-10' }))).toThrow(/not a Monday/);
  });
});

function contryRoles3() {
  const d = [1, 2, 3, 4, 5];
  return [role('aux_inv', 160, d), role('lider_am', 40, d), role('lider_pm', 40, d)];
}

describe('tier_order mode (hub-rules 3.1)', () => {
  const plan = generate(contryInput({}, { rotationMode: 'tier_order' }));
  const byKey = unitsIn(plan);
  const score = (k: string) => {
    const ranks = byKey.get(k)!.skus.filter((s) => !s.tier.tier0 && s.tier.rank !== null).map((s) => s.tier.rank!);
    return ranks.length ? ranks.reduce((a, b) => a + b, 0) / ranks.length : Infinity;
  };
  const week = (w: number) => items(plan, 'rotation').filter((i) => i.s.week === w);

  it('goes from best sellers (week 1) to slowest (last week), shelves whole', () => {
    const worst = (w: number) => Math.max(...week(w).map((i) => score(i.unitKey)).filter(Number.isFinite));
    const best = (w: number) => Math.min(...week(w).map((i) => score(i.unitKey)));
    for (const w of [1, 2, 3]) expect(worst(w)).toBeLessThanOrEqual(best(w + 1));
  });

  it('cuts weeks of about equal load', () => {
    const loads = [1, 2, 3, 4].map((w) => week(w).reduce((s, i) => s + i.load, 0));
    const avg = loads.reduce((a, b) => a + b, 0) / 4;
    const biggest = Math.max(...items(plan, 'rotation').map((i) => i.load));
    for (const l of loads) expect(Math.abs(l - avg)).toBeLessThanOrEqual(biggest);
  });

  it('keeps physical order inside each day and reports aisle jumps', () => {
    const cmp = unitComparator([]);
    for (const s of plan.slots as Slot[]) {
      const run = s.items.filter((i) => i.layer === 'rotation').map((i) => byKey.get(i.unitKey)!);
      expect([...run].sort(cmp)).toEqual(run);
    }
    expect(plan.report.aisleJumps.length).toBeGreaterThan(0);
  });

  it('shares layers 1, 2 and 4 with physical mode', () => {
    const phys = generate(contryInput());
    for (const l of ['tier0', 'freezer', 'tier_weekly']) expect(keysOf(plan, l)).toEqual(keysOf(phys, l));
  });
});

describe('inputs read through tierSource', () => {
  it('uses only the hub city tiers', () => {
    const input = contryInput();
    const t = tierSource(input.hub, input.tierRows);
    const saltilloOnly = input.tierRows.find((r) => r.city === 'Saltillo')!;
    expect(t(saltilloOnly.sku).tier0).toBe(input.tierRows.some((r) => r.city === 'Monterrey' && r.sku === saltilloOnly.sku && /(^|;)\s*0\s*(;|$)/.test(r.tiers ?? '')));
  });
  it('frozen SKUs with no freezer become FROZEN_NO_FREEZER, never shelf load', () => {
    const input = contryInput();
    const n = normalize({ rules: CONTRY_RULES, sorting: input.sorting, products: input.products, tiers: () => ({ tier0: false, sales: null, rank: null }), stock: {}, sizingBasis: 'catalog', walkingOrder: [] });
    const frozenShelf = n.units.filter((u) => u.kind === 'shelf').flatMap((u) => u.skus).filter((s) => input.sorting.some((r) => r.barcode === s.barcode && isFrozen(r.temp) && !/^B/i.test(r.pasillo)));
    expect(frozenShelf).toEqual([]);
    expect(n.exceptions.some((e) => e.code === 'FROZEN_NO_FREEZER')).toBe(true);
  });
});
