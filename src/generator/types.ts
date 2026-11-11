// Plan generator types. Pure data: everything the generator needs comes in, the plan comes out.
import type { LocationRule } from '../lib/locationRules';

export type RoleKey = 'aux_inv' | 'lider_am' | 'lider_pm' | 'aux_rec' | 'aux_cal';
export type RotationMode = 'physical' | 'tier_order';
export type SizingBasis = 'positive' | 'catalog';
/** Assembly category ("Categoría Final"). null = unknown, planned as abarrotes. */
export type Category = 'fyv' | 'carnes' | 'abarrotes' | null;

// ───────────── input ─────────────

export interface HubConfig {
  hubSlug: string;
  city: string; // lowercase: monterrey | saltillo | cdmx | guadalajara
  workdays: number[]; // 1 = Mon .. 7 = Sun
  cycleWeeks: number;
  rotationMode: RotationMode;
  walkingOrder: string[]; // aisle codes; empty = alphabetical
  sizingBasis: SizingBasis;
  /** Weekly SKU budget for the tier-0 route. null = aux_inv capacity minus the larger freezer half. */
  tier0Budget?: number | null;
  /** Cycle week (1-based) that gets the "Ubicaciones sin identificar" extra block. Default 1. */
  unidentifiedWeek?: number;
}

export interface Role {
  key: RoleKey;
  label: string;
  weeklyCapacity: number; // SKUs / week
  days: number[]; // 1 = Mon .. 7 = Sun
  active: boolean;
}

/** One row of the Sorting Hub export: [name, barcode, pasillo, estante, nivel, col6, temp]. */
export interface SortingRow {
  name: string;
  barcode: string;
  pasillo: string;
  estante: string;
  nivel: string;
  temp: string;
}

export interface Product {
  sku: string;
  barcode: string;
  unit: 'kg' | 'pz' | null;
  category: Category;
}

/** A row of mv_product_city (city as stored, e.g. 'Monterrey'). */
export interface CityTierRow {
  sku: string;
  city: string;
  tiers: string | null;
}

export interface GeneratorInput {
  hub: HubConfig;
  roles: Role[];
  rules: LocationRule[];
  sorting: SortingRow[];
  products: Product[];
  tierRows: CityTierRow[];
  /** sku → last known quantity (ic_sku_stock_est). Missing = unknown. */
  stock: Record<string, number>;
  cycleStart: string; // Monday, 'YYYY-MM-DD'
  anchorMonday: string; // global week 1, 'YYYY-MM-DD'
}

// ───────────── tiers ─────────────

export interface TierInfo {
  tier0: boolean;
  /** Sales tier tag, e.g. '1', '5.1'. null when the SKU only has letter tags or no value. */
  sales: string | null;
  /** Numeric sort key of the sales tier: '5.1' → 5.1, '4' → 4. */
  rank: number | null;
}

export type TierLookup = (sku: string) => TierInfo;

// ───────────── locations ─────────────

export type UnitKind = 'shelf' | 'aisle_only' | 'freezer' | 'cold_room' | 'unidentified';

export interface Sku {
  barcode: string;
  sku: string | null; // null = not in Masterview
  name: string;
  unit: 'kg' | 'pz' | null;
  category: Category;
  tier: TierInfo;
  /** 1 = has stock, 0 = none, ratio for unknown. */
  positive: number;
}

export interface Unit {
  key: string; // 'G-10', 'G (sin estante)', 'B07', 'Cuarto frío Q', 'Sin identificar: G}'
  kind: UnitKind;
  aisle: string; // raw aisle code it belongs to
  estante: string; // '' for whole-aisle units
  skus: Sku[];
  count: number; // SKUs
  positiveEst: number; // SKUs expected with stock
  load: number; // count or positiveEst, per sizing_basis
  carnes: boolean; // mostly Carnes → owned by aux_inv
}

export type ExceptionCode = 'NO_POSITION' | 'AISLE_ONLY' | 'UNKNOWN_CODE' | 'FROZEN_NO_FREEZER' | 'NOT_IN_MV' | 'DUP_POSITION';

export interface PlanException {
  code: ExceptionCode;
  barcode: string;
  sku: string | null;
  name: string;
  rawPos: string;
  owner: RoleKey;
  /** Location where it is planned, when it has one. */
  unitKey: string | null;
}

// ───────────── output ─────────────

export type Layer = 'tier0' | 'freezer' | 'rotation' | 'tier_weekly' | 'unidentified';

export interface SlotItem {
  unitKey: string;
  layer: Layer;
  load: number;
  count: number;
}

export interface Slot {
  week: number; // 1 .. cycleWeeks
  globalWeek: number;
  day: string; // 'YYYY-MM-DD'
  role: RoleKey;
  capacity: number;
  /** True for the extra "Ubicaciones sin identificar" block: not part of the role's capacity. */
  extra: boolean;
  items: SlotItem[];
  notes: string[];
}

export interface RoleLoad {
  role: RoleKey;
  label: string;
  cycleCapacity: number;
  assigned: number;
  byLayer: Record<Layer, number>;
  over: number; // load above capacity, 0 when it fits
  section: string; // 'A-1 → D-8' (physical mode)
}

export interface LayerSummary {
  layer: Layer;
  units: number; // distinct locations in the layer
  skus: number; // SKUs on those locations
  perWeek: number; // average load per week
  cycleLoad: number; // all visits in the cycle
}

export interface TierCoverage {
  tier: string; // '1', '5.1', ...
  total: number; // tier-N SKUs in the hub (tier 0 excluded)
  coveredWeekly: number;
}

export interface LoadReport {
  basis: SizingBasis;
  cycleCapacity: number;
  cycleLoad: number;
  layers: LayerSummary[];
  roles: RoleLoad[];
  tier0: { skus: number; covered: number; uncoveredShelves: string[]; budget: number };
  freezers: { a: string[]; b: string[]; kg: [number, number]; pz: [number, number] };
  weekly: { leftoverBeforeTiers: number; tierCoverage: TierCoverage[]; usefulSkus: number; totalSkus: number };
  unidentified: { codes: number; skus: number };
  exceptions: Record<ExceptionCode, number>;
  aisleJumps: { role: RoleKey; day: string; jumps: number }[];
  overload: { over: number; fix: string | null };
  shorterCycle: number | null; // weeks the whole cycle would fit in, when less than cycleWeeks
  messages: string[]; // Spanish, for the UI
}

export interface Plan {
  generatorVersion: string;
  hubSlug: string;
  cycleStart: string;
  cycleWeeks: number;
  rotationMode: RotationMode;
  units: Unit[];
  slots: Slot[];
  exceptions: PlanException[];
  report: LoadReport;
}
