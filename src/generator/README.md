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

- **Locations.** A shelf is `aisle-estante` (`G-10`). Rows with an aisle but no estante become one stop per aisle,
  `G (sin estante)`, walked at the end of that aisle (plus an `AISLE_ONLY` exception), so they're covered.
  Freezers and cold rooms are whole units. Codes without a rule become `Sin identificar: <code>`.
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

1. **Tier 0 without barcodes.** 146 of 183 Monterrey tier-0 SKUs have no barcode in `mv_products`, so sorting
   can't place them. Most are FyV (out of the plan), but a few aren't (for example a Calii Fresh item filed under
   Carnes). Contry's tier-0 route reaches 35 SKUs.
2. **Contry aisle Z** has 48 of 52 SKUs frozen: it looks like a freezer area without a location rule. Together
   with the frozen SKUs that have no position, that's 123 `FROZEN_NO_FREEZER`. Review in the location rules.
3. **Cold room on the weekly route.** Contry's Q + W cold room is ~378 SKUs/week of aux_inv's 700, and Q alone is
   bigger than one day. Splitting the cold room into parts (spec 4.1, "partes 1/2") would even out aux_inv's days.
4. **Category for never-confirmed SKUs.** Category (FyV / Carnes / Abarrotes) comes from the latest confirmation;
   658 of Contry's SKUs have none and are planned as Abarrotes. A Masterview category column would fix this.
5. **Persisting plans (schema, next phase).** `ic_slots.week` is limited to 1–4 but `cycle_weeks` allows up to 8;
   `ic_slot_units.unit_kind` doesn't allow `aisle_only` / `unidentified`; there's no layer column and no flag for
   the extra block. Needs a 0006 migration before plans are saved.
6. **Weekly close** (spec 5) isn't built. It should reuse `cut.ts` / `calendar.ts` placement with past and current
   weeks locked, and recompute layer 4 for the next week.
7. **Carnes on aux_inv** can push aux_inv slightly over (Contry: +13 SKUs per cycle). Shown in the report.
