import { describe, expect, it } from 'vitest';
import {
  attribute, buildHubResolver, localDate, num, parseBatch, parseDate, parseTs,
  type HubCfg, type LoginCfg,
} from '../supabase/functions/_shared/ic_conf';

const HUBS: HubCfg[] = [
  ['mh-contry', 'con', 'Contry'], ['mh-condesa', 'csa', 'Condesa'], ['mh-zapopan', 'zap', 'Zapopan'],
  ['mh-cumbres', 'cu', 'Cumbres'], ['mh-san-nicolas', 'sn', 'San Nicolás'],
  ['mh-guadalupe', 'gpe', 'Guadalupe'], ['mh-avicola', 'avi', 'Avícola'],
].map(([hub_slug, login_id, display_name]) => ({ hub_slug: hub_slug!, login_id: login_id!, display_name: display_name!, turno_split: '14:00:00', sheet_aliases: [] }));

// mirrors 0002_ic_seed.sql for the hubs used below
const LOGINS: LoginCfg[] = [
  { hub_slug: 'mh-contry', login: 'aux.inventario.con', assign: 'aux_inv', category_map: null },
  { hub_slug: 'mh-contry', login: 'aux.turno.con', assign: 'by_turno', category_map: null },
  { hub_slug: 'mh-contry', login: 'aux.calidad.con', assign: 'by_category', category_map: { '3. Graneles y abarrotes': 'aux_rec', '*': 'aux_cal' } },
  { hub_slug: 'mh-condesa', login: 'aux.recepcion.csa', assign: 'aux_rec', category_map: null },
  { hub_slug: 'mh-condesa', login: 'aux.calidad.csa', assign: 'aux_cal', category_map: null },
];
const contry = LOGINS.filter((l) => l.hub_slug === 'mh-contry');

describe('time', () => {
  it('derives the Monterrey local date, not the UTC one', () => {
    // 2026-10-14 03:30 UTC = 2026-10-13 21:30 in Monterrey
    expect(localDate(new Date('2026-10-14T03:30:00Z'))).toBe('2026-10-13');
  });
  it('treats timestamps without offset as Monterrey time', () => {
    expect(parseTs('2026-10-13 21:30:00')!.toISOString()).toBe('2026-10-14T03:30:00.000Z');
    expect(parseTs('2026-10-13T21:30:00-06:00')!.toISOString()).toBe('2026-10-14T03:30:00.000Z');
    expect(parseTs('nope')).toBeNull();
  });
  it('parses date-only values', () => {
    expect(parseDate('13/10/2026')).toBe('2026-10-13');
    expect(parseDate('2026-10-13')).toBe('2026-10-13');
    expect(parseDate('2026-10-14T03:30:00.000Z')).toBe('2026-10-13');
  });
});

describe('num', () => {
  it('handles numbers, currency text and blanks', () => {
    expect(num(12)).toBe(12);
    expect(num('$ -1,234.50')).toBe(-1234.5);
    expect(num('')).toBeNull();
    expect(num('n/a')).toBeNull();
  });
});

describe('hub resolver', () => {
  const r = buildHubResolver(HUBS);
  it('accepts slug, display name, MH prefix and accents', () => {
    expect(r('mh-contry')).toBe('mh-contry');
    expect(r('MH Contry')).toBe('mh-contry');
    expect(r('San Nicolas')).toBe('mh-san-nicolas');
    expect(r('MH San Nicolás')).toBe('mh-san-nicolas');
    expect(r('ch-guadalupe')).toBeNull();
  });
});

describe('attribution', () => {
  const ts = new Date('2026-10-13T16:00:00Z'); // 10:00 Monterrey
  it('maps fixed logins, matching on the local part of an e-mail', () => {
    expect(attribute('aux.inventario.con@calii.com', null, null, ts, contry, '14:00')).toBe('aux_inv');
    expect(attribute('aux.inventario.con', null, null, ts, contry, '14:00')).toBe('aux_inv');
  });
  it('splits aux.turno by the Turno column, falling back to the hour', () => {
    expect(attribute('aux.turno.con', 'Día', null, ts, contry, '14:00')).toBe('lider_am');
    expect(attribute('aux.turno.con', 'Tarde', null, ts, contry, '14:00')).toBe('lider_pm');
    expect(attribute('aux.turno.con', null, null, ts, contry, '14:00')).toBe('lider_am');
    expect(attribute('aux.turno.con', null, null, new Date('2026-10-13T21:00:00Z'), contry, '14:00')).toBe('lider_pm');
  });
  it('applies the Contry calidad rule by category', () => {
    expect(attribute('aux.calidad.con', null, '3. Graneles y abarrotes', ts, contry, '14:00')).toBe('aux_rec');
    expect(attribute('aux.calidad.con', null, '1. FyV', ts, contry, '14:00')).toBe('aux_cal');
  });
  it('sends unknown or personal logins to extra', () => {
    expect(attribute('coordinador@gmail.com', null, null, ts, contry, '14:00')).toBe('extra');
    expect(attribute(null, null, null, ts, contry, '14:00')).toBe('extra');
    // a login from another hub does not count at this hub
    expect(attribute('aux.recepcion.csa', null, null, ts, contry, '14:00')).toBe('extra');
  });
});

describe('parseBatch', () => {
  const header = ['Hub', 'sku', 'Código de barras', 'Actualización confirmación', 'Turno', 'Registrado por', 'Inv. disponible app', 'Categoría Final', 'Otra columna'];
  it('rejects a header missing required columns', () => {
    expect(parseBatch(['Hub', 'sku'], [], 2, HUBS, LOGINS)).toEqual({ headerError: ['Actualización confirmación', 'Registrado por'] });
  });
  it('maps rows, builds src_key, dedupes, rejects and reports', () => {
    const rows = [
      ['MH Contry', 'SKU1', '750100', '2026-10-13T21:30:00-06:00', 'Tarde', 'aux.turno.con@calii.com', '5', '3. Graneles y abarrotes', 'x'],
      ['MH Contry', 'SKU1', '750100', '2026-10-14T03:30:00.000Z', 'Tarde', 'aux.turno.con@calii.com', '5', '3. Graneles y abarrotes', 'x'], // same instant
      ['MH Condesa', 'SKU2', '', '2026-10-13 09:00', 'Día', 'jefe@gmail.com', '', '2. Carnes', ''],
      ['CH Guadalupe', 'SKU3', '', '2026-10-13 09:00', 'Día', 'aux.inventario.gpe', '', '', ''],
      ['MH Contry', '', '', '2026-10-13 09:00', '', 'aux.inventario.con', '', '', ''],
      ['MH Contry', 'SKU4', '', 'ayer', '', 'aux.inventario.con', '', '', ''],
      ['', '', '', '', '', '', '', '', ''],
    ];
    const res = parseBatch(header, rows, 2, HUBS, LOGINS);
    if ('headerError' in res) throw new Error('unexpected');
    expect(res.rows).toHaveLength(2);
    expect(res.inBatchDuplicates).toBe(1);
    expect(res.rows[0]).toMatchObject({
      hub_slug: 'mh-contry', sku: 'SKU1', barcode: '750100', role_key: 'lider_pm',
      local_date: '2026-10-13', event_ts: '2026-10-14T03:30:00.000Z', qty_app: 5,
      src_key: 'mh-contry|SKU1|2026-10-14T03:30:00.000Z', login: 'aux.turno.con@calii.com',
    });
    expect(res.rows[1]).toMatchObject({ hub_slug: 'mh-condesa', role_key: 'extra', barcode: null, qty_app: null });
    expect(res.rejected.map((r) => [r.row, r.reason])).toEqual([[5, 'unknown_hub'], [6, 'missing_sku'], [7, 'bad_timestamp']]);
    expect(res.unknownHubs).toEqual({ 'CH Guadalupe': 1 });
    expect(res.extraLogins).toEqual({ 'mh-condesa jefe@gmail.com': 1 });
    expect(res.roleCounts).toEqual({ lider_pm: 1, extra: 1 });
  });
});
