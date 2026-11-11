// Everything the plan generator needs for one hub, read from Supabase and the Sorting Hub file.
// buildGeneratorInput is pure (tested); loadGeneratorInput does the reads.
import type { GeneratorInput, HubConfig, Product, Role, RoleKey, RotationMode, SizingBasis, SortingRow, CityTierRow } from '../../generator/types';
import type { LocationRule } from '../locationRules';
import { fetchMasterview, fetchTiers, type MvProduct } from '../sources/masterview';
import { fetchSorting, type SortingFile, type SortingItem } from '../sources/sorting';
import { fetchStock } from '../sources/stock';
import { supabase } from '../supabase';
import { syncServerNow } from '../sources/clock';
import { localDate, mondayOf, now } from '../time';

/** Global week 1 (hub-rules 1.1): every hub keeps the same calendar week index. */
export const ANCHOR_MONDAY = '2026-11-09';

export interface HubConfigRow {
  hub_slug: string;
  display_name: string;
  city: string;
  workdays: number[];
  cycle_weeks: number;
  rotation_mode: RotationMode;
  walking_order: string[];
  sizing_basis: SizingBasis;
}

export interface RoleRow {
  id: number;
  role_key: RoleKey;
  label: string;
  weekly_capacity: number;
  days: number[];
  active: boolean;
}

export interface RawInputs {
  hub: HubConfigRow;
  roles: RoleRow[];
  rules: LocationRule[];
  sorting: Pick<SortingFile, 'items'> & Partial<Pick<SortingFile, 'updatedAt'>>;
  products: MvProduct[];
  tiers: CityTierRow[];
  stock: [string, number | string][];
  /** Monterrey date of "today" (server clock). The cycle starts on its Monday. */
  today: string;
}

export interface LoadedInput {
  input: GeneratorInput;
  hub: HubConfigRow;
  roles: RoleRow[];
  sortingVersion: string | null;
  counts: { sorting: number; products: number; tiers: number; stock: number };
}

const toSortingRow = ([name, barcode, pasillo, estante, nivel, , temp]: SortingItem): SortingRow => ({
  name: String(name ?? ''),
  barcode: String(barcode ?? ''),
  pasillo: String(pasillo ?? ''),
  estante: String(estante ?? ''),
  nivel: String(nivel ?? ''),
  temp: String(temp ?? ''),
});

const toProduct = (p: MvProduct): Product => ({
  sku: p.sku,
  name: p.name,
  barcode: p.barcode,
  unit: p.calii_unit === 'kg' || p.calii_unit === 'pz' ? p.calii_unit : null,
  category: p.category,
});

export function buildGeneratorInput(raw: RawInputs): GeneratorInput {
  const hub: HubConfig = {
    hubSlug: raw.hub.hub_slug,
    city: raw.hub.city,
    workdays: raw.hub.workdays,
    cycleWeeks: raw.hub.cycle_weeks,
    rotationMode: raw.hub.rotation_mode,
    walkingOrder: raw.hub.walking_order ?? [],
    sizingBasis: raw.hub.sizing_basis,
  };
  const roles: Role[] = raw.roles.map((r) => ({ key: r.role_key, label: r.label, weeklyCapacity: r.weekly_capacity, days: r.days, active: r.active }));
  const stock: Record<string, number> = {};
  for (const [sku, qty] of raw.stock) {
    const n = Number(qty);
    if (sku && Number.isFinite(n)) stock[sku] = n;
  }
  return {
    hub,
    roles,
    rules: raw.rules,
    sorting: raw.sorting.items.map(toSortingRow),
    products: raw.products.map(toProduct),
    tierRows: raw.tiers,
    stock,
    cycleStart: mondayOf(raw.today),
    anchorMonday: ANCHOR_MONDAY,
  };
}

export async function fetchHubConfig(hubSlug: string): Promise<{ hub: HubConfigRow; roles: RoleRow[] }> {
  const [h, r] = await Promise.all([
    supabase.from('ic_hub_config').select('hub_slug, display_name, city, workdays, cycle_weeks, rotation_mode, walking_order, sizing_basis').eq('hub_slug', hubSlug).single(),
    supabase.from('ic_roles').select('id, role_key, label, weekly_capacity, days, active').eq('hub_slug', hubSlug).order('id'),
  ]);
  if (h.error) throw new Error(h.error.message);
  if (r.error) throw new Error(r.error.message);
  return { hub: h.data as HubConfigRow, roles: r.data as RoleRow[] };
}

export async function loadGeneratorInput(hubSlug: string): Promise<LoadedInput> {
  const [{ hub, roles }, rulesRes, sorting, products, stock] = await Promise.all([
    fetchHubConfig(hubSlug),
    supabase.from('ic_location_rules').select('priority, match_regex, normalize_to, kind, group_label, active').eq('hub_slug', hubSlug),
    fetchSorting(hubSlug),
    fetchMasterview(),
    fetchStock(hubSlug),
    syncServerNow(),
  ]);
  if (rulesRes.error) throw new Error(rulesRes.error.message);
  const tiers = await fetchTiers(hub.city);
  const input = buildGeneratorInput({ hub, roles, rules: rulesRes.data as LocationRule[], sorting, products, tiers, stock, today: localDate(now()) });
  return {
    input,
    hub,
    roles,
    sortingVersion: sorting.updatedAt ?? null,
    counts: { sorting: sorting.items.length, products: products.length, tiers: tiers.length, stock: Object.keys(input.stock).length },
  };
}
