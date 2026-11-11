import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;
if (!url || !key) throw new Error('Faltan VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY');

// Anon client: reads ic_ config/plan tables and calls the read RPCs. No sessions (no login in this app).
export const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
