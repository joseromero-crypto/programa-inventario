// Shared test inputs: a slice of real Contry data (tests/fixtures/contry-slice.json) plus builders.
import type { LocationRule } from '../../src/lib/locationRules';
import type { CityTierRow, GeneratorInput, HubConfig, Product, Role, RoleKey, SortingRow } from '../../src/generator';
import fixture from '../fixtures/contry-slice.json';

const raw = fixture as unknown as {
  sorting: [string, string, string, string, string, string][];
  products: Product[];
  tierRows: CityTierRow[];
  stock: Record<string, number>;
};

export const rule = (priority: number, match_regex: string, normalize_to: string | null, kind: LocationRule['kind']): LocationRule => ({ priority, match_regex, normalize_to, kind, group_label: null, active: true });

/** Contry's seeded rules (0002_ic_seed.sql). */
export const CONTRY_RULES: LocationRule[] = [
  rule(10, '^B0*([1-9])$', 'B0$1', 'freezer'),
  rule(11, '^B0*([1-9]\\d+)$', 'B$1', 'freezer'),
  rule(30, '^(ARMADO|BODEGA|AGUA|FAR)$', null, 'ignore'),
  rule(40, '^(Q|W)$', 'Cuarto frío $1', 'cold_room'),
  rule(100, '^[A-ZÑ]$', null, 'shelf_aisle'),
];

export const role = (key: RoleKey, weeklyCapacity: number, days: number[], label: string = key): Role => ({ key, label, weeklyCapacity, days, active: true });

export function contryHub(over: Partial<HubConfig> = {}): HubConfig {
  return { hubSlug: 'mh-contry', city: 'monterrey', workdays: [2, 3, 4, 5], cycleWeeks: 4, rotationMode: 'physical', walkingOrder: [], sizingBasis: 'positive', ...over };
}

/** Capacities scaled to the slice (it holds ~1/9 of Contry), so every layer has something to do. */
export function contryRoles(days = [2, 3, 4, 5]): Role[] {
  return [
    role('aux_inv', 160, days, 'Aux. de inventarios'),
    role('lider_am', 40, days, 'Líder turno día'),
    role('lider_pm', 40, days, 'Líder turno tarde'),
    role('aux_cal', 0, days, 'Aux. de calidad'),
    role('aux_rec', 50, days, 'Aux. de recepción'),
  ];
}

export const contrySorting = (): SortingRow[] => raw.sorting.map(([name, barcode, pasillo, estante, nivel, temp]) => ({ name, barcode, pasillo, estante, nivel, temp }));

export function contryInput(over: Partial<GeneratorInput> = {}, hub: Partial<HubConfig> = {}): GeneratorInput {
  return {
    hub: contryHub(hub),
    roles: contryRoles(),
    rules: CONTRY_RULES,
    sorting: contrySorting(),
    products: raw.products,
    tierRows: raw.tierRows,
    stock: raw.stock,
    cycleStart: '2026-11-09',
    anchorMonday: '2026-11-09',
    ...over,
  };
}
