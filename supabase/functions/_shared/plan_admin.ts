// ic-admin plan actions: request validation and error messages. Pure (no I/O), Vitest-tested.
// The writes themselves run in one transaction each, in SQL (0008_ic_plan_actions.sql):
//   save_draft → ic_plan_save_draft, move → ic_plan_move, activate → ic_plan_activate.

export const ROLE_KEYS = ['aux_inv', 'lider_am', 'lider_pm', 'aux_rec', 'aux_cal'] as const;
export const LAYERS = ['tier0', 'freezer', 'rotation', 'tier_weekly', 'unidentified'] as const;
export const UNIT_KINDS = ['shelf', 'aisle_only', 'freezer', 'cold_room', 'unidentified'] as const;
export const MAX_SLOTS = 600;
export const MAX_ITEMS = 6000;
/** The report jsonb carries the load report and the exception list; keep it bounded. */
export const MAX_REPORT_BYTES = 1_500_000;

export type RoleKeyStr = (typeof ROLE_KEYS)[number];

export interface DraftItem {
  unit_key: string;
  unit_kind: (typeof UNIT_KINDS)[number];
  layer: (typeof LAYERS)[number];
  load: number;
  sku_count: number;
  loose_count: number;
  positive_est: number;
  walk_rank: number;
}

export interface DraftSlot {
  week: number;
  global_week: number;
  day: string;
  role: RoleKeyStr;
  capacity: number;
  extra: boolean;
  notes: string[];
  items: DraftItem[];
}

export interface DraftPayload {
  hub_slug: string;
  cycle_start: string;
  cycle_weeks: number;
  rotation_mode: 'physical' | 'tier_order';
  generator_version: string;
  params: Record<string, unknown>;
  report: Record<string, unknown>;
  slots: DraftSlot[];
}

export type AdminAction =
  | { action: 'ping' }
  | { action: 'save_draft'; plan: DraftPayload }
  | { action: 'move'; plan_id: number; slot_unit_id: number; day: string; role: RoleKeyStr }
  | { action: 'activate'; plan_id: number };

export type Parsed = { ok: true; value: AdminAction } | { ok: false; error: string };

class Invalid extends Error {}
const fail = (msg: string): never => {
  throw new Invalid(msg);
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function date(v: unknown, field: string): string {
  if (typeof v !== 'string' || !DATE_RE.test(v) || Number.isNaN(Date.parse(`${v}T12:00:00Z`))) fail(`${field}: fecha inválida`);
  return v as string;
}
function int(v: unknown, field: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) fail(`${field}: número entero inválido`);
  return v as number;
}
function num(v: unknown, field: string, max = 999_999.99): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > max) fail(`${field}: número inválido`);
  return Math.round((v as number) * 100) / 100; // numeric(8,2)
}
function str(v: unknown, field: string, maxLen = 200): string {
  if (typeof v !== 'string' || v.trim() === '' || v.length > maxLen) fail(`${field}: texto inválido`);
  return v as string;
}
function oneOf<T extends readonly string[]>(v: unknown, list: T, field: string): T[number] {
  if (typeof v !== 'string' || !(list as readonly string[]).includes(v)) fail(`${field}: valor no permitido`);
  return v as T[number];
}
const isMonday = (ymd: string) => new Date(`${ymd}T12:00:00Z`).getUTCDay() === 1;

function parseDraft(p: unknown): DraftPayload {
  if (!isObj(p)) fail('plan: falta el plan');
  const o = p as Record<string, unknown>;
  const cycle_start = date(o.cycle_start, 'cycle_start');
  if (!isMonday(cycle_start)) fail('cycle_start: debe ser lunes');
  const cycle_weeks = int(o.cycle_weeks, 'cycle_weeks', 1, 8);
  const cycleEnd = new Date(Date.parse(`${cycle_start}T12:00:00Z`) + cycle_weeks * 7 * 86_400_000).toISOString().slice(0, 10);
  if (!Array.isArray(o.slots) || o.slots.length === 0) fail('slots: el plan no tiene días');
  const rawSlots = o.slots as unknown[];
  if (rawSlots.length > MAX_SLOTS) fail('slots: demasiados');
  if (!isObj(o.report) || !isObj(o.params ?? {})) fail('report: inválido');
  if (JSON.stringify(o.report).length > MAX_REPORT_BYTES) fail('report: demasiado grande');

  let items = 0;
  const seen = new Set<string>();
  const slots = rawSlots.map((s, i): DraftSlot => {
    if (!isObj(s)) fail(`slots[${i}]: inválido`);
    const x = s as Record<string, unknown>;
    const day = date(x.day, `slots[${i}].day`);
    if (day < cycle_start || day >= cycleEnd) fail(`slots[${i}].day: fuera del ciclo`);
    const role = oneOf(x.role, ROLE_KEYS, `slots[${i}].role`);
    const extra = x.extra === true;
    const key = `${day}|${role}|${extra}`;
    if (seen.has(key)) fail(`slots[${i}]: día y rol repetidos`);
    seen.add(key);
    if (!Array.isArray(x.items)) fail(`slots[${i}].items: inválido`);
    if (!Array.isArray(x.notes ?? []) || !((x.notes ?? []) as unknown[]).every((n) => typeof n === 'string' && n.length <= 500)) fail(`slots[${i}].notes: inválido`);
    items += (x.items as unknown[]).length;
    if (items > MAX_ITEMS) fail('items: demasiados');
    return {
      week: int(x.week, `slots[${i}].week`, 1, cycle_weeks),
      global_week: int(x.global_week, `slots[${i}].global_week`, 1),
      day,
      role,
      capacity: num(x.capacity, `slots[${i}].capacity`),
      extra,
      notes: (x.notes ?? []) as string[],
      items: (x.items as unknown[]).map((it, j): DraftItem => {
        const f = `slots[${i}].items[${j}]`;
        if (!isObj(it)) fail(`${f}: inválido`);
        const y = it as Record<string, unknown>;
        return {
          unit_key: str(y.unit_key, `${f}.unit_key`),
          unit_kind: oneOf(y.unit_kind, UNIT_KINDS, `${f}.unit_kind`),
          layer: oneOf(y.layer, LAYERS, `${f}.layer`),
          load: num(y.load, `${f}.load`),
          sku_count: int(y.sku_count, `${f}.sku_count`, 0),
          loose_count: num(y.loose_count, `${f}.loose_count`),
          positive_est: num(y.positive_est, `${f}.positive_est`),
          walk_rank: int(y.walk_rank, `${f}.walk_rank`, 0),
        };
      }),
    };
  });

  return {
    hub_slug: str(o.hub_slug, 'hub_slug', 60),
    cycle_start,
    cycle_weeks,
    rotation_mode: oneOf(o.rotation_mode, ['physical', 'tier_order'] as const, 'rotation_mode'),
    generator_version: str(o.generator_version, 'generator_version', 40),
    params: (o.params ?? {}) as Record<string, unknown>,
    report: o.report as Record<string, unknown>,
    slots,
  };
}

/** Validates an ic-admin request body. Never throws. */
export function parseAdminRequest(body: unknown): Parsed {
  try {
    if (!isObj(body)) fail('cuerpo inválido');
    const b = body as Record<string, unknown>;
    switch (b.action) {
      case 'ping':
        return { ok: true, value: { action: 'ping' } };
      case 'save_draft':
        return { ok: true, value: { action: 'save_draft', plan: parseDraft(b.plan) } };
      case 'move':
        return {
          ok: true,
          value: {
            action: 'move',
            plan_id: int(b.plan_id, 'plan_id', 1),
            slot_unit_id: int(b.slot_unit_id, 'slot_unit_id', 1),
            day: date(b.day, 'day'),
            role: oneOf(b.role, ROLE_KEYS, 'role'),
          },
        };
      case 'activate':
        return { ok: true, value: { action: 'activate', plan_id: int(b.plan_id, 'plan_id', 1) } };
      default:
        return { ok: false, error: 'acción desconocida' };
    }
  } catch (e) {
    if (e instanceof Invalid) return { ok: false, error: e.message };
    throw e;
  }
}

/** SQL function and arguments for an action (ping has none). */
export function rpcCall(a: AdminAction, actor: string): { fn: string; args: Record<string, unknown> } | null {
  switch (a.action) {
    case 'ping':
      return null;
    case 'save_draft':
      return { fn: 'ic_plan_save_draft', args: { p: a.plan, p_actor: actor } };
    case 'move':
      return { fn: 'ic_plan_move', args: { p_plan_id: a.plan_id, p_slot_unit_id: a.slot_unit_id, p_day: a.day, p_role: a.role, p_actor: actor } };
    case 'activate':
      return { fn: 'ic_plan_activate', args: { p_plan_id: a.plan_id, p_actor: actor } };
  }
}

const SQL_ERRORS: Record<string, [number, string]> = {
  IC_HUB_UNKNOWN: [400, 'Hub desconocido.'],
  IC_ROLE_UNKNOWN: [400, 'El plan usa un rol que el hub no tiene.'],
  IC_PLAN_NOT_FOUND: [404, 'El plan ya no existe. Recarga la página.'],
  IC_NOT_DRAFT: [409, 'Solo se puede cambiar un borrador. Este plan ya está activo o cerrado.'],
  IC_UNIT_NOT_FOUND: [404, 'Esa ubicación ya no está en el plan. Recarga la página.'],
  IC_PAST_DAY: [409, 'Los días que ya pasaron no se cambian.'],
  IC_NO_SLOT: [409, 'Ese rol no trabaja ese día en el plan.'],
  IC_SAME_SLOT: [400, 'La ubicación ya está en ese día y rol.'],
  IC_EMPTY_PLAN: [409, 'El borrador está vacío.'],
};

/** Maps a Postgres error message from the plan functions to an HTTP status and a Spanish message. */
export function sqlError(message: string): { status: number; error: string } {
  const code = /IC_[A-Z_]+/.exec(message)?.[0];
  if (code && SQL_ERRORS[code]) return { status: SQL_ERRORS[code][0], error: SQL_ERRORS[code][1] };
  if (/ic_plans_one_active/.test(message)) return { status: 409, error: 'El hub ya tiene un plan activo.' };
  return { status: 500, error: 'No se pudo guardar. Intenta de nuevo.' };
}
