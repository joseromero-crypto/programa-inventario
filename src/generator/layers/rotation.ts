// Layer 3: the monthly rotation (hub-rules 3, spec 4.5). Full coverage once per cycle.
//  physical:   the remaining locations in walking order are cut into one contiguous section per role,
//              sized to what each role has left; each role walks its section day after day.
//  tier_order: locations ranked by the average tier of their SKUs, cut into cycle_weeks groups of
//              equal load (best sellers first); inside each week, back to physical order.
// Carnes locations always go to aux_inv. Units are never split.
import { addItem, free, slack } from '../calendar';
import { cutInto } from '../cut';
import { countedTier } from '../tiers';
import type { RoleKey, Slot, Unit } from '../types';

export interface Section {
  role: RoleKey;
  units: Unit[]; // all rotation units of the role, physical order
  first: string | null; // first / last unit of its contiguous run
  last: string | null;
  carnes: number; // carnes locations added to aux_inv outside its run
}

const loadOf = (u: Unit) => u.load;
const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

/** Section order: the given role order, with aux_inv last (it also takes the Carnes locations). */
function sectionOrder(roles: RoleKey[]): RoleKey[] {
  return [...roles.filter((r) => r !== 'aux_inv'), ...roles.filter((r) => r === 'aux_inv')];
}

/**
 * Share `seq` (physical order) among roles as contiguous sections, then lay each role's section
 * over its slots in day order, proportional to each slot's free capacity.
 */
function distribute(seq: Unit[], slots: Slot[], roles: RoleKey[], cmp: (a: Unit, b: Unit) => number): Section[] {
  const order = sectionOrder(roles.filter((r) => slots.some((s) => s.role === r)));
  if (order.length === 0) return [];
  const hasAux = order.includes('aux_inv');
  const forced = hasAux ? seq.filter((u) => u.carnes) : [];
  const rest = hasAux ? seq.filter((u) => !u.carnes) : seq;

  const freeBy = order.map((r) => Math.max(0, slack(slots.filter((s) => s.role === r))));
  const totalFree = sum(freeBy);
  const fill = totalFree > 0 ? sum(seq.map(loadOf)) / totalFree : 0;
  const forcedLoad = sum(forced.map(loadOf));
  const targets = totalFree > 0 ? order.map((r, i) => Math.max(0, fill * freeBy[i]! - (r === 'aux_inv' ? forcedLoad : 0))) : order.map(() => 1);
  const groups = cutInto(rest, loadOf, targets);

  return order.map((role, i) => {
    const run = groups[i]!;
    const units = role === 'aux_inv' ? [...forced, ...run].sort(cmp) : run;
    const roleSlots = slots.filter((s) => s.role === role);
    const slotFree = roleSlots.map(free);
    const parts = cutInto(units, loadOf, sum(slotFree) > 0 ? slotFree : roleSlots.map(() => 1));
    parts.forEach((part, j) => part.forEach((u) => addItem(roleSlots[j]!, u, 'rotation')));
    return { role, units, first: run[0]?.key ?? null, last: run[run.length - 1]?.key ?? null, carnes: role === 'aux_inv' ? forced.length : 0 };
  });
}

/** physical mode. `seq` in walking order; `slots` = the whole cycle (non-extra), in day order. */
export function rotatePhysical(seq: Unit[], slots: Slot[], roles: RoleKey[], cmp: (a: Unit, b: Unit) => number): Section[] {
  return distribute(seq, slots, roles, cmp);
}

/** Average counted tier (1–8, tier 0 excluded) of a unit's SKUs; null when none has a tier. */
export function tierScore(u: Unit): number | null {
  const ranks = u.skus.filter((k) => countedTier(k.tier) !== null).map((k) => k.tier.rank!);
  return ranks.length ? sum(ranks) / ranks.length : null;
}

/** tier_order mode: returns the units of each cycle week (best sellers in week 1). */
export function rotateTierOrder(seq: Unit[], slots: Slot[], roles: RoleKey[], cycleWeeks: number, cmp: (a: Unit, b: Unit) => number): Unit[][] {
  const pos = new Map(seq.map((u, i) => [u.key, i]));
  const scored = seq.map((u) => ({ u, s: tierScore(u) }));
  scored.sort((a, b) => {
    if (a.s === null || b.s === null) return a.s === b.s ? pos.get(a.u.key)! - pos.get(b.u.key)! : a.s === null ? 1 : -1;
    return a.s - b.s || pos.get(a.u.key)! - pos.get(b.u.key)!;
  });
  const weeks = cutInto(scored.map((x) => x.u), loadOf, Array.from({ length: cycleWeeks }, () => 1));
  weeks.forEach((units, i) => {
    const weekSlots = slots.filter((s) => s.week === i + 1);
    distribute([...units].sort(cmp), weekSlots, roles, cmp);
  });
  return weeks;
}
