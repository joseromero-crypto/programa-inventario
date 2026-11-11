// Unit tests for the generator's building blocks.
import { describe, expect, it } from 'vitest';
import { addDays, globalWeek, isoWeekday } from '../../src/lib/time';
import { compareTiers, countedTier, cutInto, cutSequence, parseTiers, tierSource, aisleComparator, aisleJumps, normalize } from '../../src/generator';
import { compareEstante } from '../../src/generator/order';
import { splitFreezers } from '../../src/generator/layers/freezers';
import { buildTier0Route } from '../../src/generator/layers/tier0';
import { coveragePhrase, selectHighRotation } from '../../src/generator/layers/highRotation';
import { finishUnit } from '../../src/generator/normalize';
import type { Sku, Unit } from '../../src/generator';
import { CONTRY_RULES, contryInput, rule } from './helpers';

describe('time helpers', () => {
  it('adds days and reads ISO weekdays without zone shifts', () => {
    expect(addDays('2026-11-09', 1)).toBe('2026-11-10');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-11-09', -7)).toBe('2026-11-02');
    expect(isoWeekday('2026-11-09')).toBe(1);
    expect(isoWeekday('2026-11-15')).toBe(7);
  });
  it('numbers global weeks from the anchor Monday', () => {
    expect(globalWeek('2026-11-09', '2026-11-09')).toBe(1);
    expect(globalWeek('2026-11-09', '2026-11-15')).toBe(1);
    expect(globalWeek('2026-11-09', '2026-11-16')).toBe(2);
    expect(globalWeek('2026-11-09', '2026-12-07')).toBe(5);
  });
});

describe('tiers', () => {
  it('parses the stored format (hub-rules 2.1)', () => {
    expect(parseTiers('4')).toEqual({ tier0: false, sales: '4', rank: 4 });
    expect(parseTiers('5.1')).toEqual({ tier0: false, sales: '5.1', rank: 5.1 });
    expect(parseTiers('1; 0')).toEqual({ tier0: true, sales: '1', rank: 1 });
    expect(parseTiers('3; 0; F')).toEqual({ tier0: true, sales: '3', rank: 3 });
    expect(parseTiers('C; F')).toEqual({ tier0: false, sales: null, rank: null });
    expect(parseTiers(null)).toEqual({ tier0: false, sales: null, rank: null });
    expect(parseTiers('')).toEqual({ tier0: false, sales: null, rank: null });
  });
  it('tier 0 wins: a tier-0 SKU counts in no sales tier', () => {
    expect(countedTier(parseTiers('1; 0'))).toBeNull();
    expect(countedTier(parseTiers('6.2'))).toBe('6.2');
  });
  it('sorts sub-tiers by number', () => {
    expect(['6.1', '5.2', '1', '5.1', '8.2', '4'].sort(compareTiers)).toEqual(['1', '4', '5.1', '5.2', '6.1', '8.2']);
  });
  it('tierSource joins on lower(city) and ignores other cities', () => {
    const t = tierSource({ city: 'monterrey' }, [
      { sku: 'A', city: 'Monterrey', tiers: '2' },
      { sku: 'A', city: 'Saltillo', tiers: '1; 0' },
      { sku: 'B', city: 'CDMX', tiers: '3' },
    ]);
    expect(t('A')).toEqual({ tier0: false, sales: '2', rank: 2 });
    expect(t('B').sales).toBeNull();
    expect(tierSource({ city: 'cdmx' }, [{ sku: 'B', city: 'CDMX', tiers: '3' }])('B').sales).toBe('3');
  });
});

describe('physical order', () => {
  it('defaults to the Spanish alphabet and honours the walking order', () => {
    expect(['O', 'Ñ', 'N', 'B', 'A'].sort(aisleComparator([]))).toEqual(['A', 'B', 'N', 'Ñ', 'O']);
    expect(['A', 'B', 'C', 'Q'].sort(aisleComparator(['Q', 'C']))).toEqual(['Q', 'C', 'A', 'B']);
  });
  it('sorts estantes by number, sin estante last', () => {
    expect(['10', '', '2', '1'].sort(compareEstante)).toEqual(['1', '2', '10', '']);
  });
  it('counts aisle jumps', () => {
    expect(aisleJumps([{ aisle: 'A' }, { aisle: 'A' }, { aisle: 'B' }, { aisle: 'G' }])).toBe(2);
  });
});

describe('contiguous cuts', () => {
  it('keeps order, never splits, follows targets', () => {
    const idx = cutSequence([10, 10, 10, 10, 10, 10], [1, 2]);
    expect(idx).toEqual([0, 0, 1, 1, 1, 1]);
    expect(cutInto([1, 2, 3, 4], (x) => x, [1, 1, 1, 1]).flat()).toEqual([1, 2, 3, 4]);
  });
  it('gives nothing to a zero target, and shares equally when all are zero', () => {
    expect(cutSequence([5, 5, 5], [0, 1])).toEqual([1, 1, 1]);
    expect(cutSequence([5, 5], [0, 0])).toEqual([0, 1]);
  });
  it('puts a big unit where its midpoint falls', () => {
    expect(cutSequence([1, 100, 1], [1, 1])).toEqual([0, 0, 1]);
  });
});

describe('normalize (spec 4.1, hub-rules 2.4)', () => {
  const sorting = [
    { name: 'a', barcode: '1', pasillo: 'D', estante: '3', nivel: '', temp: 'Ambiente' },
    { name: 'b', barcode: '2', pasillo: 'D', estante: '', nivel: '', temp: 'Ambiente' }, // aisle only
    { name: 'c', barcode: '3', pasillo: '', estante: '', nivel: '', temp: 'Ambiente' }, // no position
    { name: 'd', barcode: '4', pasillo: '', estante: '', nivel: '', temp: '-18' }, // frozen, no freezer
    { name: 'e', barcode: '5', pasillo: 'Z', estante: '1', nivel: '', temp: '-18' }, // frozen on a shelf
    { name: 'f', barcode: '6', pasillo: 'G}', estante: '10', nivel: '', temp: 'Ambiente' }, // unknown code
    { name: 'g', barcode: '7', pasillo: 'b1', estante: '4', nivel: '', temp: '-18' }, // freezer B01
    { name: 'h', barcode: '8', pasillo: 'D', estante: '3', nivel: '', temp: 'Ambiente' }, // not in MV
    { name: 'i', barcode: '9', pasillo: 'D', estante: '4', nivel: '', temp: '1' }, // FyV: dropped
    { name: 'a', barcode: '1', pasillo: 'M', estante: '1', nivel: '', temp: 'Ambiente' }, // duplicate position
    { name: 'j', barcode: '10', pasillo: 'BODEGA', estante: '', nivel: '', temp: 'Ambiente' }, // ignored
    { name: 'k', barcode: '11', pasillo: 'Q', estante: '2', nivel: '', temp: '4' }, // cold room
  ];
  const products = ['1', '2', '3', '4', '5', '6', '7', '10', '11'].map((b) => ({ sku: `S${b}`, barcode: b, unit: 'pz' as const, category: 'abarrotes' as const }));
  products.push({ sku: 'S9', barcode: '9', unit: 'pz', category: 'fyv' as never });
  const n = normalize({ rules: CONTRY_RULES, sorting, products, tiers: () => ({ tier0: false, sales: null, rank: null }), stock: { S1: 3, S2: 0 }, sizingBasis: 'positive', walkingOrder: [] });
  const codes = (c: string) => n.exceptions.filter((e) => e.code === c).map((e) => e.barcode);

  it('builds one unit per location kind', () => {
    expect(n.units.map((u) => [u.key, u.kind])).toEqual([
      ['B01', 'freezer'],
      ['D-3', 'shelf'],
      ['D (sin estante)', 'aisle_only'],
      ['Sin identificar: G}', 'unidentified'],
      ['M-1', 'shelf'],
      ['Cuarto frío Q', 'cold_room'],
    ]);
  });
  it('raises every exception type', () => {
    expect(codes('AISLE_ONLY')).toEqual(['2']);
    expect(codes('NO_POSITION')).toEqual(['3']);
    expect(codes('FROZEN_NO_FREEZER').sort()).toEqual(['4', '5']);
    expect(codes('UNKNOWN_CODE')).toEqual(['6']);
    expect(codes('NOT_IN_MV')).toEqual(['8']);
    expect(codes('DUP_POSITION')).toEqual(['1']);
  });
  it('drops FyV and ignored codes', () => {
    expect(n.dropped).toEqual({ fyv: 1, ignored: 1 });
    expect(n.units.flatMap((u) => u.skus.map((s) => s.barcode))).not.toContain('9');
  });
  it('sizes unknown-stock SKUs at the hub positive ratio', () => {
    expect(n.positiveRatio).toBe(0.5); // S1 > 0, S2 = 0
    const d3 = n.units.find((u) => u.key === 'D-3')!;
    expect(d3.count).toBe(2);
    expect(d3.positiveEst).toBe(1 + 0.5); // barcode 1 has stock, barcode 8 unknown
  });
});

const sku = (o: Partial<Sku>): Sku => ({ barcode: 'x', sku: 'x', name: '', unit: 'pz', category: 'abarrotes', tier: { tier0: false, sales: null, rank: null }, positive: 1, ...o });
const unitOf = (key: string, skus: Sku[], kind: Unit['kind'] = 'shelf'): Unit =>
  finishUnit({ key, kind, aisle: key.split('-')[0]!, estante: key.split('-')[1] ?? '', skus }, 'positive');
const t = (sales: string, tier0 = false) => ({ tier0, sales, rank: Number(sales) });

describe('freezers (spec 4.4)', () => {
  it('splits real Contry freezers within ±10% of half for kg and for pz', () => {
    const units = normalize({ ...contryInput(), tiers: () => ({ tier0: false, sales: null, rank: null }), sizingBasis: 'positive', walkingOrder: [] }).units.filter((u) => u.kind === 'freezer');
    expect(units.length).toBe(14);
    const s = splitFreezers(units);
    for (const [a, b] of [s.kg, s.pz]) {
      const half = (a + b) / 2;
      expect(Math.abs(a - half)).toBeLessThanOrEqual(0.1 * half);
    }
    expect(s.a.length + s.b.length).toBe(14);
  });
  it('ignores tiers', () => {
    const f = (k: string, n: number, tier: string) => unitOf(k, Array.from({ length: n }, () => sku({ tier: t(tier) })), 'freezer');
    const a = splitFreezers([f('B01', 10, '1'), f('B02', 10, '8'), f('B03', 10, '1'), f('B04', 10, '8')]);
    expect(a.pz).toEqual([20, 20]);
  });
});

describe('tier-0 route (layer 1)', () => {
  const cold = unitOf('Cuarto frío Q', [sku({}), sku({})], 'cold_room');
  const dense = unitOf('D-1', [sku({ tier: t('1', true) }), sku({ tier: t('1', true) }), sku({})]);
  const sparse = unitOf('E-1', [sku({ tier: t('2', true) }), sku({}), sku({}), sku({})]);
  const none = unitOf('F-1', [sku({ tier: t('1') })]);
  it('always takes the cold room, then the densest shelves within budget', () => {
    const r = buildTier0Route([cold, dense, sparse, none], 6, 'positive');
    expect(r.units.map((u) => u.key)).toEqual(['Cuarto frío Q', 'D-1']);
    expect(r.uncovered.map((u) => u.key)).toEqual(['E-1']);
    expect([r.covered, r.tier0Skus]).toEqual([2, 3]);
  });
  it('takes them all with enough budget, and never a shelf without tier 0', () => {
    expect(buildTier0Route([cold, dense, sparse, none], 100, 'positive').units.map((u) => u.key)).toEqual(['Cuarto frío Q', 'D-1', 'E-1']);
  });
});

describe('high-rotation tiers (layer 4)', () => {
  const shelf = (k: string, tiers: string[]) => unitOf(k, tiers.map((x) => sku({ tier: x === '0' ? t('1', true) : t(x) })));
  const a = shelf('A-1', ['1', '1', '1', '5']); // load 4
  const b = shelf('B-1', ['2', '2']); // load 2
  const c = shelf('C-1', ['1', '3', '3', '3', '3', '3']); // load 6
  const d = shelf('D-1', ['0', '0']); // tier 0 only
  it('adds tier 1 shelves first, densest first, each costing load × (weeks − 1)', () => {
    const h = selectHighRotation([a, b, c, d], [], 12, 4, 'positive');
    expect(h.units.map((u) => u.key)).toEqual(['A-1']); // A (12) fits, C (18) doesn't → stop before tier 2
    expect(h.spareAfter).toBe(0);
    expect(coveragePhrase(h.coverage)).toBe('alcanza 75% de tier 1');
    expect([h.usefulSkus, h.totalSkus]).toEqual([3, 4]);
  });
  it('moves to the next tier only once the current one is complete', () => {
    const h = selectHighRotation([a, b, c], [], 36, 4, 'positive');
    expect(h.units.map((u) => u.key)).toEqual(['A-1', 'B-1', 'C-1']);
    expect(coveragePhrase(h.coverage)).toBe('alcanza tiers 1 a 5 completos');
    const tight = selectHighRotation([a, b, c], [], 30, 4, 'positive'); // tier 1 done, B (6) no longer fits
    expect(coveragePhrase(tight.coverage)).toBe('alcanza tier 1 completo');
  });
  it('gets nothing without spare capacity, and tier-0 SKUs never count', () => {
    const h = selectHighRotation([a, d], [], 0, 4, 'positive');
    expect(h.units).toEqual([]);
    expect(h.coverage.map((c) => [c.tier, c.total])).toEqual([['1', 3], ['5', 1]]);
  });
});

it('rule helper matches the seeded freezer rule', () => {
  expect(rule(10, '^B0*([1-9])$', 'B0$1', 'freezer').kind).toBe('freezer');
});
