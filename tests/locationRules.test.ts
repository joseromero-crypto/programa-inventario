import { describe, expect, it } from 'vitest';
import { compileRules, matchCode, normalizeCode, unmatchedCodes, type LocationRule } from '../src/lib/locationRules';
import { summarizeSorting, type SortingItem } from '../src/lib/sources/sorting';

// Mirrors 0002_ic_seed.sql for San Nicolás (gets the HOLANDA/NESTLÉ rule) and the shared rules.
const rule = (priority: number, match_regex: string, normalize_to: string | null, kind: LocationRule['kind']): LocationRule =>
  ({ priority, match_regex, normalize_to, kind, group_label: null, active: true });
const SN: LocationRule[] = [
  rule(100, '^[A-ZÑ]$', null, 'shelf_aisle'),
  rule(10, '^B0*([1-9])$', 'B0$1', 'freezer'),
  rule(11, '^B0*([1-9]\\d+)$', 'B$1', 'freezer'),
  rule(20, '^(HOLANDA|NESTLÉ)$', null, 'freezer'),
  rule(30, '^(ARMADO|BODEGA|AGUA|FAR)$', null, 'ignore'),
  rule(40, '^A$', 'Cuarto frío', 'cold_room'),
];

describe('location rules', () => {
  const { compiled, errors } = compileRules(SN);
  it('compiles in priority order', () => {
    expect(errors).toEqual([]);
    expect(compiled.map((r) => r.priority)).toEqual([10, 11, 20, 30, 40, 100]);
  });
  it('normalizes freezer codes', () => {
    expect(matchCode('B1', compiled)?.unit_key).toBe('B01');
    expect(matchCode('B01', compiled)?.unit_key).toBe('B01');
    expect(matchCode('B007', compiled)?.unit_key).toBe('B07');
    expect(matchCode('B10', compiled)?.unit_key).toBe('B10');
    expect(matchCode('B010', compiled)?.unit_key).toBe('B10');
  });
  it('uses the first matching rule', () => {
    expect(matchCode('A', compiled)).toMatchObject({ unit_key: 'Cuarto frío', kind: 'cold_room' });
    expect(matchCode('G', compiled)).toMatchObject({ unit_key: 'G', kind: 'shelf_aisle' });
    expect(matchCode('NESTLÉ', compiled)?.kind).toBe('freezer');
    expect(matchCode('BODEGA', compiled)?.kind).toBe('ignore');
    expect(matchCode('B', compiled)?.kind).toBe('shelf_aisle'); // bare B: shown so a rule can be added
  });
  it('reports unmatched codes, most used first', () => {
    const counts = new Map([['G}', 3], ['|', 9], ['G', 40], ['A01', 2]]);
    expect(unmatchedCodes(counts, compiled)).toEqual([{ code: '|', rows: 9 }, { code: 'G}', rows: 3 }, { code: 'A01', rows: 2 }]);
  });
  it('skips inactive rules and reports bad regexes', () => {
    const r = compileRules([{ ...rule(1, '^G$', null, 'ignore'), active: false }, rule(2, '([', null, 'ignore')]);
    expect(r.compiled).toEqual([]);
    expect(r.errors).toHaveLength(1);
  });
  it('normalizes raw codes', () => {
    expect(normalizeCode(' b01 ')).toBe('B01');
    expect(normalizeCode(null)).toBe('');
  });
});

describe('summarizeSorting', () => {
  it('splits full / aisle-only / no position and counts codes', () => {
    const it_ = (pasillo: string, estante: string): SortingItem => ['x', '1', pasillo, estante, '', '', 'Ambiente'];
    const s = summarizeSorting({ items: [it_('G', '3'), it_('g ', ''), it_('', ''), it_('B1', '2'), it_(' ', '4')] });
    expect(s).toMatchObject({ rows: 5, fullPosition: 2, aisleOnly: 1, noPosition: 2 });
    expect([...s.codeCounts]).toEqual([['G', 2], ['B1', 1]]);
  });
});
