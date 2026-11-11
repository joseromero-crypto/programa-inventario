// Tiers (hub-rules 2.1). The plan logic only ever reads tiers through tierSource(hub).
import type { CityTierRow, HubConfig, TierInfo, TierLookup } from './types';

const SALES_TAG = /^([1-8])(?:\.(\d+))?$/;
const NO_TIER: TierInfo = Object.freeze({ tier0: false, sales: null, rank: null });

/** Parse a stored Tiers cell like '3; 0; F' or '5.1'. Letters (C, F, N) are ignored. */
export function parseTiers(raw: string | null | undefined): TierInfo {
  if (!raw) return NO_TIER;
  let tier0 = false;
  let sales: string | null = null;
  let rank: number | null = null;
  for (const tag of raw.split(';').map((t) => t.trim())) {
    if (tag === '0') {
      tier0 = true;
      continue;
    }
    const m = SALES_TAG.exec(tag);
    if (m && sales === null) {
      sales = tag;
      rank = Number(m[1]) + (m[2] ? Number(`0.${m[2]}`) : 0);
    }
  }
  return { tier0, sales, rank };
}

/** Tier 1–8 used for counts and scores. Tier 0 wins: a tier-0 SKU has no sales tier here. */
export function countedTier(t: TierInfo): string | null {
  return t.tier0 ? null : t.sales;
}

export function tierRank(tag: string): number {
  const m = SALES_TAG.exec(tag);
  return m ? Number(m[1]) + (m[2] ? Number(`0.${m[2]}`) : 0) : Number.POSITIVE_INFINITY;
}

/** Sales order: '1' < '2' < … < '5.1' < '5.2' < … < '8.2'. */
export function compareTiers(a: string, b: string): number {
  return tierRank(a) - tierRank(b) || (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * The single source of tiers for a hub: Masterview's per-city Tiers column
 * (mv_product_city.tiers, joined on lower(city) = hub.city).
 */
export function tierSource(hub: Pick<HubConfig, 'city'>, rows: CityTierRow[]): TierLookup {
  const city = hub.city.toLowerCase();
  const bySku = new Map<string, TierInfo>();
  for (const r of rows) {
    if (r.city.toLowerCase() === city) bySku.set(r.sku, parseTiers(r.tiers));
  }
  return (sku) => bySku.get(sku) ?? NO_TIER;
}
