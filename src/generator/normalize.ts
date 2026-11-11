// Sorting rows → plannable locations (units) + exceptions (spec 4.1, hub-rules 2.4). Pure.
import { compileRules, matchCode, normalizeCode, type LocationRule } from '../lib/locationRules';
import { buildMatcher, normalizeName, type MatchedBy } from './match';
import { unitComparator } from './order';
import type { PlanException, Product, SizingBasis, Sku, SortingRow, TierLookup, Unit, UnitKind } from './types';

export interface NormalizeInput {
  rules: LocationRule[];
  sorting: SortingRow[];
  products: Product[];
  tiers: TierLookup;
  stock: Record<string, number>;
  sizingBasis: SizingBasis;
  walkingOrder: string[];
}

export interface Normalized {
  units: Unit[];
  exceptions: PlanException[];
  positiveRatio: number;
  dropped: { fyv: number; ignored: number };
  /** How sorting rows (FyV excluded) were matched to Masterview. */
  matching: Record<MatchedBy | 'none', number>;
}

export const isFrozen = (temp: string) => Number(String(temp).trim()) < 0;

/** Share of distinct SKUs with a stock record whose last quantity was > 0. Used to size unknown SKUs. */
export function positiveRatio(skus: (string | null)[], stock: Record<string, number>): number {
  let pos = 0;
  let known = 0;
  for (const s of new Set(skus)) {
    if (s === null || !(s in stock)) continue;
    known++;
    if (stock[s]! > 0) pos++;
  }
  return known === 0 ? 1 : pos / known;
}

interface Draft {
  key: string;
  kind: UnitKind;
  aisle: string;
  estante: string;
  skus: Sku[];
  ids: Set<string>;
}

export function finishUnit(d: Omit<Draft, 'ids'>, basis: SizingBasis, loose: { count: number; positive: number } = { count: 0, positive: 0 }): Unit {
  const count = d.skus.length;
  const positiveEst = d.skus.reduce((s, k) => s + k.positive, 0) + loose.positive;
  const carnes = d.skus.filter((k) => k.category === 'carnes').length;
  return {
    key: d.key,
    kind: d.kind,
    aisle: d.aisle,
    estante: d.estante,
    skus: d.skus,
    count,
    looseCount: loose.count,
    positiveEst,
    load: basis === 'catalog' ? count + loose.count : positiveEst,
    carnes: carnes * 2 > count,
  };
}

export function normalize(input: NormalizeInput): Normalized {
  const { compiled } = compileRules(input.rules);
  const match = buildMatcher(input.products);

  const rows = input.sorting
    .map((r) => {
      const m = match(r);
      const barcode = String(r.barcode ?? '').trim();
      // Identity in the plan: the Calii SKU; an unmatched row is known by its name (or barcode).
      const id = m.product?.sku ?? `?${normalizeName(r.name) || barcode}`;
      return { r, barcode, id, product: m.product as Product | null, by: m.by };
    })
    .filter((x) => x.id !== '?');
  const kept = rows.filter((x) => x.product?.category !== 'fyv');
  const matching: Normalized['matching'] = { sku: 0, name: 0, barcode: 0, none: 0 };
  for (const x of kept) matching[x.by ?? 'none']++;
  const ratio = positiveRatio(kept.map((x) => x.product?.sku ?? null), input.stock);

  const drafts = new Map<string, Draft>();
  const exceptions: PlanException[] = [];
  const seen = new Set<string>();
  let ignored = 0;

  const toSku = (x: (typeof kept)[number]): Sku => {
    const sku = x.product?.sku ?? null;
    const q = sku !== null ? input.stock[sku] : undefined;
    return {
      barcode: x.barcode,
      sku,
      name: String(x.r.name ?? '').trim(),
      matchedBy: x.by,
      unit: x.product?.unit ?? null,
      category: x.product?.category ?? null,
      tier: sku !== null ? input.tiers(sku) : { tier0: false, sales: null, rank: null },
      positive: q === undefined ? ratio : q > 0 ? 1 : 0,
    };
  };
  const exc = (code: PlanException['code'], x: (typeof kept)[number], rawPos: string, unitKey: string | null, aisle: string | null = null) =>
    exceptions.push({ code, barcode: x.barcode, sku: x.product?.sku ?? null, name: String(x.r.name ?? '').trim(), rawPos, owner: 'aux_inv', unitKey, aisle });
  // aisle → its sin-estante rows (no stop of their own: they're confirmed with the aisle's shelves)
  const loose = new Map<string, { x: (typeof kept)[number]; rawPos: string }[]>();
  const place = (x: (typeof kept)[number], key: string, kind: UnitKind, aisle: string, estante: string) => {
    let d = drafts.get(key);
    if (!d) drafts.set(key, (d = { key, kind, aisle, estante, skus: [], ids: new Set() }));
    if (d.ids.has(x.id)) return; // same SKU listed twice on one location
    d.ids.add(x.id);
    d.skus.push(toSku(x));
  };

  for (const x of kept) {
    const code = normalizeCode(x.r.pasillo);
    const estante = String(x.r.estante ?? '').trim();
    const rawPos = [code, estante].filter(Boolean).join('-');
    const frozen = isFrozen(x.r.temp);

    if (code === '') {
      exc(frozen ? 'FROZEN_NO_FREEZER' : 'NO_POSITION', x, '', null);
      continue;
    }
    const m = matchCode(code, compiled);
    if (m?.kind === 'ignore') {
      ignored++;
      continue;
    }

    let key: string;
    if (m === null) {
      key = `Sin identificar: ${code}`;
      place(x, key, 'unidentified', code, '');
      exc('UNKNOWN_CODE', x, rawPos, key);
    } else if (m.kind === 'freezer' || m.kind === 'cold_room') {
      key = m.unit_key;
      place(x, key, m.kind, code, '');
    } else if (frozen) {
      exc('FROZEN_NO_FREEZER', x, rawPos, null);
      continue;
    } else if (estante === '') {
      const list = loose.get(m.unit_key) ?? [];
      list.push({ x, rawPos });
      loose.set(m.unit_key, list);
      if (!x.product) exc('NOT_IN_MV', x, rawPos, null, m.unit_key);
      continue;
    } else {
      key = `${m.unit_key}-${estante}`;
      place(x, key, 'shelf', m.unit_key, estante);
    }
    if (!x.product) exc('NOT_IN_MV', x, rawPos, key);
    if (seen.has(x.id)) exc('DUP_POSITION', x, rawPos, key);
    seen.add(x.id);
  }

  // Sin-estante SKUs: spread over the aisle's shelves, by how many SKUs each shelf holds. A SKU that
  // also has a full position is already planned there. An aisle with no shelves keeps one stop.
  const placed = new Set([...drafts.values()].flatMap((d) => [...d.ids]));
  const share = new Map<string, { count: number; positive: number }>();
  for (const [aisle, rows] of [...loose].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const fresh = rows.filter((r, i) => !placed.has(r.x.id) && rows.findIndex((q) => q.x.id === r.x.id) === i);
    if (fresh.length === 0) continue;
    const shelves = [...drafts.values()].filter((d) => d.kind === 'shelf' && d.aisle === aisle);
    if (shelves.length === 0) {
      for (const r of fresh) place(r.x, `${aisle} (sin estante)`, 'aisle_only', aisle, '');
      for (const r of fresh) exc('AISLE_ONLY', r.x, r.rawPos, `${aisle} (sin estante)`, aisle);
      continue;
    }
    for (const r of fresh) exc('AISLE_ONLY', r.x, r.rawPos, null, aisle);
    const total = shelves.reduce((s, d) => s + d.skus.length, 0);
    const pos = fresh.reduce((s, r) => s + toSku(r.x).positive, 0);
    for (const d of shelves) {
      const w = d.skus.length / total;
      share.set(d.key, { count: fresh.length * w, positive: pos * w });
    }
  }

  const units = [...drafts.values()].map((d) => finishUnit(d, input.sizingBasis, share.get(d.key))).sort(unitComparator(input.walkingOrder));
  exceptions.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0) || (a.rawPos < b.rawPos ? -1 : a.rawPos > b.rawPos ? 1 : 0) || (a.barcode < b.barcode ? -1 : a.barcode > b.barcode ? 1 : 0));
  return { units, exceptions, positiveRatio: ratio, dropped: { fyv: rows.length - kept.length, ignored }, matching };
}
