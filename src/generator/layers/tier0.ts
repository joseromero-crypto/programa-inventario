// Layer 1: the tier-0 route (hub-rules 2, spec 4.3). Weekly, aux_inv. The cold room always goes
// on the route; then shelves ranked by their tier-0 SKUs (with stock estimate) until the budget runs out.
import type { SizingBasis, Unit } from '../types';

export interface Tier0Route {
  units: Unit[]; // cold rooms first, then shelves in walking order
  budget: number;
  tier0Skus: number; // tier-0 SKUs on shelves and in the cold room (freezers ignore tiers)
  covered: number; // tier-0 SKUs on the route
  uncovered: Unit[]; // shelves with tier-0 SKUs that didn't fit (they stay in the monthly rotation)
}

export function tier0Score(u: Unit, basis: SizingBasis): number {
  return u.skus.reduce((s, k) => s + (k.tier.tier0 ? (basis === 'catalog' ? 1 : k.positive) : 0), 0);
}
const tier0Count = (u: Unit) => u.skus.filter((k) => k.tier.tier0).length;

/** units must already be in physical order. */
export function buildTier0Route(units: Unit[], budget: number, basis: SizingBasis): Tier0Route {
  const cold = units.filter((u) => u.kind === 'cold_room');
  const shelves = units.filter((u) => (u.kind === 'shelf' || u.kind === 'aisle_only') && tier0Count(u) > 0);
  const pos = new Map(units.map((u, i) => [u.key, i]));
  const ranked = [...shelves].sort((a, b) => tier0Score(b, basis) - tier0Score(a, basis) || pos.get(a.key)! - pos.get(b.key)!);

  let left = budget - cold.reduce((s, u) => s + u.load, 0);
  const picked = new Set<string>();
  const uncovered: Unit[] = [];
  for (const u of ranked) {
    if (u.load <= left + 1e-9) {
      picked.add(u.key);
      left -= u.load;
    } else uncovered.push(u);
  }
  const route = [...cold, ...shelves.filter((u) => picked.has(u.key))];
  return {
    units: route,
    budget,
    tier0Skus: units.filter((u) => u.kind === 'cold_room' || u.kind === 'shelf' || u.kind === 'aisle_only').reduce((s, u) => s + tier0Count(u), 0),
    covered: route.reduce((s, u) => s + tier0Count(u), 0),
    uncovered: uncovered.sort((a, b) => pos.get(a.key)! - pos.get(b.key)!),
  };
}
