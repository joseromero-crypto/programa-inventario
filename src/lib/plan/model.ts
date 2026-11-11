// Plan as the screens see it, whether it was just generated (not saved) or read from Supabase.
// toDraftPayload turns a generated Plan into what ic-admin saves. Pure, tested.
import { GENERATOR_VERSION } from '../../generator';
import { unitComparator } from '../../generator/order';
import type { ExceptionCode, Layer, LoadReport, Plan, RoleKey, UnitKind } from '../../generator/types';
import type { DraftPayload } from '../../../supabase/functions/_shared/plan_admin';

/** Compact exception list stored inside the report: [code, sku, name, rawPos, unitKey, aisle]. */
export type ExceptionRow = [ExceptionCode, string | null, string, string, string | null, string | null];

export interface StoredReport extends LoadReport {
  exceptionList?: ExceptionRow[];
}

export interface ViewUnit {
  id: number | null; // ic_slot_units.id; null until saved
  unitKey: string;
  unitKind: UnitKind;
  layer: Layer;
  load: number;
  skuCount: number;
  looseCount: number;
  positiveEst: number;
  walkRank: number;
  moved: boolean; // moved by the coordinator
}

export interface ViewSlot {
  week: number;
  globalWeek: number;
  day: string;
  role: RoleKey;
  capacity: number;
  extra: boolean;
  notes: string[];
  units: ViewUnit[];
}

export interface ViewPlan {
  id: number | null;
  status: 'preview' | 'draft' | 'active' | 'closed';
  hubSlug: string;
  cycleNo: number | null;
  cycleStart: string;
  cycleWeeks: number;
  generatorVersion: string;
  report: StoredReport;
  params: Record<string, unknown>;
  createdAt: string | null;
  activatedAt: string | null;
  slots: ViewSlot[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function toDraftPayload(plan: Plan, walkingOrder: string[], params: Record<string, unknown> = {}): DraftPayload {
  const byKey = new Map(plan.units.map((u) => [u.key, u]));
  const ranked = [...plan.units].sort(unitComparator(walkingOrder));
  const rank = new Map(ranked.map((u, i) => [u.key, i]));
  const exceptionList: ExceptionRow[] = plan.exceptions.map((e) => [e.code, e.sku, e.name, e.rawPos, e.unitKey, e.aisle]);
  return {
    hub_slug: plan.hubSlug,
    cycle_start: plan.cycleStart,
    cycle_weeks: plan.cycleWeeks,
    rotation_mode: plan.rotationMode,
    generator_version: plan.generatorVersion ?? GENERATOR_VERSION,
    params,
    report: { ...plan.report, exceptionList } as unknown as Record<string, unknown>,
    slots: plan.slots.map((s) => ({
      week: s.week,
      global_week: s.globalWeek,
      day: s.day,
      role: s.role,
      capacity: r2(s.capacity),
      extra: s.extra,
      notes: s.notes,
      items: s.items.map((i) => {
        const u = byKey.get(i.unitKey);
        if (!u) throw new Error(`Ubicación ${i.unitKey} sin datos en el plan`);
        return {
          unit_key: i.unitKey,
          unit_kind: u.kind,
          layer: i.layer,
          load: r2(i.load),
          sku_count: i.count,
          loose_count: r2(i.looseCount),
          positive_est: r2(u.positiveEst),
          walk_rank: rank.get(i.unitKey)!,
        };
      }),
    })),
  };
}

/** A generated, unsaved plan in the screens' shape. */
export function viewFromPayload(p: DraftPayload): ViewPlan {
  return {
    id: null,
    status: 'preview',
    hubSlug: p.hub_slug,
    cycleNo: null,
    cycleStart: p.cycle_start,
    cycleWeeks: p.cycle_weeks,
    generatorVersion: p.generator_version,
    report: p.report as unknown as StoredReport,
    params: p.params,
    createdAt: null,
    activatedAt: null,
    slots: p.slots.map((s) => ({
      week: s.week,
      globalWeek: s.global_week,
      day: s.day,
      role: s.role,
      capacity: s.capacity,
      extra: s.extra,
      notes: s.notes,
      units: s.items
        .map((i) => ({ id: null, unitKey: i.unit_key, unitKind: i.unit_kind, layer: i.layer, load: i.load, skuCount: i.sku_count, looseCount: i.loose_count, positiveEst: i.positive_est, walkRank: i.walk_rank, moved: false }))
        .sort(byWalk),
    })),
  };
}

export const byWalk = (a: ViewUnit, b: ViewUnit) => a.walkRank - b.walkRank || (a.unitKey < b.unitKey ? -1 : a.unitKey > b.unitKey ? 1 : 0);

export interface SlotTotals {
  load: number;
  skus: number; // SKUs on the locations plus their sin-estante share
  positive: number;
  locations: number;
}

export function slotTotals(units: ViewUnit[]): SlotTotals {
  let load = 0;
  let skus = 0;
  let positive = 0;
  for (const u of units) {
    load += u.load;
    skus += u.skuCount + u.looseCount;
    positive += u.positiveEst;
  }
  return { load, skus: Math.round(skus), positive: Math.round(positive), locations: units.length };
}

/** "congeladores grupo A" on odd global weeks, B on even (same rule as the generator). */
export const freezerGroup = (globalWeek: number): 'A' | 'B' => (globalWeek % 2 === 1 ? 'A' : 'B');

/** Route tags for a location, in Spanish. */
export function unitTags(u: Pick<ViewUnit, 'layer' | 'unitKind' | 'looseCount' | 'moved'>, globalWeek: number): string[] {
  const tags: string[] = [];
  switch (u.layer) {
    case 'tier0': tags.push('tier 0'); break;
    case 'freezer': tags.push(`congeladores grupo ${freezerGroup(globalWeek)}`); break;
    case 'tier_weekly': tags.push('tiers semanales'); break;
    case 'unidentified': tags.push('bloque extra: ubicaciones sin identificar'); break;
    case 'rotation': tags.push('rotación mensual'); break;
  }
  if (u.unitKind === 'cold_room') tags.push('cuarto frío');
  if (u.unitKind === 'aisle_only') tags.push('pasillo sin estante');
  const loose = Math.round(u.looseCount);
  if (loose > 0) tags.push(`incluye ~${loose} sin estante`);
  if (u.moved) tags.push('movida por coordinador');
  return tags;
}
