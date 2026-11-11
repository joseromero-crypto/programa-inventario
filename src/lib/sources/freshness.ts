// Admin › Fuentes data from ic_source_freshness(). Also syncs the server clock.
import { supabase } from '../supabase';
import { setServerNow } from '../time';

export interface HubFreshness {
  hub_slug: string;
  display_name: string;
  in_plan: boolean;
  last_event_ts: string | null;
  total: number;
  daily: { d: string; n: number }[]; // 14 Monterrey days, oldest first
}

export interface Freshness {
  now: string;
  today_local: string;
  mv: { last_import: string | null; products: number };
  cursors: { source_name: string; last_row: number; row_count_seen: number | null; last_event_ts: string | null; updated_at: string }[];
  last_import: { at: string; rows_in: number; rows_new: number } | null;
  hubs: HubFreshness[];
}

export async function fetchFreshness(): Promise<Freshness> {
  const sent = Date.now();
  const { data, error } = await supabase.rpc('ic_source_freshness');
  if (error) throw new Error(error.message);
  const f = data as Freshness;
  setServerNow(f.now, (sent + Date.now()) / 2);
  return f;
}
