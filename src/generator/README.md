Phase 1: pure plan generator (no I/O, deterministic, unit-tested). Rules: `docs/inventarioConf-hub-rules.md`
(wins over the v1 plan where they differ), spec section 4.

## Entry point

`generate(input: GeneratorInput): Plan` in `generate.ts`. Same input → same plan. No clock, no network;
dates come from `cycleStart` / `anchorMonday` through `src/lib/time.ts`.

Input: hub config (city, workdays, `cycle_weeks`, `rotation_mode`, walking order, sizing basis), roles,
location rules, sorting rows, Masterview products (sku, barcode, kg/pz, category), Masterview tier rows
(`mv_product_city`), stock estimates, cycle start and the global week-1 Monday.

Output: units (locations with SKU counts), slots (week, global week, day, role, capacity, ordered items
tagged by layer, notes), exceptions, and the load report (with Spanish messages for the UI).

## Modules

| File | What it does |
|---|---|
| `types.ts` | Input / output types |
| `tiers.ts` | Parses the Tiers cell; `tierSource(hub, rows)` is the only way the plan reads tiers |
| `match.ts` | Sorting row → Masterview product: SKU, then name, then barcode |
| `normalize.ts` | Sorting rows → locations + exceptions; FyV dropped |
| `order.ts` | Walking order (Spanish alphabet by default), estante order, aisle jumps |
| `cut.ts` | Contiguous cutting by load targets; used for sections, weeks and days |
| `calendar.ts` | Slot board: capacity per day = weekly capacity ÷ the role's workdays |
| `layers/tier0.ts` | Layer 1: cold room + shelves ranked by tier-0 SKUs, within budget |
| `layers/freezers.ts` | Layer 2: two halves balanced on kg and pz SKUs; A on odd global weeks |
| `layers/rotation.ts` | Layer 3: `physical` sections per role, or `tier_order` weeks |
| `layers/highRotation.ts` | Layer 4: tier 1, 2, … 5.1, 5.2 … shelves with spare capacity only |
| `layers/unidentified.ts` | "Ubicaciones sin identificar" extra block |
| `report.ts` | Load report, leftover message, overload + smallest fix, shorter-cycle hint |

## Decisions taken while building

- **Matching to Masterview.** The Calii SKU (3 letters + 3 digits) is the identity in the plan. The sorting file has no
  SKU, so a row is matched by SKU if it ever has one, then by exact name (ignoring case, accents and spaces), and
  only then by barcode (leading zeros ignored). Barcodes can be wrong, change, be missing, and Calii reuses some
  (one barcode on a cookie and a gelato). Contry, 2026-11-11: 4,491 rows by name, 23 only by barcode, 5 not found
  (was 155 not found by barcode). The report counts each and names the barcode-only ones as a name mismatch.

- **Locations.** A shelf is `aisle-estante` (`G-10`). Freezers and cold rooms are whole units; the cold room stays
  as the halves the location rules give (Contry: Q and W), never split further. Codes without a rule become
  `Sin identificar: <code>`.
- **Sin estante.** A SKU with an aisle but no estante has no spot in Retool but sits on some shelf of that aisle, so it
  gets confirmed when the aisle's shelves are visited. It adds load (`looseCount`, spread over the aisle's shelves by
  their SKU count) but no stop of its own. Only an aisle with no shelves at all keeps one `G (sin estante)` stop.
- **Category** (FyV / Carnes / Abarrotes) comes from Masterview's Assembly Category (`ic_mv_products`, 6th field;
  the name is the 7th, migration 0007).
- **Frozen SKUs** (temp below 0) that aren't in a freezer are `FROZEN_NO_FREEZER`, owned by aux_inv, noted on the
  first freezer day of week 1. They don't count as shelf load.
- **Stock basis.** `positive` sizing: a SKU counts 1 with stock, 0 without, and the hub's ratio when unknown.
- **Tier-0 budget** = aux_inv weekly capacity − the larger freezer half (editable via `tier0Budget`). Shelves that
  don't fit stay in the monthly rotation and are listed in the report.
- **Layer 4 cost.** A shelf visited weekly costs `load × (cycle_weeks − 1)` per cycle (it leaves the rotation).
  Within a tier, shelves that don't fit are skipped; the next tier is only tried once the current one is complete.
  Shelves go to aux_inv first (up to its smallest weekly free capacity), then lider_am, lider_pm, then the rest.
- **Rotation sections** are sized so every role ends with the same fill ratio. aux_inv's section is last in the
  walk and also takes the Carnes locations (more than half of their SKUs are Carnes).
- **Overload.** Everything is still assigned and the cycle is never extended. The fix offered is the smallest single
  capacity raise that covers the gap, plus "agregar lunes" when the hub doesn't work Mondays.

## Notes for later (found in phase 1)

1. **Tier-0 products missing from sorting.** Of 183 Monterrey tier-0 products, 126 are FyV (out of the plan) and 21 are
   Calii Fresh items (filed as Carnes) that don't appear in Contry's sorting at all, so they have no location to plan.
   If they live in the cold room they're covered anyway, since the cold room is on the weekly route.
2. **Contry aisle Z** has 48 of 52 SKUs frozen: possibly a freezer. To be checked with the coordinator, then a location
   rule added.
3. **Weekly close** (spec 5) isn't built. It should reuse `cut.ts` / `calendar.ts` placement with past and current
   weeks locked, and recompute layer 4 for the next week.
4. **Carnes on aux_inv** can push aux_inv slightly over. Shown in the report.

Plan storage is ready (`0006_ic_plan_storage.sql`): up to 8 weeks, global week, extra block, layer, load and
sin-estante share per location.
