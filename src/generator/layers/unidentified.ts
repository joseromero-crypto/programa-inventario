// "Ubicaciones sin identificar" (hub-rules 2.4): locations whose code matches no rule. Temporary:
// they get one extra block (owner aux_inv) in the cycle so their SKUs are still covered. As rules
// are added for each code, its locations move into the normal layers and this group shrinks.
import { addItem, roleWeekSlots } from '../calendar';
import type { RoleKey, Slot, Unit } from '../types';

export function buildUnidentifiedSlot(units: Unit[], slots: Slot[], owner: RoleKey, week: number): Slot | null {
  if (units.length === 0) return null;
  const weeks = [...new Set(slots.map((s) => s.week))];
  const w = weeks.includes(week) ? week : (weeks[0] ?? 1);
  const anchor = roleWeekSlots(slots, owner, w)[0];
  if (!anchor) return null;
  const slot: Slot = { week: w, globalWeek: anchor.globalWeek, day: anchor.day, role: owner, capacity: 0, extra: true, items: [], notes: ['Bloque extra: ubicaciones sin identificar'] };
  for (const u of units) addItem(slot, u, 'unidentified');
  slot.capacity = slot.items.reduce((s, i) => s + i.load, 0);
  return slot;
}
