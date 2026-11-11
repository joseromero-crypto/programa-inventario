// Sorting rows → plannable locations (units) + exceptions (spec 4.1, hub-rules 2.4). Pure.
import { compileRules, matchCode, normalizeCode, type LocationRule } from '../lib/locationRules';
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
  barcodes: Set<string>;
}

export function finishUnit(d: Omit<Draft, 'barcodes'>, basis: SizingBasis): Unit {
  const count = d.skus.length;
  const positiveEst = d.skus.reduce((s, k) => s + k.positive, 0);
  const carnes = d.skus.filter((k) => k.category === 'carnes').length;
  return {
    key: d.key,
    kind: d.kind,
    aisle: d.aisle,
    estante: d.estante,
    skus: d.skus,
    count,
    positiveEst,
    load: basis === 'catalog' ? count : positiveEst,
    carnes: carnes * 2 > count,
  };
}

export function normalize(input: NormalizeInput): Normalized {
  const { compiled } = compileRules(input.rules);
  const byBarcode = new Map<string, Product>();
  for (const p of input.products) if (p.barcode && !byBarcode.has(p.barcode.trim())) byBarcode.set(p.barcode.trim(), p);

  const rows = input.sorting
    .map((r) => ({ r, barcode: String(r.barcode ?? '').trim(), product: byBarcode.get(String(r.barcode ?? '').trim()) }))
    .filter((x) => x.barcode !== '');
  const kept = rows.filter((x) => x.product?.category !== 'fyv');
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
      unit: x.product?.unit ?? null,
      category: x.product?.category ?? null,
      tier: sku !== null ? input.tiers(sku) : { tier0: false, sales: null, rank: null },
      positive: q === undefined ? ratio : q > 0 ? 1 : 0,
    };
  };
  const exc = (code: PlanException['code'], x: (typeof kept)[number], rawPos: string, unitKey: string | null) =>
    exceptions.push({ code, barcode: x.barcode, sku: x.product?.sku ?? null, name: String(x.r.name ?? '').trim(), rawPos, owner: 'aux_inv', unitKey });
  const place = (x: (typeof kept)[number], key: string, kind: UnitKind, aisle: string, estante: string) => {
    let d = drafts.get(key);
    if (!d) drafts.set(key, (d = { key, kind, aisle, estante, skus: [], barcodes: new Set() }));
    if (d.barcodes.has(x.barcode)) return; // same SKU listed twice on one location
    d.barcodes.add(x.barcode);
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
      key = `${m.unit_key} (sin estante)`;
      place(x, key, 'aisle_only', m.unit_key, '');
      exc('AISLE_ONLY', x, rawPos, key);
    } else {
      key = `${m.unit_key}-${estante}`;
      place(x, key, 'shelf', m.unit_key, estante);
    }
    if (!x.product) exc('NOT_IN_MV', x, rawPos, key);
    if (seen.has(x.barcode)) exc('DUP_POSITION', x, rawPos, key);
    seen.add(x.barcode);
  }

  const units = [...drafts.values()].map((d) => finishUnit(d, input.sizingBasis)).sort(unitComparator(input.walkingOrder));
  exceptions.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0) || (a.rawPos < b.rawPos ? -1 : a.rawPos > b.rawPos ? 1 : 0) || (a.barcode < b.barcode ? -1 : a.barcode > b.barcode ? 1 : 0));
  return { units, exceptions, positiveRatio: ratio, dropped: { fyv: rows.length - kept.length, ignored } };
}
