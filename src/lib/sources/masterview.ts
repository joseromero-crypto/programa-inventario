// Masterview products for this app, via the ic_mv_products() RPC (mv_products itself is login-only).
import { supabase } from '../supabase';

export interface MvProduct {
  sku: string;
  barcode: string | null;
  main_category: string | null;
  calii_unit: string | null; // 'kg' | 'pz'
  temp: string | null;
}

export async function fetchMasterview(): Promise<MvProduct[]> {
  const { data, error } = await supabase.rpc('ic_mv_products');
  if (error) throw new Error(error.message);
  return (data as [string, string | null, string | null, string | null, string | null][]).map(
    ([sku, barcode, main_category, calii_unit, temp]) => ({ sku, barcode, main_category, calii_unit, temp }),
  );
}
