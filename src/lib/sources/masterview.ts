// Masterview for this app, via security-definer RPCs (mv_products / mv_product_city are login-only).
//   ic_mv_products()      → [sku, barcode, main_category, calii_unit, temp, assembly_category, name]
//   ic_mv_tiers(city)     → [sku, tiers] for one city (joined on lower(city))
import { supabase } from '../supabase';
import type { Category, CityTierRow } from '../../generator/types';

export interface MvProduct {
  sku: string;
  name: string | null; // sorting rows are matched on it before the barcode
  barcode: string | null;
  main_category: string | null; // web taxonomy, not the assembly category
  calii_unit: string | null; // 'kg' | 'pz'
  temp: string | null;
  category: Category; // Masterview "Assembly Category": FyV / Carnes / Abarrotes
}

/** Masterview "Assembly Category (options are: frutas y verduras, carnes, abarrotes)" → generator category. */
export function assemblyCategory(raw: string | null | undefined): Category {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === 'frutas y verduras') return 'fyv';
  if (v === 'carnes') return 'carnes';
  if (v === 'abarrotes') return 'abarrotes';
  return null;
}

export async function fetchMasterview(): Promise<MvProduct[]> {
  const { data, error } = await supabase.rpc('ic_mv_products');
  if (error) throw new Error(error.message);
  return (data as [string, string | null, string | null, string | null, string | null, string | null, string | null][]).map(
    ([sku, barcode, main_category, calii_unit, temp, assembly, name]) => ({ sku, name: name ?? null, barcode, main_category, calii_unit, temp, category: assemblyCategory(assembly) }),
  );
}

export async function fetchTiers(city: string): Promise<CityTierRow[]> {
  const { data, error } = await supabase.rpc('ic_mv_tiers', { p_city: city });
  if (error) throw new Error(error.message);
  return (data as [string, string | null][]).map(([sku, tiers]) => ({ sku, city, tiers }));
}
