// Layer 4: high-rotation tiers, weekly, filled automatically with what's left after layers 1–3
// (hub-rules 2, 2.2). Tier 1 first, then 2, 3, … 5.1 before 5.2. Abarrotes only. Whole shelves.
// A shelf moved here leaves the monthly rotation, so it costs load × (cycle_weeks − 1) per cycle.
import { compareTiers, countedTier } from '../tiers';
import type { SizingBasis, Sku, TierCoverage, Unit } from '../types';

export interface HighRotation {
  units: Unit[]; // chosen shelves, physical order
  coverage: TierCoverage[];
  usefulSkus: number; // tier-targeted SKUs on the chosen shelves
  totalSkus: number; // all SKUs on the chosen shelves
  spareBefore: number; // cycle spare before this layer
  spareAfter: number;
}

const isAbarrotes = (k: Sku) => k.category === 'abarrotes' || k.category === null;
const tierOf = (k: Sku) => (isAbarrotes(k) ? countedTier(k.tier) : null);

/**
 * candidates: rotation shelves (physical order). weekly: units already visited every week (tier-0 route).
 * spare: cycle capacity left after layers 1–3.
 */
export function selectHighRotation(candidates: Unit[], weekly: Unit[], spare: number, cycleWeeks: number, basis: SizingBasis): HighRotation {
  const pos = new Map(candidates.map((u, i) => [u.key, i]));
  const all = [...weekly, ...candidates];
  const tiers = [...new Set(all.flatMap((u) => u.skus.map(tierOf)).filter((t): t is string => t !== null))].sort(compareTiers);

  const chosen = new Set<string>();
  const targeted = new Set<string>();
  let left = spare;
  if (cycleWeeks > 1) {
    for (const tier of tiers) {
      const score = (u: Unit) => u.skus.reduce((s, k) => s + (tierOf(k) === tier ? (basis === 'catalog' ? 1 : k.positive) : 0), 0);
      const shelves = candidates
        .filter((u) => (u.kind === 'shelf' || u.kind === 'aisle_only') && !chosen.has(u.key) && score(u) > 0)
        .sort((a, b) => score(b) - score(a) || pos.get(a.key)! - pos.get(b.key)!);
      if (shelves.length === 0) continue;
      targeted.add(tier);
      let ranOut = false;
      for (const u of shelves) {
        const cost = u.load * (cycleWeeks - 1);
        if (cost <= left + 1e-9) {
          chosen.add(u.key);
          left -= cost;
        } else ranOut = true;
      }
      if (ranOut) break; // never jump to the next tier while this one is incomplete
    }
  }

  const units = candidates.filter((u) => chosen.has(u.key));
  const covered = new Set([...weekly.map((u) => u.key), ...chosen]);
  const coverage = tiers.map((tier) => {
    let total = 0;
    let coveredWeekly = 0;
    for (const u of all) {
      const n = u.skus.filter((k) => tierOf(k) === tier).length;
      total += n;
      if (covered.has(u.key)) coveredWeekly += n;
    }
    return { tier, total, coveredWeekly };
  });
  return {
    units,
    coverage,
    usefulSkus: units.reduce((s, u) => s + u.skus.filter((k) => targeted.has(tierOf(k) ?? '')).length, 0),
    totalSkus: Math.round(units.reduce((s, u) => s + u.count + u.looseCount, 0)),
    spareBefore: spare,
    spareAfter: left,
  };
}

/** 'alcanza tier 1 completo + 40% de tier 2', 'alcanza tiers 1 a 3 completos + 12% de tier 4'. */
export function coveragePhrase(coverage: TierCoverage[]): string {
  const complete: string[] = [];
  let partial = '';
  for (const c of coverage) {
    if (c.total === 0) continue;
    if (c.coveredWeekly >= c.total) {
      complete.push(c.tier);
      continue;
    }
    const pct = Math.floor((100 * c.coveredWeekly) / c.total);
    if (pct > 0) partial = `${pct}% de tier ${c.tier}`;
    break;
  }
  const parts: string[] = [];
  if (complete.length === 1) parts.push(`tier ${complete[0]} completo`);
  if (complete.length > 1) parts.push(`tiers ${complete[0]} a ${complete[complete.length - 1]} completos`);
  if (partial) parts.push(partial);
  return parts.length ? `alcanza ${parts.join(' + ')}` : 'no alcanza ningún tier';
}
