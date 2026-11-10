// Pure parsing + attribution for confirmation rows from the "Download" tab (spec section 6).
// No I/O and no Deno/Node APIs: imported by the sheet-ingest Edge Function and by Vitest.

export const TZ = 'America/Monterrey';
// Mexico has had no DST since 2022; Monterrey is fixed UTC-6. Used only for timestamps with no offset.
const MONTERREY_OFFSET = '-06:00';

export type RoleKey = 'aux_inv' | 'lider_am' | 'lider_pm' | 'aux_rec' | 'aux_cal' | 'extra';
export type Assign = Exclude<RoleKey, 'extra'> | 'by_turno' | 'by_category';

export interface HubCfg {
  hub_slug: string;
  login_id: string;
  display_name: string;
  turno_split: string; // 'HH:MM' or 'HH:MM:SS'
  sheet_aliases: string[];
}

export interface LoginCfg {
  hub_slug: string;
  login: string;
  assign: Assign;
  category_map: Record<string, string> | null;
}

export interface ConfRow {
  hub_slug: string;
  sku: string;
  barcode: string | null;
  login: string | null;
  role_key: RoleKey;
  turno: string | null;
  local_date: string; // YYYY-MM-DD
  event_ts: string; // UTC ISO
  fecha_inventario: string | null;
  qty_manual: number | null;
  qty_auto: number | null;
  qty_app: number | null;
  delta: number | null;
  delta_money: number | null;
  categoria: string | null;
  tiers: string | null;
  kg_pz: string | null;
  posicion: string | null;
  src_key: string;
}

export type RejectReason = 'missing_hub' | 'unknown_hub' | 'missing_sku' | 'bad_timestamp' | 'row_shape';

export interface ParseResult {
  rows: ConfRow[];
  rejected: { row: number; reason: RejectReason; value?: string }[];
  inBatchDuplicates: number;
  unknownHubs: Record<string, number>;
  extraLogins: Record<string, number>; // `${hub_slug} ${login}` → count
  roleCounts: Record<string, number>;
}

// Sheet header → field. Matched after normalize() so case, accents and spacing don't matter.
export const COLUMNS = {
  hub: 'Hub',
  sku: 'sku',
  barcode: 'Código de barras',
  event_ts: 'Actualización confirmación',
  fecha_inventario: 'Fecha de inventario',
  turno: 'Turno',
  login: 'Registrado por',
  qty_manual: 'Nro. de unidades [MANUAL]',
  qty_auto: 'Final [AUTO]',
  qty_app: 'Inv. disponible app',
  delta: 'Delta Final',
  delta_money: 'Delta $',
  tiers: 'Tiers',
  categoria: 'Categoría Final',
  kg_pz: 'Kg / Pz',
  posicion: 'Posición inventario',
} as const;
type Field = keyof typeof COLUMNS;
const REQUIRED: Field[] = ['hub', 'sku', 'event_ts', 'login'];

/** lowercase, strip accents, collapse whitespace */
export function normalize(s: string): string {
  return s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function slugify(s: string): string {
  return normalize(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function mapHeader(header: unknown[]): { index: Record<Field, number>; missing: string[] } {
  const pos = new Map<string, number>();
  header.forEach((h, i) => {
    const k = normalize(String(h ?? ''));
    if (k && !pos.has(k)) pos.set(k, i);
  });
  const index = {} as Record<Field, number>;
  const missing: string[] = [];
  for (const f of Object.keys(COLUMNS) as Field[]) {
    const i = pos.get(normalize(COLUMNS[f]));
    index[f] = i ?? -1;
    if (i === undefined && REQUIRED.includes(f)) missing.push(COLUMNS[f]);
  }
  return { index, missing };
}

export function buildHubResolver(hubs: HubCfg[]): (raw: string) => string | null {
  const map = new Map<string, string>();
  for (const h of hubs) {
    const keys = [h.hub_slug, h.hub_slug.replace(/^mh-/, ''), h.display_name, 'mh ' + h.display_name, ...h.sheet_aliases];
    for (const k of keys) map.set(slugify(k), h.hub_slug);
  }
  return (raw) => {
    const s = slugify(raw);
    return map.get(s) ?? map.get(s.replace(/^mh-/, '')) ?? null;
  };
}

export function text(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/** Numbers from Sheets arrive as numbers or as text like "$ 1,234.50" / "-12". */
export function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = text(v);
  if (s === null) return null;
  const n = Number(s.replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** Timestamp → Date. ISO with offset is used as is; a bare local "YYYY-MM-DD HH:MM[:SS]" is Monterrey time. */
export function parseTs(v: unknown): Date | null {
  const s = text(v);
  if (s === null) return null;
  const bare = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/.exec(s);
  const d = new Date(bare ? `${bare[1]}T${bare[2]}${MONTERREY_OFFSET}` : s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Date-only value → 'YYYY-MM-DD'. Accepts ISO dates/timestamps and dd/mm/yyyy. */
export function parseDate(v: unknown): string | null {
  const s = text(v);
  if (s === null) return null;
  const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (dmy) return `${dmy[3]}-${dmy[2]!.padStart(2, '0')}-${dmy[1]!.padStart(2, '0')}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = parseTs(s);
  return d ? localDate(d) : null;
}

const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

export function localDate(d: Date): string {
  return dateFmt.format(d);
}

export function localHHMM(d: Date): string {
  return timeFmt.format(d);
}

export function attribute(
  login: string | null,
  turno: string | null,
  categoria: string | null,
  eventTs: Date,
  hubLogins: LoginCfg[],
  turnoSplit: string,
): RoleKey {
  if (!login) return 'extra';
  const full = login.trim().toLowerCase();
  const local = full.split('@')[0]!;
  const cfg = hubLogins.find((l) => l.login === full) ?? hubLogins.find((l) => l.login === local);
  if (!cfg) return 'extra';
  switch (cfg.assign) {
    case 'by_turno': {
      const t = turno ? normalize(turno) : '';
      if (t === 'dia') return 'lider_am';
      if (t === 'tarde') return 'lider_pm';
      return localHHMM(eventTs) < turnoSplit.slice(0, 5) ? 'lider_am' : 'lider_pm';
    }
    case 'by_category': {
      const map = cfg.category_map ?? {};
      const c = categoria ? normalize(categoria) : '';
      const hit = Object.entries(map).find(([k]) => k !== '*' && normalize(k) === c);
      const role = (hit?.[1] ?? map['*'] ?? 'extra') as RoleKey;
      return role;
    }
    default:
      return cfg.assign;
  }
}

/**
 * header: the sheet's header row. rows: data rows (arrays, same order as header).
 * firstRow: sheet row number of rows[0], used only for reject reporting.
 */
export function parseBatch(
  header: unknown[],
  rows: unknown[][],
  firstRow: number,
  hubs: HubCfg[],
  logins: LoginCfg[],
): ParseResult | { headerError: string[] } {
  const { index, missing } = mapHeader(header);
  if (missing.length) return { headerError: missing };

  const resolveHub = buildHubResolver(hubs);
  const hubBySlug = new Map(hubs.map((h) => [h.hub_slug, h]));
  const loginsByHub = new Map<string, LoginCfg[]>();
  for (const l of logins) loginsByHub.set(l.hub_slug, [...(loginsByHub.get(l.hub_slug) ?? []), l]);

  const out: ParseResult = { rows: [], rejected: [], inBatchDuplicates: 0, unknownHubs: {}, extraLogins: {}, roleCounts: {} };
  const seen = new Set<string>();
  const get = (r: unknown[], f: Field) => (index[f] >= 0 ? r[index[f]] : undefined);

  rows.forEach((r, i) => {
    const rowNo = firstRow + i;
    if (!Array.isArray(r)) return void out.rejected.push({ row: rowNo, reason: 'row_shape' });
    if (r.every((c) => text(c) === null)) return; // blank row: skip silently

    const hubRaw = text(get(r, 'hub'));
    if (!hubRaw) return void out.rejected.push({ row: rowNo, reason: 'missing_hub' });
    const hub_slug = resolveHub(hubRaw);
    if (!hub_slug) {
      out.unknownHubs[hubRaw] = (out.unknownHubs[hubRaw] ?? 0) + 1;
      return void out.rejected.push({ row: rowNo, reason: 'unknown_hub', value: hubRaw });
    }
    const sku = text(get(r, 'sku'));
    if (!sku) return void out.rejected.push({ row: rowNo, reason: 'missing_sku' });
    const ts = parseTs(get(r, 'event_ts'));
    if (!ts) return void out.rejected.push({ row: rowNo, reason: 'bad_timestamp', value: text(get(r, 'event_ts')) ?? '' });

    const event_ts = ts.toISOString();
    const src_key = `${hub_slug}|${sku}|${event_ts}`;
    if (seen.has(src_key)) return void out.inBatchDuplicates++;
    seen.add(src_key);

    const login = text(get(r, 'login'))?.toLowerCase() ?? null;
    const turno = text(get(r, 'turno'));
    const categoria = text(get(r, 'categoria'));
    const role_key = attribute(login, turno, categoria, ts, loginsByHub.get(hub_slug) ?? [], hubBySlug.get(hub_slug)!.turno_split);

    out.roleCounts[role_key] = (out.roleCounts[role_key] ?? 0) + 1;
    if (role_key === 'extra') {
      const k = `${hub_slug} ${login ?? '(vacío)'}`;
      out.extraLogins[k] = (out.extraLogins[k] ?? 0) + 1;
    }

    out.rows.push({
      hub_slug,
      sku,
      barcode: text(get(r, 'barcode')),
      login,
      role_key,
      turno,
      local_date: localDate(ts),
      event_ts,
      fecha_inventario: parseDate(get(r, 'fecha_inventario')),
      qty_manual: num(get(r, 'qty_manual')),
      qty_auto: num(get(r, 'qty_auto')),
      qty_app: num(get(r, 'qty_app')),
      delta: num(get(r, 'delta')),
      delta_money: num(get(r, 'delta_money')),
      categoria,
      tiers: text(get(r, 'tiers')),
      kg_pz: text(get(r, 'kg_pz')),
      posicion: text(get(r, 'posicion')),
      src_key,
    });
  });
  return out;
}
