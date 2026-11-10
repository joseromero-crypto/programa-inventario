// ic-admin: coordinator writes (config edits, plan actions). Phase 0 stub: only verifies the PIN.
//
//   POST { action: 'ping' }   header `x-admin-pin` = IC_ADMIN_PIN secret   → { ok: true }
//
// Called from the browser, so it answers CORS preflight. verify_jwt = false (anon app, PIN auth).
import { json, secretMatches } from '../_shared/auth.ts';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type, x-admin-pin, authorization, apikey, x-client-info',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405, CORS);
  if (!(await secretMatches(req.headers.get('x-admin-pin'), Deno.env.get('IC_ADMIN_PIN')))) {
    return json({ error: 'PIN incorrecto' }, 401, CORS);
  }
  let body: { action?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid JSON' }, 400, CORS);
  }
  if (body.action === 'ping') return json({ ok: true }, 200, CORS);
  return json({ error: 'unknown action' }, 400, CORS);
});
