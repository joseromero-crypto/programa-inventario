// Contiguous cutting: split an ordered list into consecutive groups whose loads follow given
// targets (proportionally), never splitting an item. Used for role sections, weeks and days.

/**
 * Returns, for each item, the index of the group it falls in. Groups are contiguous and in order.
 * Targets are relative: the total load is shared out in proportion to them. An item goes to the
 * group its midpoint falls in, so each cut lands as close as possible to the ideal boundary.
 * Groups with a zero target get nothing (unless every target is zero: then shares are equal).
 */
export function cutSequence(loads: number[], targets: number[]): number[] {
  const groups = targets.length;
  if (groups === 0) return loads.map(() => -1);
  const total = loads.reduce((s, l) => s + l, 0);
  const sumT = targets.reduce((s, t) => s + Math.max(0, t), 0);
  const weights = sumT > 0 ? targets.map((t) => Math.max(0, t) / sumT) : targets.map(() => 1 / groups);

  const bounds: number[] = [];
  let acc = 0;
  for (const w of weights) bounds.push((acc += w * total));

  const out: number[] = [];
  let cum = 0;
  let k = 0;
  for (const load of loads) {
    while (k < groups - 1 && cum + load / 2 > bounds[k]! + 1e-9) k++;
    out.push(k);
    cum += load;
  }
  return out;
}

/** Same as cutSequence, returning the groups themselves. */
export function cutInto<T>(items: T[], load: (t: T) => number, targets: number[]): T[][] {
  const idx = cutSequence(items.map(load), targets);
  const out: T[][] = targets.map(() => []);
  items.forEach((it, i) => out[idx[i]!]?.push(it));
  return out;
}
