/**
 * Calii Sheet Bridge: generic Google Sheet → Supabase ingest (inventario-conf phase 0.3).
 * Source of truth: inventario-conf/apps-script/bridge.gs. Edit there, then paste here.
 *
 * Setup (once):
 *   Project Settings → Script Properties → add INGEST_SECRET (and INGEST_URL only to override the default).
 *
 * Functions to run from the editor:
 *   dryRun()              sends the first 100 rows to ?dry=1 and logs counts. Writes nothing.
 *   backfill()            loads everything after the stored cursor; keeps scheduling itself until done.
 *   installDailyTrigger() runs daily() every day at 23:00 America/Monterrey.
 *   daily()               the trigger target: loads new rows since the last run.
 *   resync()              re-reads the whole tab from row 2 (duplicates are skipped by src_key).
 *   status()              logs cursor, sheet size and the 10M-cell limit.
 */

const DEFAULT_INGEST_URL = 'https://uuqqtksxlgkztenojufm.supabase.co/functions/v1/sheet-ingest';

const SOURCES = [{
  name: 'ic_confirmaciones',
  sheetId: '1_Ddk3ZNrd-3AuTBlC96qrnLG0nkFaRSGLZYXviVj_jc',
  tab: 'Download',
  batch: 2000,
  // Only these columns are sent (the tab has 55). The Edge Function maps them by header name.
  columns: [
    'Hub', 'sku', 'Código de barras', 'Actualización confirmación', 'Fecha de inventario', 'Turno',
    'Registrado por', 'Nro. de unidades [MANUAL]', 'Final [AUTO]', 'Inv. disponible app', 'Delta Final',
    'Delta $', 'Tiers', 'Categoría Final', 'Kg / Pz', 'Posición inventario',
  ],
}];

const TIME_BUDGET_MS = 4.5 * 60 * 1000;   // Apps Script stops at 6 min
const CELL_LIMIT = 10000000;
const CONTINUE_HANDLER = 'backfill';

// ───────────────────────── entry points ─────────────────────────

function dryRun() {
  SOURCES.forEach(function (src) {
    const sheet = openTab_(src);
    const cols = columnPlan_(sheet, src);
    const last = Math.min(sheet.getLastRow(), 101);
    if (last < 2) return log_(src.name, 'tab is empty');
    const res = post_(src, cols, sheet, 2, last, sheet.getLastRow(), true);
    log_(src.name, 'DRY RUN rows 2–' + last + ': ' + JSON.stringify(res, null, 2));
  });
}

function backfill() {
  const done = runAll_({ resync: false });
  if (done) {
    deleteTriggers_(CONTINUE_HANDLER);
    log_('backfill', 'complete');
  } else {
    scheduleContinue_();
    log_('backfill', 'not finished yet; continues automatically in ~1 min');
  }
}

function daily() {
  if (!runAll_({ resync: false })) scheduleContinue_();
}

function resync() {
  SOURCES.forEach(function (src) { props_().setProperty(resyncKey_(src), '2'); });
  backfill();
}

function installDailyTrigger() {
  deleteTriggers_('daily');
  ScriptApp.newTrigger('daily').timeBased().everyDays(1).atHour(23).inTimezone('America/Monterrey').create();
  log_('trigger', 'daily() scheduled every day at 23:00 America/Monterrey');
}

function status() {
  SOURCES.forEach(function (src) {
    const sheet = openTab_(src);
    const rows = sheet.getLastRow();
    const cells = rows * sheet.getLastColumn();
    const cur = getCursor_(src);
    log_(src.name, JSON.stringify({
      sheet_rows: rows,
      stored_through_row: cur.last_row,
      pending_rows: Math.max(0, rows - cur.last_row),
      last_event_ts: cur.last_event_ts,
      tab_cells: cells,
      pct_of_10M_file_limit: Math.round((cells / CELL_LIMIT) * 1000) / 10,
      resync_in_progress: props_().getProperty(resyncKey_(src)),
    }, null, 2));
  });
}

// ───────────────────────── sync loop ─────────────────────────

/** Returns true when every source is fully synced within this run. */
function runAll_(opts) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) { log_('sync', 'another run is in progress; skipping'); return true; }
  const started = Date.now();
  try {
    return SOURCES.every(function (src) { return syncSource_(src, started); });
  } finally {
    lock.releaseLock();
  }
}

function syncSource_(src, started) {
  const sheet = openTab_(src);
  const cols = columnPlan_(sheet, src);
  const sheetRows = sheet.getLastRow();
  const rKey = resyncKey_(src);
  const resyncFrom = props_().getProperty(rKey);

  let start;
  if (resyncFrom) {
    start = Number(resyncFrom);
  } else {
    const cur = getCursor_(src);
    start = cur.last_row + 1;
    if (sheetRows < cur.last_row) {
      // Tab was trimmed: positions moved. Re-read from the top; src_key skips stored rows.
      log_(src.name, 'sheet has ' + sheetRows + ' rows but cursor is at ' + cur.last_row + '; re-reading from row 2');
      start = 2;
      props_().setProperty(rKey, '2');
    }
  }

  let inserted = 0, dups = 0, rejected = 0;
  while (start <= sheetRows) {
    if (Date.now() - started > TIME_BUDGET_MS) {
      log_(src.name, 'time budget used at row ' + start + ' of ' + sheetRows + ' (+' + inserted + ' new this run)');
      return false;
    }
    const end = Math.min(start + src.batch - 1, sheetRows);
    const res = post_(src, cols, sheet, start, end, sheetRows, false);
    inserted += res.inserted || 0;
    dups += res.duplicates || 0;
    rejected += res.rejected || 0;
    if (res.unknown_hubs && Object.keys(res.unknown_hubs).length) log_(src.name, 'unknown hubs: ' + JSON.stringify(res.unknown_hubs));
    start = end + 1;
    if (props_().getProperty(rKey)) props_().setProperty(rKey, String(start));
  }
  props_().deleteProperty(rKey);
  log_(src.name, 'up to date through row ' + sheetRows + ': +' + inserted + ' new, ' + dups + ' already stored, ' + rejected + ' rejected');
  return true;
}

// ───────────────────────── sheet + http helpers ─────────────────────────

function openTab_(src) {
  const sheet = SpreadsheetApp.openById(src.sheetId).getSheetByName(src.tab);
  if (!sheet) throw new Error('Tab "' + src.tab + '" not found in ' + src.sheetId);
  return sheet;
}

/** Header positions of the configured columns (missing ones are left out; the function reports them). */
function columnPlan_(sheet, src) {
  const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(function (h) { return String(h).trim(); });
  const idx = [], names = [], missing = [];
  src.columns.forEach(function (c) {
    const i = header.indexOf(c);
    if (i === -1) missing.push(c); else { idx.push(i); names.push(c); }
  });
  if (missing.length) log_(src.name, 'columns not found in the tab header: ' + missing.join(', '));
  return { idx: idx, names: names, width: header.length };
}

function readRows_(sheet, cols, first, last) {
  const values = sheet.getRange(first, 1, last - first + 1, cols.width).getValues();
  return values.map(function (row) { return cols.idx.map(function (i) { return row[i]; }); });
}

function post_(src, cols, sheet, first, last, sheetRows, dry) {
  const payload = JSON.stringify({
    source: src.name,
    header: cols.names,
    rows: readRows_(sheet, cols, first, last),   // Date cells serialize as ISO UTC strings
    firstRow: first,
    lastRow: last,
    sheetRowCount: sheetRows,
  });
  return fetchJson_(url_() + (dry ? '?dry=1' : ''), { method: 'post', contentType: 'application/json', payload: payload });
}

function getCursor_(src) {
  return fetchJson_(url_() + '?cursor=' + encodeURIComponent(src.name), { method: 'get' });
}

function fetchJson_(url, options) {
  options.headers = { 'x-ingest-secret': secret_() };
  options.muteHttpExceptions = true;
  for (let attempt = 1; ; attempt++) {
    let resp;
    try {
      resp = UrlFetchApp.fetch(url, options);
    } catch (e) {
      if (attempt < 3) { Utilities.sleep(2000 * attempt); continue; }
      throw e;
    }
    const code = resp.getResponseCode();
    const body = resp.getContentText();
    if (code >= 500 && attempt < 3) { Utilities.sleep(2000 * attempt); continue; }
    if (code !== 200) throw new Error('HTTP ' + code + ' from sheet-ingest: ' + body.slice(0, 500));
    return JSON.parse(body);
  }
}

// ───────────────────────── small utilities ─────────────────────────

function props_() { return PropertiesService.getScriptProperties(); }
function url_() { return props_().getProperty('INGEST_URL') || DEFAULT_INGEST_URL; }
function resyncKey_(src) { return 'RESYNC_FROM_' + src.name; }

function secret_() {
  const s = props_().getProperty('INGEST_SECRET');
  if (!s) throw new Error('Missing Script Property INGEST_SECRET (Project Settings → Script Properties).');
  return s;
}

function scheduleContinue_() {
  deleteTriggers_(CONTINUE_HANDLER);
  ScriptApp.newTrigger(CONTINUE_HANDLER).timeBased().after(60 * 1000).create();
}

function deleteTriggers_(handler) {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === handler) ScriptApp.deleteTrigger(t);
  });
}

function log_(scope, msg) { console.log('[' + scope + '] ' + msg); }
