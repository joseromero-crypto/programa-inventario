// Layer 2: freezers, every 2 weeks (hub-rules 2, spec 4.4). Two halves, each with ~50% of the
// kg SKUs and ~50% of the pz SKUs. Tiers are not used. Group A runs on odd global weeks, B on even.
import type { Unit } from '../types';

export interface FreezerSplit {
  a: Unit[];
  b: Unit[];
  kg: [number, number];
  pz: [number, number];
}

const kgOf = (u: Unit) => u.skus.filter((s) => s.unit === 'kg').length;
const pzOf = (u: Unit) => u.count - kgOf(u);

export function splitFreezers(freezers: Unit[]): FreezerSplit {
  const items = [...freezers].sort((x, y) => y.count - x.count || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  const kg = items.map(kgOf);
  const pz = items.map(pzOf);
  const totKg = kg.reduce((s, v) => s + v, 0);
  const totPz = pz.reduce((s, v) => s + v, 0);
  const cost = (inA: boolean[]) => {
    let ka = 0;
    let pa = 0;
    let na = 0;
    inA.forEach((f, i) => {
      if (f) {
        ka += kg[i]!;
        pa += pz[i]!;
        na++;
      }
    });
    const dk = totKg ? (ka - totKg / 2) / totKg : 0;
    const dp = totPz ? (pa - totPz / 2) / totPz : 0;
    const dn = items.length ? (na - items.length / 2) / items.length : 0;
    return dk * dk + dp * dp + 1e-3 * dn * dn; // freezer count only breaks near-ties
  };

  // Greedy start: biggest first, into the half that lowers the imbalance most (A on ties).
  const inA: boolean[] = [];
  items.forEach((_, i) => {
    inA[i] = true;
    const ca = cost(inA.map((v, j) => (j <= i ? v : false)));
    inA[i] = false;
    const cb = cost(inA.map((v, j) => (j <= i ? v : false)));
    inA[i] = ca <= cb;
  });

  // Then single moves and pairwise swaps while the imbalance keeps dropping.
  for (let guard = 0; guard < 1000; guard++) {
    let best = cost(inA);
    let move: number[] | null = null;
    for (let i = 0; i < items.length; i++) {
      inA[i] = !inA[i];
      const c = cost(inA);
      inA[i] = !inA[i];
      if (c < best - 1e-12) [best, move] = [c, [i]];
      for (let j = i + 1; j < items.length; j++) {
        if (inA[i] === inA[j]) continue;
        inA[i] = !inA[i];
        inA[j] = !inA[j];
        const c2 = cost(inA);
        inA[i] = !inA[i];
        inA[j] = !inA[j];
        if (c2 < best - 1e-12) [best, move] = [c2, [i, j]];
      }
    }
    if (!move) break;
    for (const i of move) inA[i] = !inA[i];
  }

  const a = items.filter((_, i) => inA[i]);
  const b = items.filter((_, i) => !inA[i]);
  const sum = (us: Unit[], f: (u: Unit) => number) => us.reduce((s, u) => s + f(u), 0);
  const byKey = (x: Unit, y: Unit) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0);
  return { a: a.sort(byKey), b: b.sort(byKey), kg: [sum(a, kgOf), sum(b, kgOf)], pz: [sum(a, pzOf), sum(b, pzOf)] };
}

/** Which half a global week visits: A on odd weeks, B on even, so it alternates across cycles too. */
export const freezerHalfFor = (globalWeek: number): 'a' | 'b' => (globalWeek % 2 === 1 ? 'a' : 'b');
