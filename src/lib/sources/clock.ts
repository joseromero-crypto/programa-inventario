// Server clock: ic_now() → { now, today_local }. Phones with a wrong clock still get the right day.
import { supabase } from '../supabase';
import { setServerNow } from '../time';

export async function syncServerNow(): Promise<string> {
  const sent = Date.now();
  const { data, error } = await supabase.rpc('ic_now');
  if (error) throw new Error(error.message);
  const r = data as { now: string; today_local: string };
  setServerNow(r.now, (sent + Date.now()) / 2);
  return r.today_local;
}
