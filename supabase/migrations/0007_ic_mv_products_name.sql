-- Sorting rows are matched to Masterview by SKU, then product name, then barcode (barcodes can be
-- wrong, change or be missing; the Calii SKU and the name are always there). The app needs the name.
-- Only ic_mv_products() changes; mv_products is read, never altered.
-- Same return type (jsonb array of arrays); a 7th element is appended: the product name.
create or replace function public.ic_mv_products()
returns jsonb
language sql
stable security definer
set search_path to ''
as $$
  select coalesce(jsonb_agg(jsonb_build_array(
           p.sku, p.barcode, p.main_category, p.calii_unit, p.temp,
           p.raw->>'Assembly Category (options are: frutas y verduras, carnes, abarrotes)',
           p.name
         ) order by p.sku), '[]'::jsonb)
  from public.mv_products p
  where p.raw->>'retired_at' is null
$$;
