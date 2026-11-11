# Inventario conf — handoff

Newest first. Spec: `docs/inventarioConf-v1-plan.md` (hub-rules `docs/inventarioConf-hub-rules.md` wins where they differ).
Generator details: `src/generator/README.md`.

## Where things stand (2026-11-11)
- **Done:** phase 0 (tables, sheet import, hub picker, Admin › Fuentes) and phase 1 (plan generator). Migrations 0001–0007
  are applied on Supabase `armado-ch`.
- **Not built:** the screens people use. Plan, Ruta del día and Seguimiento still say "Próximamente". The generator runs
  only in tests and scratch runs; no plan has been saved yet.
- **Not pushed:** 13 commits are local only (`main` is ahead of `origin/main` up to `e1d69df`). The live Netlify site only
  has the initial commit until Jose pushes from GitHub Desktop.
- `npm test`: 87 passing. `npm run build`: green.
- **Local preview:** `.claude/launch.json` → `dev` on port 5180.

## 2026-11-11 — match by SKU, then name, then barcode (`e1d69df`, migration 0007)
- Jose: barcodes can be wrong, change or be missing; the Calii SKU (3 letters + 3 digits) is always there. The sorting
  export has no SKU column, so `src/generator/match.ts` matches each row in this order:
  1. by SKU, if a row ever carries one;
  2. by exact name, ignoring case, accents and spaces;
  3. by barcode, as a last resort, ignoring leading zeros.
  A name shared by several products is settled by its barcode, or not used.
- Everything inside the plan (location dedupe, DUP_POSITION, sin-estante spread) is now keyed on the SKU, not the barcode.
- **Contry, before and after:**
  - Products not found in Masterview: 155 → 5. The 164 rows that failed the barcode join had lost a leading zero, and all
    of them match by name.
  - 4,491 rows now match by name and 23 only by barcode.
  - DUP_POSITION: 7 → 0. The 7 were Calii barcodes reused on different products (a cookie and a gelato; eggs and a
    cookie), which the old join had merged.
- The load report has a `matching` count. It also says how many products were found only by barcode (a name mismatch to
  fix in sorting or Masterview) and how many weren't found at all.
- **Migration 0007:** `ic_mv_products()` adds the product name as its 7th element. Tested on PGlite and applied live
  (5,483 products, all with a name). `MvProduct.name` is in `src/lib/sources/masterview.ts`.
- The fixture's products carry names, taken from sorting. A 80-row sample matched Masterview exactly in 79 rows.

## 2026-11-11 — Jose's corrections to phase 1 (`0a4ad75`, migration 0006)
- **Cold room:** stays as the halves the location rules give (Contry: Q and W). Never propose splitting it further.
- **Sin estante** (aisle, no estante): no stop of their own.
  - Their count and expected-with-stock load are spread over the aisle's shelves by shelf SKU count (`looseCount`). They
    are confirmed when the aisle is visited.
  - They get an AISLE_ONLY exception with `unitKey: null` and their `aisle`.
  - Only an aisle with no shelves at all keeps one `X (sin estante)` stop. Contry has none.
- **Category** (FyV / Carnes / Abarrotes) comes from Masterview's "Assembly Category" (`mv_products.raw`), not from
  confirmations. All 5,483 products have one.
- **Migration 0006 (plan storage):**
  - Plans: `cycle_weeks` (1–8), `rotation_mode` and the `report` jsonb.
  - Slots: `global_week`, the `extra` block, `notes`, and capacity as numeric(8,2). The unique key is now
    (plan, day, role, extra).
  - Slot units: the kinds shelf / aisle_only / freezer / cold_room / unidentified, plus `layer`, `load`, `sku_count`
    and `loose_count`.
  - The weekly-close tables accept weeks up to 8.
  - New RPC `ic_mv_tiers(city)`, readable by anon.

## 2026-11-11 — phase 1: plan generator (`5572759`)
- `src/generator/` is pure and deterministic: `generate(input) → Plan` (units, slots, exceptions, load report with
  Spanish messages).
- **Layers:**
  1. **Tier 0 route** (weekly): the cold room plus the shelves with the most tier-0 products. Budget = aux_inv weekly
     capacity minus the larger freezer half.
  2. **Freezers:** two halves balanced on kg and pz, A on odd global weeks and B on even.
  3. **Monthly rotation:** `physical` (contiguous sections per role, equal fill; aux_inv last plus Carnes) or
     `tier_order`.
  4. **Weekly tiers:** tier 1, 2, … 5.1, 5.2 shelves with the leftover capacity only.
  - Plus the "Ubicaciones sin identificar" extra block and the load report (overload with the smallest fix and
    "agregar lunes", shorter-cycle hint).
- Tiers come only through `tierSource(hub)`; tier 0 wins over its sales tier. `cycle_weeks` is honored. Day
  capacity = weekly capacity ÷ the role's workdays.
- **Tests:** `tests/generator/*` and `tests/migrations.test.ts` (PGlite). The fixture `tests/fixtures/contry-slice.json`
  is a small real Contry slice with no e-mails.
- **Full Contry run** (physical mode, 4 weeks, after all fixes above):

  | | Result |
  |---|---|
  | Cycle | capacity 5,920, load 5,919 |
  | Tier 0 | 35 of 35 tier-0 SKUs weekly, about 566 SKUs/week |
  | Freezers | about 104 SKUs/week |
  | Rotation | 124 locations |
  | Weekly tiers | 4 shelves, about 27 SKUs/week of leftover, which covers 15% of tier 1 |

  | Role | Load / capacity | Section |
  |---|---|---|
  | aux_inv | 2,800 / 2,800 | V-1 → Z-11 + Carnes |
  | lider_am | 961 / 960 | A-2 → F-4 |
  | lider_pm | 985 / 960 | F-5 → I-8 |
  | aux_rec | 1,172 / 1,200 | J-1 → R-1 |

## To know / open items
- **Tier-0 products missing from Contry's sorting:** 126 of 183 are FyV (out of the plan). 21 are Calii Fresh items filed
  as Carnes with no position; they're covered only if they sit in the cold room.
- **Contry aisle Z** has 48 of 52 SKUs frozen, so it may be a freezer. Jose is checking with the coordinator. If it is,
  add a location rule; no code change.
- **Name mismatches:** 23 Contry products match only by barcode (their names differ) and 5 aren't in Masterview at all.
  The list can be pulled from the generator's output.
- **Capacity is tight:** there's almost no room for weekly tiers. Options: raise the leads' capacity (240 → 300), or run
  tier 1 every 2 weeks.
- **Carnes** can push aux_inv slightly over; this shows in the report.
- **Open decisions** (spec §9): `done_ratio` (80% of the SKUs expected with stock?), `col6`, and sheet ownership and
  trimming before December (with Mario).
- **Weekly close** (spec §5) isn't built. It should reuse `cut.ts` / `calendar.ts` with past and current weeks locked.

## Next: phase 2 — Plan and Ruta del día screens (Contry first)
Prompt Jose will run in a new task:

- **Loading inputs:** config, roles and location rules; sorting, Masterview and tiers. Stock estimates need a new
  security-definer RPC (`ic_sku_stock_est` is service-role only) returning [sku, last_qty] per hub, with no e-mails.
- **Saving:** draft, move and activate through `ic-admin` (`x-admin-pin`, logic in `_shared`, Vitest-tested), logged
  to `ic_plan_log`.
- **Plan screen:**
  - "Generar borrador", then a week × role × day grid.
  - Load bars, the overload banner, report messages and an exceptions panel.
  - Moves in the draft, then "Activar".
- **Ruta del día:** read-only, role + date, locations in walking order with "total SKUs / esperados con stock" and tags.
  Phone-first.
- **Out of scope:** Seguimiento, the weekly close and Configuración hub.
- **Rules:** schema changes in 0008+, PGlite first, `ic_` only. Commit locally and never push.
