# Inventario Conf: hub planning rules (draft)

Contry is the pilot, **not the template**. Every hub runs the same generator code, but each hub gets its own **profile**: staff, days and which layers it uses. This file defines the rules the generator follows to build a proper plan per hub.

## 1. Hub profiles

| Profile | Hubs | Staff for the plan | Days | Notes |
|---|---|---|---|---|
| Contry (pilot) | mh-contry | 4: aux_inv, lider_am, lider_pm, aux_rec | Tue–Fri | Mondays are heavy (aux_inv/leads help with assembly) |
| MTY standard | mh-cumbres, mh-san-nicolas, mh-guadalupe, mh-avicola | 3: aux_inv, lider_am, lider_pm | Mon–Fri | One aux fewer → one extra day |
| Centro/Oeste | mh-condesa, mh-zapopan | 4: aux_inv, lider_am, lider_pm, aux_rec | Mon–Fri | Most capacity of all hubs. Start on a 4-week cycle; may move to 3 weeks later (section 1.1) |

A profile is only a starting config. Each hub can still edit staff, days and capacity.

### 1.1 Cycle length per hub
- `cycle_weeks` is a hub setting, default 4. Condesa and Zapopan may go to 3 once a 4-week cycle shows spare capacity.
- The load report will say when a hub could fit a shorter cycle: "con la capacidad actual, el ciclo completo cabe en 3 semanas".
- Follow-up stays comparable because weeks keep the global index (week of the year from Nov 9). A 3-week hub's cycle just starts every 3rd week. Hubs then won't always be on the same cycle week, but they're always on the same calendar week.

## 2. The plan is built in layers, in this order

The generator fills capacity layer by layer and reports what's left at each step.

| # | Layer | Cadence | Owner | Rule |
|---|---|---|---|---|
| 1 | **Tier 0** (careful products) | Weekly, every hub | aux_inv | Fixed route. Shelves ranked by number of tier-0 SKUs, plus the cold room. Same at every hub. |
| 2 | **Freezers** | Every 2 weeks | aux_inv | Half the freezers each week, balanced so each half holds ~50% of kg and ~50% of pz SKUs. **Tiers are not used for freezers.** |
| 3 | **Monthly rotation** (all remaining locations) | Once per 4-week cycle | everyone | Mandatory: full coverage. Physical order (section 3). |
| 4 | **High-rotation tiers** (tier 1, then 2, then 3…) | Weekly, auto | aux_inv first, then leads | **Fills automatically** with the capacity left after layers 1–3, adding tiers in sales order until the budget runs out. Same rule at every hub, Contry included: a hub with no spare capacity simply gets an empty layer 4. Abarrotes only. |

Why this order: tier 0 and full monthly coverage are commitments. The tier 1+ weekly layer is the best use of *extra* capacity, but it must never eat into the monthly rotation. Otherwise some shelves go unvisited, which is the Contry cycle 1 problem.

### 2.1 Tier source and stability
- Tier numbers 1–8 are a sales rank (1 = sells most). The `0` tag = tier 0. The letters `C`, `F` and `N` are ignored.
- **Stored format** (checked after the first upload, 2026-11-11): `mv_product_city.tiers` holds the raw cell, a `; `-separated list of tags, e.g. `4`, `5.1`, `1; 0`, `3; 0; F`. Parse it as: split on `;`, trim; a `1`–`8` tag, optionally with a sub-tier (`5.1`, `5.2`, `6.1`, …), is the sales tier, and sub-tiers sort by their number (5.1 before 5.2). `0` is a separate flag on top of a sales tier, so a tier-0 SKU also has a tier 1–8. **Tier 0 wins:** a tier-0 SKU belongs to tier 0 only. It is ignored for every tier 1–8 count (layer 4 shelf ranking, `tier_order` shelf scores, "SKUs útiles"), so it is planned once. Sub-tiers exist because tiers 5 and 6 are large: 5.1 sells more than 5.2 and is added first. Join on `lower(mv_product_city.city) = ic_hub_config.city`.
- First upload: every SKU has a value; tier 0 = 183 Monterrey, 175 Saltillo, 171 CDMX, 169 Guadalajara; 8 Monterrey and 2 Guadalajara SKUs have only letter tags (no sales tier).
- **Tiers are per city and live in Masterview.** Each city export (Monterrey, Saltillo, CDMX, Guadalajara) has its own `Tiers` column. They update by themselves upstream, every week or two.
- **Hub → city:** Contry, Cumbres, Guadalupe and San Nicolás → monterrey. Avícola → saltillo. Condesa → cdmx. Zapopan → guadalajara.
- **Not stored yet:** the shared import (`mv_product_city`) only keeps the columns the apps use today, and `Tiers` isn't one of them. Fix it in two steps:
  1. Add a `tiers text` column to `mv_product_city`.
  2. Have the Masterview admin upload, which lives in **invoice-reader**, save it. That's a small change in the invoice-reader repo; see phase 0, step 0.2.7.
- Tiers are only as fresh as the latest Masterview upload. The weekly close uses whatever tiers are stored at close time, and the Admin › Fuentes page shows the Masterview upload date.
- The generator reads tiers through one `tierSource(hub)` function, so switching the source later doesn't touch the plan logic.
- **Refresh:** layer 4 is **recalculated automatically at each weekly close** with the latest tiers, for the following week only. The current week never changes. Tier 0 changes rarely, so the tier-0 route is refreshed only at cycle start.

### 2.2 Keeping the tier layer physical
- The route is locations-only, so tier 1+ is not a scattered SKU list. As with tier 0, it is turned into **shelves**:
  - Rank shelves by their count of tier-N SKUs (with stock estimate).
  - Add the densest shelves first.
- A shelf picked by tier 0 or tier 1 is visited as a whole shelf. Its low-tier SKUs get counted too, which costs capacity. The load report shows "SKUs útiles" (tier-targeted) vs "SKUs totales" so the trade-off is visible.
- A shelf already in the weekly layer is removed from the monthly rotation, so it isn't counted twice.

### 2.3 What the extra day really buys (MTY standard)
- A rough estimate from Contry's numbers: losing aux_rec removes ~300 SKUs/week of rotation capacity. Adding Monday for 3 people adds roughly aux_inv ~175 + 2 leads × ~60 = **~295/week**.
- **So Monday may mostly replace the missing aux, leaving little room for layer 4.**
- The generator computes the real number per hub from that hub's SKU counts, tiers and capacities, and shows it as: "Capacidad sobrante para tiers semanales: N SKUs → alcanza tier 1 completo + 40% de tier 2".
- If the leftover is near zero, the options are: raise capacity (leads 240 → 300), or accept tier 1 every 2 weeks instead of weekly.

### 2.4 Unidentified locations (temporary)
- Locations whose code matches no rule ("códigos sin regla", e.g. Condesa `CAM-2`, Zapopan `6`) are **not** left out of the plan.
- For now they all go into one extra group, **"Ubicaciones sin identificar"**, scheduled as its own extra slot (an extra day or block, owner aux_inv by default) so those SKUs still get covered.
- The group is a stopgap: as rules are added for each code, its locations move into the normal layers and the group shrinks. The load report shows its size per hub.

## 3. Physical-order rule (`physical` mode, the default)

Hard rules for the monthly rotation and for any layer that assigns shelves to a person's day:

1. **A person's day is one contiguous run in physical order:** A1 → A2 → A3 …. The next shelf is always the next one in the same aisle.
2. **An aisle jump happens only when an aisle ends.** The run continues in the next aisle in the hub's walking order. No A1, G5, F6.
3. **The next day continues where the previous day stopped.** Each role "walks" its own section of the hub across the cycle.
4. **Sections per role:** the hub is cut into contiguous sections sized to each role's cycle capacity, e.g. aux_rec A–D, lider_am E–H, lider_pm I–Q. A role keeps its section in every cycle, unless the coordinator rotates sections between cycles.
5. **Walking order** is a per-hub setting: the list of aisles in the order people actually walk. It defaults to alphabetical and is editable, since hubs don't always run A→Z physically.
6. **Fixed-layer shelves** (tier 0, tier 1+) are skipped in the rotation. The run just steps over them.

`physical` is the default because a physical route is faster, easier and more accurate.

### 3.1 Rotation modes (setting `rotation_mode`, per hub)

**`physical` (default).** Everything in section 3. Each role walks its section A1 → A2 → … across the cycle.

**`tier_order` (built in v1, off by default, can be switched on per hub).** Weeks go from best sellers to slowest sellers, regardless of where the shelves are. Shelves are always taken complete, so what gets ranked is **shelves, not SKUs**:

1. **Score each shelf in the rotation** by the tiers of its SKUs: the average tier of its SKUs with tier 1–8, where lower means sells more. SKUs without a tier don't count. A shelf with no tiered SKUs goes to the end.
   - Ties break on physical order (aisle, estante), so the result is deterministic.
2. **Rank shelves** from best score to worst.
3. **Cut the ranked list into 4 consecutive groups of equal load**, i.e. equal SKUs (or SKUs with stock, per `sizing_basis`), not equal shelf counts.
   - Week 1 = top group (tiers ~1–2), week 4 = bottom group (tiers ~7–8).
   - With `cycle_weeks` = 3, the list is cut into 3 groups.
4. **Inside each week, go back to physical order.** The week's shelves are sorted by walking order and split into day-sized runs per role, so each day is as compact as possible even if it isn't one continuous aisle. The load report shows the number of aisle jumps per day.
5. **What it's for:** if a week has to be cut short, cut the last week, which only holds slow sellers.

Both modes share layers 1, 2 and 4 (tier 0, freezers, weekly bestsellers). Only layer 3 (the monthly rotation) changes. A hub can switch modes at a cycle start, never mid-cycle.

## 4. Per-hub setup checklist (before generating a hub's first plan)

- [ ] Profile chosen, staff and capacities confirmed.
- [ ] Workdays confirmed.
- [ ] `cycle_weeks` and `rotation_mode` chosen.
- [ ] Walking order of aisles set.
- [ ] Cold-room aisle(s) set (default A).
- [ ] Location rules reviewed: zero "códigos sin regla", or exceptions accepted.
- [ ] Freezer list confirmed.
- [ ] Tier set frozen for the cycle (counts per tier shown).
- [ ] Load report reviewed: layers 1–3 fit, plus how much of layer 4 fits.

## 5. Open questions

No open questions left in this file.

**Settled:**
- Tiers: per city, from Masterview (`mv_product_city.tiers`, to be added).
- `rotation_mode`: `physical` by default; `tier_order` (shelves ranked by tier, split into equal-load weeks) is built and can be switched on per hub.
- Condesa and Zapopan work Mon–Fri with 4 aux.
- Layer 4 fills automatically, per hub, recalculated weekly.
- Same rules at every hub.
- Freezers ignore tiers (kg/pz split only).
