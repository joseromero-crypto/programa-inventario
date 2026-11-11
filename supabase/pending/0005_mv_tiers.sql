-- Phase 0 step 0.2.7: per-city tiers from the Masterview upload (hub-rules §2.1).
--
-- HOLD: mv_product_city is a SHARED table (owned by the Masterview upload in
-- calii-invoice-reader). Do not push this migration until Jose confirms, and coordinate
-- it with the unify-Masterview plan. The upload change that fills the column lives in the
-- calii-invoice-reader repo.
--
-- Additive and nullable: existing readers and the current upload keep working unchanged.
-- Values are the raw Tiers cell (e.g. '1', '0', 'C'); the generator parses them.
-- Note: mv_product_city.city is stored capitalized ('Monterrey', 'Saltillo', 'CDMX',
-- 'Guadalajara') while ic_hub_config.city is lowercase, so join on lower(city).
--
-- Kept in supabase/pending/ (not migrations/) so `supabase db push` can't apply it by
-- accident. Once approved: move it to supabase/migrations/ and push.

alter table public.mv_product_city add column if not exists tiers text;
