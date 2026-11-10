// sheet-ingest: generic Sheet → Supabase bridge endpoint (phase 0 setup 0.2 step 5, spec section 6).
//
//   GET  ?cursor=<source>          → { source, last_row, row_count_seen, last_event_ts }
//   POST { source, header, rows, firstRow, lastRow, sheetRowCount }   [?dry=1 validates only]
//        → { received, inserted, duplicates, rejected, cursor, ... }
//
// Auth: header `x-ingest-secret` must equal the INGEST_SECRET function secret.
// Deployed with verify_jwt = false (Apps Script sends no Supabase JWT); see supabase/config.toml.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { parseBatch, type HubCfg, type LoginCfg } from '../_shared/ic_conf.ts';
import { json, secretMatches } from '../_shared/auth.ts';

// Whitelist: only these sources are accepted. Each maps to a parser + target table.
const SOURCES = { ic_confirmaciones: { target: 'ic_conf_events' } } as const;
type SourceName = keyof typeof SOURCES;
const MAX_ROWS = 5000;

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
});

function isSource(s: unknown): s is SourceName {
  return typeof s === 'string' && Object.hasOwn(SOURCES, s);
}

Deno.serve(async (req) => {
  if (!(await secretMatches(req.headers.get('x-ingest-secret'), Deno.env.get('INGEST_SECRET')))) {
    return json({ error: 'unauthorized' }, 401);
  }
  const url = new URL(req.url);

  if (req.method === 'GET') {
    const source = url.searchParams.get('cursor');
    if (!isSource(source)) return json({ error: 'unknown source' }, 400);
    const { data, error } = await db.from('ic_ingest_cursors').select('*').eq('source_name', source).maybeSingle();
    if (error) return json({ error: error.message }, 500);
    return json({ source, last_row: data?.last_row ?? 1, row_count_seen: data?.row_count_seen ?? null, last_event_ts: data?.last_event_ts ?? null });
  }

  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  let body: { source?: unknown; header?: unknown; rows?: unknown; firstRow?: unknown; lastRow?: unknown; sheetRowCount?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid JSON' }, 400);
  }
  const { source, header, rows, firstRow, lastRow, sheetRowCount } = body;
  if (!isSource(source)) return json({ error: 'unknown source' }, 400);
  if (!Array.isArray(header) || !Array.isArray(rows)) return json({ error: 'header and rows must be arrays' }, 400);
  if (rows.length > MAX_ROWS) return json({ error: `max ${MAX_ROWS} rows per batch` }, 413);
  if (![firstRow, lastRow, sheetRowCount].every((n) => Number.isInteger(n) && (n as number) >= 1)) {
    return json({ error: 'firstRow, lastRow, sheetRowCount must be positive integers' }, 400);
  }
  const dry = url.searchParams.get('dry') === '1';

  const [hubsRes, loginsRes] = await Promise.all([
    db.from('ic_hub_config').select('hub_slug, login_id, display_name, turno_split, sheet_aliases'),
    db.from('ic_logins').select('hub_slug, login, assign, category_map'),
  ]);
  if (hubsRes.error || loginsRes.error) return json({ error: (hubsRes.error ?? loginsRes.error)!.message }, 500);

  const parsed = parseBatch(header, rows as unknown[][], firstRow as number, hubsRes.data as HubCfg[], loginsRes.data as LoginCfg[]);
  if ('headerError' in parsed) return json({ error: 'missing columns', missing: parsed.headerError }, 422);

  const { data, error } = await db.rpc('ic_ingest_conf', {
    p_source: source,
    p_rows: parsed.rows,
    p_first_row: firstRow,
    p_last_row: lastRow,
    p_sheet_row_count: sheetRowCount,
    p_rejected: parsed.rejected.length,
    p_dry: dry,
  });
  if (error) return json({ error: error.message }, 500);

  return json({
    ...data,
    duplicates: (data.duplicates ?? 0) + parsed.inBatchDuplicates,
    in_batch_duplicates: parsed.inBatchDuplicates,
    roles: parsed.roleCounts,
    extra_logins: parsed.extraLogins,
    unknown_hubs: parsed.unknownHubs,
    rejected_sample: parsed.rejected.slice(0, 20),
  });
});
