// ic-admin: coordinator writes, behind the admin PIN. Thin wrapper: validation and error messages
// live in ../_shared/plan_admin.ts (Vitest-tested); each write is one SQL transaction (migration 0008).
//
//   POST, header `x-admin-pin` = IC_ADMIN_PIN secret
//     { action: 'ping' }                                          → { ok: true }
//     { action: 'save_draft', plan: DraftPayload }                → { plan_id, cycle_no, slots, units, replaced_drafts }
//     { action: 'move', plan_id, slot_unit_id, day, role }        → { ok, unit_key, slot_id }   (drafts only)
//     { action: 'activate', plan_id }                             → { ok, plan_id, previous_plan }
//
// Called from the browser, so it answers CORS preflight. verify_jwt = false (anon app, PIN auth).
import { createClient } from 'npm:@supabase/supabase-js@2';
import { json, secretMatches } from '../_shared/auth.ts';
import { parseAdminRequest, rpcCall, sqlError } from '../_shared/plan_admin.ts';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type, x-admin-pin, authorization, apikey, x-client-info',
};
const ACTOR = 'coordinador (PIN)';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
});

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405, CORS);
  // Read the whole body before answering, even on a wrong PIN: answering a large upload (a saved
  // plan) before it is read leaves browsers waiting forever.
  const text = await req.text();
  if (!(await secretMatches(req.headers.get('x-admin-pin'), Deno.env.get('IC_ADMIN_PIN')))) {
    return json({ error: 'PIN incorrecto' }, 401, CORS);
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: 'invalid JSON' }, 400, CORS);
  }
  const parsed = parseAdminRequest(body);
  if (!parsed.ok) return json({ error: parsed.error }, 400, CORS);

  const call = rpcCall(parsed.value, ACTOR);
  if (!call) return json({ ok: true }, 200, CORS);
  const { data, error } = await db.rpc(call.fn, call.args);
  if (error) {
    console.error(call.fn, error.message);
    const e = sqlError(error.message);
    return json({ error: e.error }, e.status, CORS);
  }
  return json(data, 200, CORS);
});
