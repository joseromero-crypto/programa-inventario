// The cycle's slot board: one slot per (week, day, role), with capacity = weekly capacity ÷ days.
import { addDays, globalWeek, isoWeekday } from '../lib/time';
import type { HubConfig, Layer, Role, RoleKey, Slot, Unit } from './types';

/** Roles that get plan slots: active and with capacity (aux_cal has 0: coverage only). */
export function planRoles(roles: Role[], hub: Pick<HubConfig, 'workdays'>): Role[] {
  return roles.filter((r) => r.active && r.weeklyCapacity > 0 && workdaysOf(r, hub).length > 0);
}

export function workdaysOf(role: Role, hub: Pick<HubConfig, 'workdays'>): number[] {
  return [...new Set(role.days)].filter((d) => hub.workdays.includes(d)).sort((a, b) => a - b);
}

export function buildSlots(hub: HubConfig, roles: Role[], cycleStart: string, anchorMonday: string): Slot[] {
  if (isoWeekday(cycleStart) !== 1) throw new Error(`cycleStart ${cycleStart} is not a Monday`);
  const slots: Slot[] = [];
  for (let w = 1; w <= hub.cycleWeeks; w++) {
    const monday = addDays(cycleStart, 7 * (w - 1));
    const gw = globalWeek(anchorMonday, monday);
    for (const role of planRoles(roles, hub)) {
      const days = workdaysOf(role, hub);
      for (const dow of days) {
        slots.push({ week: w, globalWeek: gw, day: addDays(monday, dow - 1), role: role.key, capacity: role.weeklyCapacity / days.length, extra: false, items: [], notes: [] });
      }
    }
  }
  return slots.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0) || roleOrder(roles, a.role) - roleOrder(roles, b.role));
}

function roleOrder(roles: Role[], key: RoleKey): number {
  return roles.findIndex((r) => r.key === key);
}

export const used = (s: Slot) => s.items.reduce((t, i) => t + i.load, 0);
export const free = (s: Slot) => Math.max(0, s.capacity - used(s));

/** Capacity left across slots, overflow included (negative when the slots are over capacity). */
export const slack = (slots: Slot[]) => slots.reduce((t, s) => t + s.capacity - used(s), 0);

export function addItem(slot: Slot, unit: Unit, layer: Layer): void {
  slot.items.push({ unitKey: unit.key, layer, load: unit.load, count: unit.count });
}

/**
 * Put units, in order, into a role's days for one week: fill the first day, then the next.
 * A unit that doesn't fit in what's left of a day starts the next day; the last day takes the rest.
 */
export function packSequential(units: Unit[], slots: Slot[], layer: Layer): void {
  let i = 0;
  for (const u of units) {
    while (i < slots.length - 1 && used(slots[i]!) > 0 && u.load > free(slots[i]!) + 1e-9) i++;
    const s = slots[i];
    if (s) addItem(s, u, layer);
  }
}

export function roleWeekSlots(slots: Slot[], role: RoleKey, week: number): Slot[] {
  return slots.filter((s) => s.role === role && s.week === week && !s.extra);
}
