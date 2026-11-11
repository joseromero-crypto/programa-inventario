// The plan generator: one pure, deterministic function. Same input → same plan.
// Layers are filled in order (hub-rules 2): tier 0 → freezers → monthly rotation, and layer 4
// (high-rotation tiers) only takes capacity the first three leave free.
import { buildSlots, packSequential, planRoles, roleWeekSlots, slack } from './calendar';
import { freezerHalfFor, splitFreezers } from './layers/freezers';
import { selectHighRotation } from './layers/highRotation';
import { rotatePhysical, rotateTierOrder, type Section } from './layers/rotation';
import { buildTier0Route } from './layers/tier0';
import { buildUnidentifiedSlot } from './layers/unidentified';
import { normalize } from './normalize';
import { unitComparator } from './order';
import { buildReport } from './report';
import { tierSource } from './tiers';
import type { GeneratorInput, Plan, RoleKey, Slot, Unit } from './types';

export const GENERATOR_VERSION = 'v1.0.0';

/** Order layer-4 shelves go to: aux_inv first, then the leads, then everyone else. */
const WEEKLY_ROLE_ORDER: RoleKey[] = ['aux_inv', 'lider_am', 'lider_pm'];

export function generate(input: GeneratorInput): Plan {
  const { hub } = input;
  const W = hub.cycleWeeks;
  if (!Number.isInteger(W) || W < 1) throw new Error(`cycle_weeks must be a positive integer, got ${W}`);
  const basis = hub.sizingBasis;
  const cmp = unitComparator(hub.walkingOrder);

  // Locations
  const tiers = tierSource(hub, input.tierRows);
  const norm = normalize({ rules: input.rules, sorting: input.sorting, products: input.products, tiers, stock: input.stock, sizingBasis: basis, walkingOrder: hub.walkingOrder });
  const units = norm.units;

  // Slots
  const roles = planRoles(input.roles, hub);
  const roleKeys = roles.map((r) => r.key);
  const owner: RoleKey | null = roleKeys.includes('aux_inv') ? 'aux_inv' : (roleKeys[0] ?? null);
  const slots = buildSlots(hub, input.roles, input.cycleStart, input.anchorMonday);
  const ownerWeekly = roles.find((r) => r.key === owner)?.weeklyCapacity ?? 0;

  // Layer 2 first only because the tier-0 budget depends on the larger freezer half.
  const freezers = splitFreezers(units.filter((u) => u.kind === 'freezer'));
  const halfLoad = (us: Unit[]) => us.reduce((s, u) => s + u.load, 0);
  const budget = hub.tier0Budget ?? Math.max(0, ownerWeekly - Math.max(halfLoad(freezers.a), halfLoad(freezers.b)));

  // Layer 1: tier-0 route, then layer 2: this week's freezer half, both on aux_inv, every week.
  const route = buildTier0Route(units, budget, basis);
  const frozenLoose = norm.exceptions.filter((e) => e.code === 'FROZEN_NO_FREEZER').length;
  if (owner) {
    for (let w = 1; w <= W; w++) {
      const days = roleWeekSlots(slots, owner, w);
      if (days.length === 0) continue;
      packSequential(route.units, days, 'tier0');
      const half = freezers[freezerHalfFor(days[0]!.globalWeek)];
      packSequential(half, days, 'freezer');
      if (w === 1 && frozenLoose > 0) {
        const s = days.find((d) => d.items.some((i) => i.layer === 'freezer')) ?? days[0]!;
        s.notes.push(`Ubicar en congelador: ${frozenLoose} SKUs congelados sin congelador asignado`);
      }
    }
  }

  // Layer 3 candidates: every shelf, aisle and cold room not already visited weekly.
  const onRoute = new Set(route.units.map((u) => u.key));
  const candidates = units.filter((u) => (u.kind === 'shelf' || u.kind === 'aisle_only' || u.kind === 'cold_room') && !onRoute.has(u.key));
  const planSlots = slots.filter((s) => !s.extra);
  const spare = slack(planSlots) - candidates.reduce((s, u) => s + u.load, 0);

  // Layer 4: high-rotation shelves, only with spare capacity. Placed before the rotation is laid
  // out so the rotation then sizes itself to what's left.
  const high = selectHighRotation(candidates, route.units, Math.max(0, spare), W, basis);
  placeWeekly(high.units, slots, roleKeys, W);

  // Layer 3: the monthly rotation.
  const inHigh = new Set(high.units.map((u) => u.key));
  const seq = candidates.filter((u) => !inHigh.has(u.key));
  let sections: Section[] = [];
  if (hub.rotationMode === 'tier_order') rotateTierOrder(seq, planSlots, roleKeys, W, cmp);
  else sections = rotatePhysical(seq, planSlots, roleKeys, cmp);

  // "Ubicaciones sin identificar": one extra block for aux_inv.
  const unidentified = units.filter((u) => u.kind === 'unidentified');
  const extra = owner ? buildUnidentifiedSlot(unidentified, slots, owner, hub.unidentifiedWeek ?? 1) : null;
  if (extra) slots.push(extra);
  slots.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0) || roleKeys.indexOf(a.role) - roleKeys.indexOf(b.role) || Number(a.extra) - Number(b.extra));

  const report = buildReport({ hub, roles, slots, units, exceptions: norm.exceptions, matching: norm.matching, route, freezers, high, spare, candidates, sections, ownerWeekly });

  return {
    generatorVersion: GENERATOR_VERSION,
    hubSlug: hub.hubSlug,
    cycleStart: input.cycleStart,
    cycleWeeks: W,
    rotationMode: hub.rotationMode,
    units,
    slots,
    exceptions: norm.exceptions,
    report,
  };
}

/**
 * Layer 4 placement: the same shelves every week. Shelves (physical order) go to aux_inv until
 * its smallest weekly free capacity is used, then to the leads, then to the other roles.
 */
function placeWeekly(units: Unit[], slots: Slot[], roleKeys: RoleKey[], W: number): void {
  if (units.length === 0) return;
  const order = [...WEEKLY_ROLE_ORDER.filter((r) => roleKeys.includes(r)), ...roleKeys.filter((r) => !WEEKLY_ROLE_ORDER.includes(r))];
  const budget = order.map((r) => {
    let min = Number.POSITIVE_INFINITY;
    for (let w = 1; w <= W; w++) min = Math.min(min, slack(roleWeekSlots(slots, r, w)));
    return Number.isFinite(min) ? Math.max(0, min) : 0;
  });
  const byRole: Unit[][] = order.map(() => []);
  let r = 0;
  let usedR = 0;
  for (const u of units) {
    while (r < order.length - 1 && usedR + u.load > budget[r]! + 1e-9) {
      r++;
      usedR = 0;
    }
    byRole[r]!.push(u);
    usedR += u.load;
  }
  order.forEach((role, i) => {
    if (byRole[i]!.length === 0) return;
    for (let w = 1; w <= W; w++) packSequential(byRole[i]!, roleWeekSlots(slots, role, w), 'tier_weekly');
  });
}
