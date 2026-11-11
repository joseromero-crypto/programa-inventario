# Confirmación de inventario: v1 plan (draft 2)

An app that **generates and keeps alive** each micro hub's 4-week confirmation plan. It reads live sorting and per-hub parameters, publishes daily lists, and compares them against actual confirmations.

- **Deterministic code:** the same inputs always produce the same plan. No AI at runtime.
- **Location:** the shared `armado-ch` Supabase project (`uuqqtksxlgkztenojufm`), with its own repo, Netlify site and Armado CH / Sorting Hub style.

**Core principles**
- **The app is a guide, not a counting tool.** Confirmations are still done in Retool. Each person's daily view is a list of **locations** (shelves, freezers, cold room) with total SKUs and SKUs expected with stock. There are no item lists.
- **Sorting is unfinished and keeps changing.** The plan schedules locations, and coverage is tracked per SKU behind the scenes. Sorting edits never force a replan from scratch.
- **The plan doesn't change mid-week.** Sorting edits are reconciled once a week in the weekly close (section 5).

---

## 1. Scope

- **v1 hubs:** mh-contry, mh-cumbres, mh-guadalupe, mh-san-nicolas, mh-avicola, mh-condesa, mh-zapopan.
- **v2:** ch-guadalupe. It has no individual freezers, just one freezer room with aisles and racks. That fits the `cold_room` / `shelf_aisle` kinds below, but it needs its own capacity and roles.
- **In the plan:** Abarrotes (ambient and chilled) and Carnes. Carnes and freezers are owned by the aux. de inventarios.
- **Out of the plan:** FyV, which is confirmed in full every day. FyV confirmations are still ingested, so cycle coverage stays complete, but they generate no tasks.

## 2. Sources (verified Nov 10 2026)

### 2.1 Sorting: `storage: sorting-hub/sorting/<hub>/latest.json` (public bucket) plus `version.txt`
```
{ hub, updatedAt, sourceFile, count, quality, items: [[name, barcode, pasillo, estante, nivel, col6, temp], ...] }
```
- The file has no SKU code. Each row is matched to `mv_products` by SKU (if a row ever carries one), then by product name,
  then by barcode as a last resort (barcodes can be wrong, change, be missing or be reused; leading zeros are ignored).
  The Calii SKU is the identity from there on. See `src/generator/match.ts`.
- The app polls `version.txt` (cheap) and re-reads `latest.json` when it changes.

| Hub | Updated | Rows | Full pos. | Aisle only | No pos. | Aisle codes | Shelves | Freezers | Frozen w/o B## |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Contry | Oct 30 | 4,552 | 3,779 | 641 | 132 | 30 | 168 | 14 | 123 |
| Cumbres | Nov 9 | 4,887 | 4,487 | 385 | 15 | 14 | 74 | 17 | 96 |
| Guadalupe | Oct 30 | 4,552 | 4,307 | 218 | 27 | 41 | 130 | 17 | 18 |
| San Nicolás | Oct 30 | 4,552 | 4,273 | 0 | 279 | 17 | 83 | 11 | 102 |
| Avícola | Oct 30 | 4,391 | 4,340 | 3 | 48 | 30 | 80 | 12 | 42 |
| Condesa | Nov 9 | 4,513 | 4,369 | 74 | 70 | 84 | 158 | 9 | 69 |
| Zapopan | Oct 30 | 4,170 | 3,967 | 116 | 87 | 37 | 124 | 10 | 44 |

Codes are inconsistent: Cumbres `B1`/`B01`/bare `B`, San Nicolás `HOLANDA`/`NESTLÉ`, Guadalupe `A`/`A01`/`A1`, Contry `G}`/`|`. Per-hub location rules handle this (section 4.1).

### 2.2 Confirmations: sheet "Calii | Desempeño de auxiliares", tab **`Download`**
- **Shape:** 96,750 rows × 55 columns. One row is one confirmation. Every row has `Registrado por`, so the tab holds only confirmations, not the whole catalog.
- **Coverage:** 7 hubs, Sep 22 → Nov 6. Condesa and Zapopan start Oct 22.
- **Columns used:**
  - Identity: `Hub`, `sku`, `Código de barras`.
  - Event: `Actualización confirmación` (ISO timestamp with offset), `Fecha de inventario`, `Turno` (Día/Tarde, already in the data), `Registrado por`.
  - Quantities: `Nro. de unidades [MANUAL]`, `Final [AUTO]`, `Inv. disponible app`, `Delta Final`, `Delta $`.
  - Product: `Tiers`, `Categoría Final` (1. FyV / 2. Carnes / 3. Graneles y abarrotes), `Kg / Pz`, `Posición inventario`, `Requiere confirmar`.
- **Unique key:** `Hub + sku + Actualización confirmación`. It has 0 duplicates.
- **Validated:** MH Contry, Oct 13–Nov 8 gives **8,868 rows and 3,715 distinct SKUs**, an exact match with the pilot report.

### 2.3 Tiers
- `Tiers` is a semicolon list of tags: `0`, `1`–`4`, `5.1`–`8.2`, `C`, `F`, `N`. For example `2; 0; F`.
- **Tier 0 is the `0` tag.** No separate upload or category list is needed.
- For SKUs never confirmed, the tier comes from the `Source price` tab (full catalog, has `Tiers`), or the one-time per-hub upload you mentioned.
- `C` (congelado), `F` (frío) and `N` (nuevo) are ignored. The tier is read per hub row, from the latest confirmation of each SKU at each hub.

### 2.4 Stock
- There is no full-catalog stock per hub. `Inv. disponible app` exists only on confirmed rows.
- **Sizing estimate:** for each hub and SKU, take the last known `Inv. disponible app` / `Final [AUTO]` from confirmations within the last 60 days. If it's > 0, the SKU counts as "positive". If the SKU has no record, it counts as "unknown" and is sized at the hub's observed positive ratio.
- With ~75% catalog coverage per cycle, this estimate stays current. The UI labels it "estimado (última confirmación)".

## 3. Data model (prefix `ic_`)

```
ic_hub_config      hub_slug PK, active, workdays int[] (1=Mon..7=Sun), turno_split '14:00',
                   sizing_basis ('positive'|'catalog'), late_window_days int default 2
ic_roles           id, hub_slug, role_key ('aux_inv'|'lider_am'|'lider_pm'|'aux_rec'|'aux_cal'),
                   label, weekly_capacity int, days int[], active
ic_logins          hub_slug, login (email), role_key | 'by_turno' | 'by_category'   -- incl. personal emails
ic_location_rules  id, hub_slug, priority, match_regex, normalize_to, kind
                   ('shelf_aisle'|'freezer'|'cold_room'|'ignore'), group_label
ic_cycle           anchor_monday date = 2026-11-09 (global week 1)

-- live inputs (refreshed, not versioned per plan)
ic_sku_locations   hub_slug, barcode, sku, name, unit_key|null, unit_kind, raw_pos, nivel, temp,
                   calii_unit, assembly_cat, tier0 bool, exception_code|null, sorting_version
ic_sku_stock_est   hub_slug, sku, last_qty, last_conf_at        -- view over ic_conf_events

-- the plan = a schedule of LOCATIONS
ic_plans           id, hub_slug, cycle_no, cycle_start, status ('draft'|'active'|'closed'),
                   generator_version, params jsonb, created_at, activated_at
ic_slots           plan_id, week 1..4, day date, role_id, capacity
ic_slot_units      plan_id, slot_id, unit_key, unit_kind, seq, origin
                   ('generated'|'coordinator'|'auto_new_unit'|'rebalance'), added_at
ic_plan_log        plan_id, at, actor, action, detail jsonb      -- every move, add, rebalance

-- weekly close
ic_week_closes     plan_id, week, closed_at, sorting_version, summary jsonb
ic_unit_week_state plan_id, week, unit_key, skus_at_close, skus_confirmed, skus_pending,
                   moved_in_after_visit int     -- SKUs that landed on this unit after it was visited

ic_conf_events     hub_slug, sku, barcode, login, role_key, turno, local_date, event_ts,
                   qty_manual, qty_auto, delta, delta_money, categoria, tiers, src_key UNIQUE, import_id
ic_conf_imports    id, source, rows_in, rows_new, max_event_ts, at
ic_exceptions      hub_slug, sku|barcode, code, owner_role_id, status, first_seen, last_seen, note
```

## 4. Generator (pure TypeScript module, no I/O, unit-tested)

`generate(config, roles, rules, skuLocations, stockEst, cycleStart, lockedSlots?) → { slots, slotUnits, exceptions, loadReport }`

Ties are broken by fixed keys, so output is stable. The weekly close (section 5) reuses the same placement functions for revisits and new locations, with past and current weeks locked.

### 4.1 Normalize locations
- **Rules:** per-hub regex rules, first match wins. For example `^B0?(\d+)$ → B0$1 (freezer)`, `^(HOLANDA|NESTLÉ)$ → freezer`, `^(ARMADO|BODEGA)$ → ignore`.
- **Units:**
  - `shelf_aisle` → unit `A-4`.
  - `freezer` → unit `B07`.
  - `cold_room` → unit `Cuarto lácteos` (optional parts 1/2).
- **Exceptions:** `NO_POSITION`, `AISLE_ONLY` (shown as "buscar en pasillo X", on the day that aisle is visited), `UNKNOWN_CODE`, `FROZEN_NO_FREEZER`, `NOT_IN_MV`, `DUP_POSITION`.
  - Each exception has an owner (default aux_inv) and is never spread across shelves.
  - The config screen shows a live preview: "23 códigos sin regla".
- FyV is dropped.

### 4.2 Load per unit
- `assigned` = number of SKUs.
- `positive_est` = SKUs with last_qty > 0, plus unknown SKUs × the hub's positive ratio.
- Both numbers are always shown. `sizing_basis` picks which one is checked against capacity.

### 4.3 Priority route (aux_inv, weekly)
- **Shelf score** = number of tier-0 SKUs with positive stock estimate.
- Priority cold rooms always go on the route.
- Then shelves are added by descending score until the **priority budget** is used. The budget is aux_inv weekly capacity minus that week's freezer half, and is editable.
- The route repeats every week on the same days.

### 4.4 Freezers (aux_inv, every 2 weeks, all hubs)
- Split the freezers into groups A and B so that **each group holds about half the kg SKUs and about half the pz SKUs**.
- Method: a greedy start, then pairwise swaps until the imbalance stops dropping.
- Group A runs weeks 1 and 3, group B weeks 2 and 4.
- `FROZEN_NO_FREEZER` SKUs are attached to that day as "ubicar congelador".

### 4.5 Monthly rotation (everything else)
- **Order:** units in physical order, aisle then estante.
- **Slots:** each (week, role, day), with capacity = role weekly capacity ÷ active days.
- **Assignment:** contiguous blocks, about 1/4 of the load per week. A role keeps neighboring aisles where possible, and a unit is never split.
- **Overload:** everything is still assigned. The report shows how far each role is over and the smallest fix ("agregar lunes": per your note, Monday covers the ~300/week that 3-aux hubs lack). The cycle is never extended.

## 5. The living plan: frozen weeks, weekly close

**Within a week, nothing changes.** Everyone follows the published week as it is. Sorting edits are recorded, but they only take effect at the weekly close.

### 5.1 Create and activate
"Generar borrador" builds the 4 weeks. The coordinator moves locations between days and roles, then hits "Activar".

### 5.2 Weekly close
The close runs automatically after the last workday of each week, once that week's confirmations are imported. It can also be run by hand. It does four things:

1. **Reads the current sorting** and compares it with the sorting used when the week started.
2. **Measures each location visited this cycle:** SKUs now there, SKUs confirmed this cycle, and SKUs that **moved into it after its visit** and are still unconfirmed.
3. **Applies the moved-SKU rule**, with a configurable threshold `moved_threshold`, default 20:
   - **Below the threshold:** nothing happens. Those few SKUs are skipped this cycle and caught on the next rotation.
   - **At or above the threshold:** the location is added again to a coming week of the same cycle, in the slot with the most spare capacity, marked "revisita". The re-visit is scheduled so the moved SKUs aren't ignored.
   - The threshold is measured per destination location, so 20 SKUs moved onto one shelf triggers it, but 20 scattered across 20 shelves doesn't.
4. **Handles new and removed locations:**
   - A **new location** (a new shelf code with SKUs that hasn't been visited this cycle) is placed in the remaining week with the most spare capacity.
   - A **removed location** stays in the history, and its future appearances are dropped.
   - **Exceptions** (SKUs with no position) are refreshed, and ones that got a position since are closed.

The close writes a short summary for the coordinator, for example "Semana 2 cerrada: 2 revisitas agregadas (G-3: 27 movidos, B-5: 22), 1 estante nuevo (H-9) en semana 3, 14 movimientos menores ignorados". Weeks still to come are only modified by the close, never during the week.

### 5.3 Staffing changes
- **Planned changes** (a vacation, adding Monday) are entered in the config and applied by the close to the remaining weeks.
- **Unplanned changes** (an aux missing today) don't change the plan. That day's locations stay pending, the close reports them, and the coordinator can move them to a coming week with one action ("reprogramar pendientes").

### 5.4 Cycle end
The next cycle is generated from current inputs. Its draft starts with last cycle's pending locations.

**Cycle alignment:** all hubs use a global week index, with Monday Nov 9 as week 1 (Contry cycle 2). A hub that joins in global week 2 starts its rotation at block 2, so every hub is always in the same week.

## 6. Confirmation ingestion (generic Sheet → Supabase bridge)

**Apps Script in your Google account.** You have view access to the sheet; it's owned by mario@calii.com.

- **Trigger:** time-driven, daily at about 23:00 plus once before the weekly close. Hourly is possible later.
- **Reads only new rows** by row position: it keeps a row cursor in Supabase, reads from cursor+1 to the last row, and POSTs in batches of 2,000 to the Edge Function `sheet-ingest` with a shared secret. That way it never reads the whole tab.
- Rows are upserted on `src_key`, so re-sends are harmless.
- If the tab is ever trimmed or re-sorted, the script detects that the row count went down and re-syncs by `src_key` instead of position.
- **Generic by config**, so it can be reused for your other sheets:
  ```js
  SOURCES = [{ name:'ic_confirmaciones', sheetId:'1_Ddk3...', tab:'Download',
               keyCols:['Hub','sku','Actualización confirmación'],
               columns:{...header → field...}, target:'ic_conf_events' }]
  ```
  The Edge Function holds the whitelist of targets and column maps.
- **First run:** backfills from Sep 22. **Fallback:** CSV upload in Admin.

**Sheet size: this needs a decision soon.**
- `Download` holds about 96,750 rows × 55 columns, which is **about 5.3 M cells**. It grows by roughly 2,800 rows a day across 7 hubs, about 150 k cells a day.
- Google Sheets stops accepting data at **10 M cells per file**, counting all tabs. Unless rows are trimmed, the file will hit that limit in about **4 weeks or less** (early–mid December), depending on the other tabs' size.
- Once this bridge is running, Supabase holds the full history. The sheet could then keep only recent weeks, e.g. the last 8, with older rows deleted after the script confirms they're stored. That's a call for whoever owns the sheet, but it's the reason to get the bridge in place before December.

**Attribution:**
- `Hub` → hub_slug.
- `Registrado por` → role via `ic_logins`:
  - `aux.inventario.*` → aux_inv
  - `aux.calidad.*` → aux_cal
  - `aux.recepcion.csa`/`.zap` → aux_rec
  - `aux.turno.*` → lider_am / lider_pm by the `Turno` column (fallback: weekdays 06:00–14:00 = Día, after = Tarde)
  - Contry rule: `aux.calidad.con` + Abarrotes → aux_rec; + FyV → Calidad
  - Any other login (personal emails, e.g. the hub coordinator) → **`extra`**: not a plan role. It counts toward cycle coverage and appears in follow-up as "confirmado por coordinador (extra)", but it never counts as the assigned role doing its task.

**Matching (per location, since lists are locations):**
- **Location done** = at least `done_ratio` (default 80%) of the location's SKUs **expected with stock** were confirmed by the assigned role on the slot date. Up to `late_window_days` later counts as "tarde".
  - Shown as, for example, "G-3: 41/46 con stock, 52/60 total".
  - The thresholds are configurable, because a location list can't say exactly which SKUs the person was supposed to see.
- **Cycle coverage:** distinct SKUs confirmed by anyone, including `extra`. The total record count is shown separately.
- **Off-plan confirmations** (another role, or a location not scheduled that day) are listed separately.
- **Deltas:** `Delta Final` / `Delta $` aggregated per cycle and hub. This is Contry's cycle 1 vs cycle 2 test as a built-in report.

## 7. Screens (Spanish, hub picker at start, no remembered state)

1. **Configuración hub:**
   - Roles (capacity, days), workdays, logins.
   - Location rules with live preview ("23 códigos sin regla").
   - Freezer and cold-room groups. Cold room defaults to aisle `A`, Contry uses Q and W.
   - Thresholds: `moved_threshold`, `done_ratio`, `late_window_days`.
2. **Plan:**
   - Week × role × day grid of locations, with move actions in the draft and in future weeks at close time.
   - Load bars (total SKUs / expected with stock), overload banner, exceptions panel.
   - Weekly-close summaries.
3. **Ruta del día (the guide, read-only):** role + date. An ordered list of locations, each with `total SKUs` and `esperados con stock`, plus tags like "revisita" or "congeladores grupo A". **No item lists.**
4. **Seguimiento:**
   - Per location: done / late / pending / done by another role.
   - Cycle coverage, pending locations by owner, and SKUs never confirmed this cycle grouped by location (for the coordinator, not the daily route).
   - Deltas by cycle, and "reprogramar pendientes".
5. **Admin:** freshness of sorting / Masterview / confirmations (red when stale), import log, sheet row count vs the 10 M-cell limit, CSV fallback.

## 8. Acceptance tests

- **Replay:** Contry Oct 13–Nov 8 from `ic_conf_events` = **3,715 distinct SKUs, 8,868 records**. Already matches in the raw sheet.
- **Determinism:** same inputs give identical output.
- **Frozen weeks:** a sorting edit mid-week changes nothing in the current week.
- **Weekly close:**
  - 25 SKUs moved onto a visited shelf → a revisita is added to a coming week.
  - 5 moved → ignored and reported.
  - A new shelf is placed in a future week.
  - Past weeks are never rewritten.
- **Completeness:** every non-FyV SKU in the current sorting belongs to a scheduled location or an open exception after each close.
- **Freezers:** the split is within ±10% of half for kg and for pz, in every hub.
- **Coordinator confirmations:** they count toward coverage as `extra` and never mark a role's location done.
- **Config only:** a 3-aux hub with Monday added generates without code changes.

## 9. Open decisions

1. **`done_ratio`:** is 80% of the SKUs expected with stock the right bar for "location confirmed", or do you want it stricter?
2. **`col6`** in the sorting export: is it a position within the level? It would only matter for ordering inside a location, so it's low priority now.
3. **Sheet ownership and trimming:** see section 6. Taking over the daily `Download` update yourself (with a skill) and trimming old rows are both decisions to raise with Mario before December.

**Settled:** tier 0 = the `0` tag (`C` congelado, `F` frío and `N` nuevo are ignored). Cold room = aisle A by default, Contry Q and W. The coordinator's personal login = `extra`. Leads are split by the `Turno` column.
