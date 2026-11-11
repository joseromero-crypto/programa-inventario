// Reads saved plans (anon may SELECT ic_plans / ic_slots / ic_slot_units) and writes through ic-admin.
import type { RoleKey } from '../../generator/types';
import type { AdminAction, DraftPayload } from '../../../supabase/functions/_shared/plan_admin';
import { supabase } from '../supabase';
import { byWalk, type StoredReport, type ViewPlan, type ViewSlot } from './model';

const PAGE = 1000;

interface PlanRow {
  id: number; hub_slug: string; cycle_no: number; cycle_start: string; cycle_weeks: number; status: 'draft' | 'active' | 'closed';
  generator_version: string; report: StoredReport; params: Record<string, unknown>; created_at: string; activated_at: string | null;
}
interface SlotRow { id: number; week: number; global_week: number; day: string; capacity: number; extra: boolean; notes: string[]; ic_roles: { role_key: RoleKey } }
interface UnitRow { id: number; slot_id: number; unit_key: string; unit_kind: ViewSlot['units'][number]['unitKind']; layer: ViewSlot['units'][number]['layer']; load: number; sku_count: number; loose_count: number; positive_est: number; walk_rank: number; origin: string }

async function all<T>(q: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await q(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = data as T[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

const PLAN_COLS = 'id, hub_slug, cycle_no, cycle_start, cycle_weeks, status, generator_version, report, params, created_at, activated_at';

/** The hub's draft and active plan headers (no slots). */
export async function fetchPlanHeads(hubSlug: string): Promise<{ draft: PlanRow | null; active: PlanRow | null }> {
  const { data, error } = await supabase.from('ic_plans').select(PLAN_COLS).eq('hub_slug', hubSlug).in('status', ['draft', 'active']).order('id', { ascending: false });
  if (error) throw new Error(error.message);
  const rows = data as PlanRow[];
  return { draft: rows.find((p) => p.status === 'draft') ?? null, active: rows.find((p) => p.status === 'active') ?? null };
}

export async function fetchActivePlanHead(hubSlug: string): Promise<PlanRow | null> {
  return (await fetchPlanHeads(hubSlug)).active;
}

/** A saved plan with its slots and locations. `days` limits the slots read (Ruta del día). */
export async function fetchPlan(head: PlanRow, days?: string[]): Promise<ViewPlan> {
  const slots = await all<SlotRow>((a, b) => {
    let q = supabase.from('ic_slots').select('id, week, global_week, day, capacity, extra, notes, ic_roles!inner(role_key)').eq('plan_id', head.id);
    if (days) q = q.in('day', days);
    return q.order('id').range(a, b);
  });
  const ids = slots.map((s) => s.id);
  const units = ids.length === 0 ? [] : await all<UnitRow>((a, b) => {
    let q = supabase.from('ic_slot_units').select('id, slot_id, unit_key, unit_kind, layer, load, sku_count, loose_count, positive_est, walk_rank, origin').eq('plan_id', head.id);
    if (days) q = q.in('slot_id', ids);
    return q.order('id').range(a, b);
  });
  const bySlot = new Map<number, UnitRow[]>();
  for (const u of units) (bySlot.get(u.slot_id) ?? bySlot.set(u.slot_id, []).get(u.slot_id)!).push(u);

  return {
    id: head.id,
    status: head.status,
    hubSlug: head.hub_slug,
    cycleNo: head.cycle_no,
    cycleStart: head.cycle_start,
    cycleWeeks: head.cycle_weeks,
    generatorVersion: head.generator_version,
    report: head.report,
    params: head.params,
    createdAt: head.created_at,
    activatedAt: head.activated_at,
    slots: slots
      .map((s): ViewSlot => ({
        week: s.week,
        globalWeek: s.global_week,
        day: s.day,
        role: s.ic_roles.role_key,
        capacity: Number(s.capacity),
        extra: s.extra,
        notes: s.notes ?? [],
        units: (bySlot.get(s.id) ?? [])
          .map((u) => ({
            id: u.id, unitKey: u.unit_key, unitKind: u.unit_kind, layer: u.layer, load: Number(u.load), skuCount: u.sku_count,
            looseCount: Number(u.loose_count), positiveEst: Number(u.positive_est), walkRank: u.walk_rank, moved: u.origin === 'coordinator',
          }))
          .sort(byWalk),
      }))
      .sort((x, y) => (x.day < y.day ? -1 : x.day > y.day ? 1 : 0) || Number(x.extra) - Number(y.extra)),
  };
}

// ───────────── writes (ic-admin, PIN per action, never stored) ─────────────

export class AdminError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function admin<T>(pin: string, body: AdminAction): Promise<T> {
  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ic-admin`;
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-pin': pin }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  } catch {
    throw new AdminError('Sin respuesta del servidor. Intenta de nuevo.', 0);
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new AdminError(data.error ?? `Error ${res.status}`, res.status);
  return data as T;
}

export const saveDraft = (pin: string, plan: DraftPayload) => admin<{ plan_id: number; cycle_no: number; slots: number; units: number; replaced_drafts: number }>(pin, { action: 'save_draft', plan });
export const moveUnit = (pin: string, plan_id: number, slot_unit_id: number, day: string, role: RoleKey) => admin<{ ok: true; unit_key: string }>(pin, { action: 'move', plan_id, slot_unit_id, day, role });
export const activatePlan = (pin: string, plan_id: number) => admin<{ ok: true; previous_plan: number | null }>(pin, { action: 'activate', plan_id });
