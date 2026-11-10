# Inventario Conf: Phase 0 (setup)

Goal: an empty but fully wired app, live on Netlify. By the end of phase 0 it reads live sorting and Masterview, has its tables in Supabase, and receives confirmations from the sheet. No plan generator yet; that's phase 1.

Full spec: `docs/inventarioConf-v1-plan.md`. Put it in the repo first.

---

## 0.1 Repo and scaffold

- **Local folder:** `~/Desktop/inventario-conf`. **GitHub:** `joseromero-crypto/inventario-conf`.
- **Stack:** Vite + vanilla TypeScript. No framework, same feel as the other apps.
  - The generator has to be a tested, deterministic module, which is why this one has a build step instead of a single `index.html`.
  - Vitest for tests.
- **Structure:**
  ```
  docs/                     inventarioConf-v1-plan.md, inventarioConf-phase0-setup.md
  src/
    lib/supabase.ts         client (publishable key from env)
    lib/sources/sorting.ts  fetch sorting-hub/sorting/<hub>/latest.json + version.txt
    lib/sources/masterview.ts  read mv_products (sku, barcode, main_category, calii_unit, temp)
    lib/time.ts             all dates pinned to America/Monterrey via Intl; "now" from server (Armado CH lesson)
    generator/              (phase 1) pure module, no I/O
    pages/                  hub picker, admin/freshness (phase 0); plan, ruta, seguimiento (later)
  supabase/
    migrations/0001_ic_schema.sql
    migrations/0002_ic_seed.sql
    functions/sheet-ingest/index.ts
  apps-script/
    bridge.gs               generic Sheet → Supabase bridge
  tests/
  ```
- **UI:** Spanish, Calii white + teal theme (apply-calii-theme skill), hub picker on every load, no remembered state.
- **Commits:** `git add` / `git commit` in the terminal; push from GitHub Desktop.

## 0.2 Supabase (project `armado-ch`, ref `uuqqtksxlgkztenojufm`)

1. **Supabase CLI:** `supabase link --project-ref uuqqtksxlgkztenojufm`. All schema changes go through migration files in the repo, never through dashboard edits.
2. **`0001_ic_schema.sql`:** every `ic_` table from spec section 3, plus:
   - Indexes on `ic_conf_events (hub_slug, local_date)`, `(hub_slug, sku)`, and unique `src_key`.
   - `ic_sku_stock_est` as a view: last confirmation per hub+sku within the last 60 days.
   - `ic_ingest_cursors (source_name PK, last_row int, last_event_ts, row_count_seen, updated_at)`.
3. **RLS on all `ic_` tables:**
   - **anon:** `select` on plan, slot, config and freshness tables. No direct writes.
   - **Writes go through Edge Functions with the service role:**
     - `sheet-ingest`: shared secret.
     - `ic-admin` (stub in phase 0): coordinator PIN.
   - Store the PIN as a Supabase secret, **not in a public bucket**. Note: `recibo/config/admin_pin.txt` and `solcitudesarmado/coordinator_pin.txt` currently sit in public buckets, so anyone with the URL can read them. Worth moving later, outside this project.
4. **`0002_ic_seed.sql`:** initial config, all editable later in the app.

   | Hub | Login id | Roles | Workdays (default) |
   |---|---|---|---|
   | mh-contry | con | aux_inv 700 · lider_am 240 · lider_pm 240 · aux_rec 300 (via aux.calidad.con + Abarrotes) | Tue–Fri |
   | mh-condesa | csa | aux_inv 700 · lider_am 240 · lider_pm 240 · aux_rec 300 (aux.recepcion.csa) | Tue–Fri |
   | mh-zapopan | zap | aux_inv 700 · lider_am 240 · lider_pm 240 · aux_rec 300 (aux.recepcion.zap) | Tue–Fri |
   | mh-cumbres | cu | aux_inv 700 · lider_am 240 · lider_pm 240 | Mon–Fri |
   | mh-san-nicolas | sn | aux_inv 700 · lider_am 240 · lider_pm 240 | Mon–Fri |
   | mh-guadalupe | gpe | aux_inv 700 · lider_am 240 · lider_pm 240 | Mon–Fri |
   | mh-avicola | avi | aux_inv 700 · lider_am 240 · lider_pm 240 | Mon–Fri |

   - **Every hub:**
     - `aux.calidad.<id>` → aux_cal (coverage only; Carnes and freezers belong to aux_inv).
     - `aux.turno.<id>` → by_turno.
     - Unknown logins → extra.
     - `turno_split` 14:00, `moved_threshold` 20, `done_ratio` 0.8, `late_window_days` 2.
     - Cold room = aisle `A` (Contry: Q, W).
   - **Starter location rules:**
     - `^B0?(\d+)$ → B0$1` freezer.
     - `^(HOLANDA|NESTLÉ)$` freezer (San Nicolás).
     - `^(ARMADO|BODEGA|AGUA|FAR)$` ignore (to review).
     - `^[A-ZÑ]$` shelf_aisle.
     - Everything else is left unmatched, so it shows up in the preview.
   - **Cycle anchor:** Monday 2026-11-09 = global week 1.
5. **Edge Function `sheet-ingest`:**
   - POST `{source, rows[], firstRow, lastRow, sheetRowCount}` with header `x-ingest-secret`.
   - Whitelisted source `ic_confirmaciones` → `ic_conf_events`. It maps columns, derives `local_date` and `src_key`, and does attribution (spec section 6).
   - Upserts on `src_key`, updates the cursor, and returns `{received, inserted, duplicates}`.
6. **Secrets:** `INGEST_SECRET`, `IC_ADMIN_PIN`. Set them with `supabase secrets set`, never commit them.

## 0.3 Apps Script bridge (in Jose's Google account)

- A new standalone Apps Script project, "Calii Sheet Bridge", with `apps-script/bridge.gs` copied in. Keep the repo copy as the source of truth.
- **Script Properties:** `INGEST_URL`, `INGEST_SECRET`.
- **Config:**
  ```js
  const SOURCES = [{ name: 'ic_confirmaciones',
    sheetId: '1_Ddk3ZNrd-3AuTBlC96qrnLG0nkFaRSGLZYXviVj_jc', tab: 'Download', batch: 2000 }];
  ```
- **How it works:**
  - It reads the cursor from the function response (or from a GET `?cursor=`).
  - It reads rows `cursor+1 … lastRow` with `getRange` in batches, sending the header row with each batch, and POSTs.
  - If `lastRow < cursor` (the tab was trimmed), it resets to row 2 and relies on `src_key` to skip rows already stored.
  - It stops before Apps Script's 6-minute limit and continues on the next run.
- **Functions:**
  - `dryRun()`: sends 100 rows to a `?dry=1` endpoint that validates and returns counts without writing.
  - `backfill()`: run by hand until done.
  - `daily()`: time trigger, 23:00 America/Monterrey.

## 0.4 Netlify

- New site from the GitHub repo. Build: `npm run build`, publish dir `dist`.
- Env vars: `VITE_SUPABASE_URL=https://uuqqtksxlgkztenojufm.supabase.co`, `VITE_SUPABASE_PUBLISHABLE_KEY`.
- Optional: subdomain under joseromero.co, e.g. `conteos.joseromero.co`.

## 0.5 Phase 0 app screens

1. **Hub picker.** It lists the 7 MHs from `ic_hub_config`.
2. **Admin › Fuentes.** For each hub:
   - Sorting `updatedAt` and `version.txt`, rows, % full position.
   - "Códigos sin regla" count, using the seeded rules.
   - Masterview import date, last confirmation imported (max `event_ts`), confirmations per day for the last 14 days.
   - `Download` row count vs the 10M-cell limit (rows × 55).
   - Red when a source is stale: sorting > 21 days, confirmations > 2 days.

## 0.6 Done when

- [ ] Repo on GitHub, site live on Netlify, building from `main`.
- [ ] Migrations applied. `ic_` tables exist with RLS on, and seed rows exist for 7 hubs.
- [ ] `dryRun()` returns valid counts. `backfill()` loads all rows from Sep 22.
- [ ] **Replay check in SQL:** Contry, `local_date` between 2026-10-13 and 2026-11-08 → **8,868 rows, 3,715 distinct SKUs**.
- [ ] Rows attributed to `extra` are listed per hub. Review them, then add any missing logins to `ic_logins`.
- [ ] The Admin › Fuentes page shows the right freshness for all 7 hubs.
- [ ] `time.ts` tests pass. A phone set to UTC+8 still shows Monterrey dates.

## Decided: Carnes owner

Freezers and Carnes belong to **aux_inv** at every hub. Confirmations from `aux.calidad.<id>` (aux_cal) count toward cycle coverage but don't mark the aux_inv's locations done.

---

## Kickoff prompt for Claude Code

> Read `docs/inventarioConf-v1-plan.md` and `docs/inventarioConf-phase0-setup.md`. We're doing **phase 0 only**. Start with 0.1: scaffold the Vite + TS project in this folder, init git and make the first commit (don't push; I push from GitHub Desktop). Then stop and show me the structure before moving to 0.2.
