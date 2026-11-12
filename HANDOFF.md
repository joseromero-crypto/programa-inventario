# Inventario conf — handoff

Newest first. Spec: `docs/inventarioConf-v1-plan.md` (hub-rules `docs/inventarioConf-hub-rules.md` wins where they differ).
Generator details: `src/generator/README.md`.

## Where things stand (2026-11-11, end of phase 2)
- **Done:** phase 0, phase 1 (generator) and phase 2 (Plan and Ruta del día screens). Migrations 0001–0008 are applied
  on Supabase `armado-ch`; `ic-admin` is deployed with the plan actions.
- **Contry:** a draft plan is saved (plan id 2, cycle 1, 4 weeks from Mon Nov 9, 208 location visits). **Nothing is
  active yet:** Jose activates it in Plan › Activar with the admin PIN. Until then Ruta del día says "no tiene un plan
  activo".
- **Not built:** Seguimiento, the weekly close, Configuración hub.
- **Not pushed:** everything after `dc706f2` is local only. The screens go live when Jose pushes from GitHub Desktop.
  The database side (0008, `ic-admin`) is already live, so the pushed site will work as soon as it builds.
- `npm test`: 107 passing. `npm run build`: green.
- **Local preview:** `.claude/launch.json` → `dev` on port 5180 (moves to 5181 when 5180 is taken).

## 2026-11-11 — phase 2: Plan and Ruta del día (migration 0008)
- **Inputs** (`src/lib/plan/inputs.ts`): hub config, roles, location rules, sorting, Masterview, tiers for the hub's
  city, and stock from the new `ic_sku_stock(hub)` RPC (`[sku, last_qty]` only, no e-mails). Cycle start = Monday of
  today (server clock, `ic_now()`); global anchor 2026-11-09. The generator runs in the browser.
- **Saving** (`ic-admin`, PIN per action, never stored): `save_draft`, `move`, `activate`. Validation and Spanish errors
  live in `supabase/functions/_shared/plan_admin.ts` (tested); each write is one SQL transaction
  (`ic_plan_save_draft` / `ic_plan_move` / `ic_plan_activate`, service role only) and is logged in `ic_plan_log`.
  - A new draft replaces the hub's previous draft (drafts aren't history). Active and closed plans are never touched.
  - Moves: drafts only, one visit at a time, never into or out of a day that has passed. Moved visits are tagged.
  - Activate: the previous active plan becomes `closed` with its rows untouched; one active plan per hub.
  - `ic_slot_units` gained `positive_est` (esperados con stock) and `walk_rank` (walking order, so moved visits still
    sort right). The report jsonb also stores the exception list (`exceptionList`).
- **Plan screen:** Generar borrador (preview, nothing saved) → Guardar borrador → move chips → Activar. Week tabs, role ×
  day grid with load bars (ink when over), overload banner with the suggested fix, report messages, role loads with
  sections, exceptions grouped by type.
- **Ruta del día:** phone-first, read-only. Day arrows + date, role chips, summary (ubicaciones / total SKUs / con
  stock), notes, locations in walking order with tags (tier 0, congeladores grupo A/B, tiers semanales, rotación
  mensual, cuarto frío, incluye ~N sin estante, movida por coordinador) and the extra "sin identificar" block.
- **Bug fixed while testing:** `ic-admin` answered a wrong PIN before reading the uploaded plan, and browsers then hung
  forever. It now reads the body first; the app also gives up after 60 s.
- **How it was checked:** real Contry data in the browser (desktop and phone). The save and a test move ran through
  the deployed function with the real PIN from the shell (the PIN never went into the browser). The Ruta screenshots
  used the saved draft shown as if active in one browser tab, because activating is Jose's decision.

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

## 2026-11-10/11 — phase 0: setup, data, Fuentes (`4cc318b` … `2d4141d`, migrations 0001–0005)
- **Where it lives:**

  | | |
  |---|---|
  | Local folder | `~/Desktop/inventario-conf` |
  | GitHub | `joseromero-crypto/programa-inventario` (a different name than the folder) |
  | Netlify | site `programa-inventarios`, live at https://programa-inventarios.joseromero.co. Builds from `main`; config in `netlify.toml` (public URL and publishable key only, so there are no Netlify env vars) |
  | Supabase | `armado-ch`, shared with other apps |

- **0.1 scaffold:** Vite + TS + Vitest, Calii theme (`src/styles/calii-theme.css`, unedited) plus `app.css`.
- **0.2 Supabase:**
  - **0001:** all `ic_` tables, RLS, the 60-day `ic_sku_stock_est` view, cursors, and the RPCs `ic_mv_products`,
    `ic_source_freshness` (anon) and `ic_ingest_conf` (service role).
  - **0002:** seed of 7 hubs, roles, logins and starter location rules.
    - The spec's `^B0?(\d+)$ → B0$1` turns B10 into B010, so it's split into two rules (B1 → B01, B10 → B10).
  - **0003:** "MH <name>" display names, `sort_order`, `in_plan`, and CH Guadalupe last (shown as "Próximamente",
    `in_plan = false`, no rules or logins).
  - **0004:** hub profiles: city, `cycle_weeks`, `rotation_mode`, `walking_order`. Condesa and Zapopan moved to Mon–Fri.
  - **0005:** `mv_product_city.tiers`, applied with Jose's OK.
  - **Masterview access:** `mv_products` is login-only, so the anon app reads it through `ic_mv_products()` only.
  - **Edge Functions:**
    - `sheet-ingest` (secret header, whitelisted source, `?dry=1`, `GET ?cursor=`).
    - `ic-admin` (PIN check only, a stub).
    - Logic lives in `supabase/functions/_shared/`.
- **0.3 Apps Script bridge** ("Calii Sheet Bridge" in Jose's Google account; source of truth is `apps-script/bridge.gs`):
  - **Functions:** `dryRun`, `backfill` (schedules its own continuation runs), `daily` (trigger at 23:00 Monterrey,
    installed), `resync`, `status`.
  - **Backfill:** 96,749 rows, 0 rejected.
  - **Replay check:** Contry Oct 13–Nov 8 = 8,868 rows / 3,715 SKUs, exact.
  - **The file is ASCII-only on purpose:** the clipboard mangled accents once. Headers are matched without accents.
    When updating, Jose pastes the whole file into the Apps Script editor; copy it with
    `LANG=en_US.UTF-8 pbcopy < apps-script/bridge.gs`.
- **0.4 Netlify:** first deploy and the custom domain. HTTPS works; turning on "Force HTTPS" in Netlify is optional.
- **0.5 screens:**
  - **Router:** in-memory (`src/router.ts`). The hub picker shows on every load and the back button works.
  - **Hub home:** Plan, Ruta and Seguimiento say "Próximamente".
  - **Admin › Fuentes** (`src/pages/fuentes.ts`):
    - shared: Masterview import, and Download rows and cells vs 10M (53.2%);
    - per hub: sorting age and version, position quality, "códigos sin regla" with the codes, last confirmation,
      and a 14-day bar strip.
  - `src/lib/time.ts` (Monterrey dates, server clock, `workdaysBetween`) is tested with the device at UTC+8.
- **Decisions Jose made this session:**
  - Personal `@calii.com` logins (coordinators covering vacations or missed days) stay `extra`: they count toward
    coverage and totals, never toward a role's tasks. Only an unmapped `aux.*` login is a problem; there are none today.
  - **Stale ("Desactualizado"):** sorting > 21 calendar days, or confirmations > 2 **workdays** (Mon–Fri; weekends
    ignored). Shown as the theme's black pill, not red.
  - Codes with no location rule go to the temporary "Ubicaciones sin identificar" group (hub-rules §2.4).
  - Work on localhost and batch pushes; each push costs a Netlify build.
- **How to operate:**
  - **Supabase CLI:** the npm devDependency (`npx supabase`), logged in and linked. v3 targets a local stack unless you
    pass `--remote`, and it refuses production changes in agent mode without `--yes`. Do a `--dry-run` first.
  - **Validating SQL:** there's no Docker or psql. Use PGlite (`tests/migrations.test.ts`) before any push.
  - **Secrets:** `INGEST_SECRET` and `IC_ADMIN_PIN` are in `.env.secrets.local` (gitignored, mode 600) and set as
    Supabase secrets. Never print them; copy with `grep … | cut … | pbcopy` if Jose needs one.
  - **Dev server:** port 5180, because 5173 is used by another of Jose's apps.

## To know / open items
- **Migration history: fixed 2026-11-11.** 0007 had been applied outside the CLI (recorded as `20261111212656`).
  Repaired with `migration repair` (timestamp → reverted, `0007` → applied); local and remote now list 0001–0007 and
  `db push --dry-run` is up to date. **Always apply migrations with `npx supabase db push --remote`**, never the
  connector's `apply_migration`, which records a timestamp instead of the file's number.
- **No new confirmations since Nov 6** (cursor at row 96,750). Either the Download tab hasn't been updated or the 23:00
  sync isn't adding rows. The bridge only writes when there are new rows. Check with `status()` in Apps Script, or the
  executions list there.
- **Sheet size:** 53% of the 10M-cell limit from the Download tab alone, growing about 1.5% a day. Talk to Mario about
  trimming before December (spec §6).
- **Códigos sin regla** (2026-11-10):

  | Hub | Without a rule |
  |---|---|
  | Condesa | 59 / 93 (`CAM-2`, `CAM2`, `B-3`, `D2`, `C1`, `CABECERA H`, …) |
  | Zapopan | 25 / 47 (numeric aisles `6`, `9`, `7`, `10`, plus `R1`, `CABECERA`, `BOTE AZUL`) |
  | Guadalupe | 24 / 58 |
  | Avícola | 12 / 42 |
  | Contry | 4 (`|`, `0`, `3`, `G}`) |
  | San Nicolás | 2 |
  | Cumbres | 0 (but a bare `B` counts as a shelf aisle) |

  The coordinators need to say what each code is.
- **Coordinator logins seen as `extra`:** marian@ (Cumbres 675, Guadalupe 1), jesus.zamora@ (Avícola 652),
  daniel.cuellar@ (Contry 379), jesus.gallegos@ (Guadalupe 198), abdiel.gonzalez@ (San Nicolás 145), adan.canseco@
  (Zapopan 101), jose.silva@ (Cumbres 90), victor.ramirez@ (Condesa 53), plus mario@ and jose.romero@ (2 each).
- **30,184 confirmation rows have no barcode** in the sheet. Harmless: rows key on `sku`.
- **Public PIN files:** `recibo/config/admin_pin.txt` and `solcitudesarmado/coordinator_pin.txt` sit in public buckets
  (other apps, phase 0 doc). Worth moving later.
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

## Found in phase 2 (for later)
- **Cold room halves are bigger than a day.** Contry's Cuarto frío Q is ~309 SKUs (269 with stock) and sits alone on
  aux_inv's Tuesday (capacity 175/day), so every Tuesday shows over. The weekly total fits; only the day is heavy. Options:
  raise aux_inv's Tuesday, or let the generator balance the tier-0 route across days by load. Halves stay as they are.
- **Mid-week generation:** the cycle starts on the current Monday, so a draft made on Wednesday has Mon–Tue already past.
  The "sin identificar" block lands on week 1's first day (Tue Nov 10 for Contry), which is already gone. Consider
  starting a draft made after Monday on the next Monday, or placing the extra block on the first day still to come.
- **123 frozen SKUs without a freezer** in Contry (note on aux_inv's freezer day). Probably aisle Z; see the open item.
- **Exceptions:** Contry has 784 (579 solo pasillo, 123 congelado sin congelador, 76 sin posición, 4 código sin regla,
  2 no están en Masterview). The panel lists them; nothing is written to `ic_exceptions` yet (weekly close).
- **Leads are 1–25 SKUs over** for the cycle (961/960, 985/960). Shown on the role bars; no banner because the cycle
  as a whole fits.
- The date picker shows the browser's date format (e.g. 11/11/2026 on an English phone).

## Next: phase 3 — Seguimiento and the weekly close (suggested)
- Seguimiento per location: done / late / pending / done by another role, from `ic_conf_events` vs the active plan.
  Jose asked for two views (2026-11-11):
  - **By shelf:** every shelf of the hub, grouped by aisle (tap an aisle to open its shelves). Each shelf shows when
    it is scheduled, who is assigned, its status, and who actually confirmed it and when. v1 is an interactive list;
    a floor map of the hub would be the ideal later version.
  - **By day:** that day's shelves per person, each marked done or pending as confirmations arrive.
  - Freshness: at least daily (bridge trigger at 23:00 today). Show the data's age on screen. Hourly is an option.
- Found 2026-11-11: no confirmation events after Nov 6 (local) for any hub. Cause (Jose): hubs did confirm, but the
  sheet is filled by a manual upload to Drive by Jose's boss, which hadn't been done yet. So Seguimiento is only as
  fresh as that upload, not the 23:00 bridge. The screen must show the date of the latest confirmation it has, and
  "late" must not be judged on days the data doesn't cover yet.
- Weekly close (spec 5.2): revisits, new/removed locations, layer 4 refresh, past and current weeks locked.
- Configuración hub (roles, capacities, rules with live preview, walking order).

## Phase 2 brief (done; kept for reference)
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
