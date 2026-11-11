// Stock estimates for one hub (last known quantity per SKU, 60 days), via ic_sku_stock(hub).
// The underlying view reads confirmations, which hold e-mails; the RPC returns [sku, last_qty] only.
import { supabase } from '../supabase';

export async function fetchStock(hubSlug: string): Promise<[string, number][]> {
  const { data, error } = await supabase.rpc('ic_sku_stock', { p_hub: hubSlug });
  if (error) throw new Error(error.message);
  return data as [string, number][];
}
