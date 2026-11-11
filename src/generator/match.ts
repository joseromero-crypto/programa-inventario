// Sorting row → Masterview product. Pure.
// The Calii SKU (3 letters + 3 digits) is the identity everywhere in the plan. The Sorting Hub export
// has no SKU column, so a row is matched, in order, by:
//   1. sku   – only if the row carries one (future-proof; today's export doesn't)
//   2. name  – exact product name, ignoring case, accents and extra spaces
//   3. barcode – last resort; barcodes can be wrong, change or be missing. Leading zeros are ignored
//      (the export often drops them: 767203600993 vs 0767203600993).
// A name shared by several products is settled by the barcode; if that doesn't settle it, the name
// isn't used.
import type { Product, SortingRow } from './types';

export type MatchedBy = 'sku' | 'name' | 'barcode';

export interface Match {
  product: Product | null;
  by: MatchedBy | null;
}

export const SKU_RE = /^[A-Z]{3}\d{3}$/;

export function normalizeName(s: string | null | undefined): string {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeBarcode(s: string | null | undefined): string {
  const t = String(s ?? '').replace(/\s+/g, '');
  return t.replace(/^0+(?=\d)/, '');
}

function index(products: Product[], keyOf: (p: Product) => string): Map<string, Product[]> {
  const m = new Map<string, Product[]>();
  for (const p of products) {
    const k = keyOf(p);
    if (k === '') continue;
    const list = m.get(k);
    if (list) list.push(p);
    else m.set(k, [p]);
  }
  return m;
}

export function buildMatcher(products: Product[]): (row: Pick<SortingRow, 'name' | 'barcode' | 'sku'>) => Match {
  const sorted = [...products].sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0)); // ties resolve the same way every run
  const bySku = new Map(sorted.map((p) => [p.sku.trim().toUpperCase(), p]));
  const byName = index(sorted, (p) => normalizeName(p.name));
  const byBarcode = index(sorted, (p) => normalizeBarcode(p.barcode));

  return (row) => {
    const sku = String(row.sku ?? '').trim().toUpperCase();
    if (SKU_RE.test(sku) && bySku.has(sku)) return { product: bySku.get(sku)!, by: 'sku' };

    const bc = normalizeBarcode(row.barcode);
    const named = byName.get(normalizeName(row.name)) ?? [];
    if (named.length === 1) return { product: named[0]!, by: 'name' };
    if (named.length > 1 && bc !== '') {
      const hit = named.filter((p) => normalizeBarcode(p.barcode) === bc);
      if (hit.length === 1) return { product: hit[0]!, by: 'name' };
    }

    const coded = bc === '' ? [] : (byBarcode.get(bc) ?? []);
    if (coded.length >= 1) return { product: coded[0]!, by: 'barcode' };
    return { product: null, by: null };
  };
}
