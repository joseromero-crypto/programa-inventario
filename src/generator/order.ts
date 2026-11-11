// Physical order: aisles in the hub's walking order, then estante by number.
import type { Unit } from './types';

// Spanish alphabet: Ñ sorts right after N.
const ALPHABET = 'ABCDEFGHIJKLMNÑOPQRSTUVWXYZ';

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Default aisle order: letter by letter in the Spanish alphabet, then by length, then code. */
export function alphabeticalAisle(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const ia = ALPHABET.indexOf(a[i]!);
    const ib = ALPHABET.indexOf(b[i]!);
    if (ia !== ib) {
      if (ia === -1) return 1; // letters before symbols/digits
      if (ib === -1) return -1;
      return ia - ib;
    }
    if (ia === -1 && a[i] !== b[i]) return cmpStr(a[i]!, b[i]!);
  }
  return a.length - b.length || cmpStr(a, b);
}

/** Aisle comparator for a hub: listed aisles first in the given order, the rest alphabetically. */
export function aisleComparator(walkingOrder: string[]): (a: string, b: string) => number {
  const pos = new Map(walkingOrder.map((code, i) => [code.trim().toUpperCase(), i]));
  return (a, b) => {
    const pa = pos.get(a);
    const pb = pos.get(b);
    if (pa !== undefined && pb !== undefined) return pa - pb;
    if (pa !== undefined) return -1;
    if (pb !== undefined) return 1;
    return alphabeticalAisle(a, b);
  };
}

/** Estante: numbers ascending, then non-numeric codes; '' (whole aisle / sin estante) last. */
export function compareEstante(a: string, b: string): number {
  if (a === b) return 0;
  if (a === '') return 1;
  if (b === '') return -1;
  const na = /^\d+$/.test(a) ? Number(a) : NaN;
  const nb = /^\d+$/.test(b) ? Number(b) : NaN;
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb || cmpStr(a, b);
  if (!Number.isNaN(na)) return -1;
  if (!Number.isNaN(nb)) return 1;
  return cmpStr(a, b);
}

export function unitComparator(walkingOrder: string[]): (a: Unit, b: Unit) => number {
  const aisle = aisleComparator(walkingOrder);
  return (a, b) => aisle(a.aisle, b.aisle) || compareEstante(a.estante, b.estante) || cmpStr(a.key, b.key);
}

/** Number of times a sequence of units changes aisle (0 for one continuous aisle). */
export function aisleJumps(units: Pick<Unit, 'aisle'>[]): number {
  let jumps = 0;
  for (let i = 1; i < units.length; i++) if (units[i]!.aisle !== units[i - 1]!.aisle) jumps++;
  return jumps;
}
