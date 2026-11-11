// The load report: what each layer costs, how loaded each role is, what's left for weekly tiers,
// and, when something doesn't fit, the smallest fix. Messages are in Spanish for the UI.
import { aisleJumps } from './order';
import type { FreezerSplit } from './layers/freezers';
import { coveragePhrase, type HighRotation } from './layers/highRotation';
import type { Section } from './layers/rotation';
import type { Tier0Route } from './layers/tier0';
import type { ExceptionCode, HubConfig, Layer, LayerSummary, LoadReport, PlanException, Role, RoleLoad, Slot, TierCoverage, Unit } from './types';

const LAYERS: Layer[] = ['tier0', 'freezer', 'rotation', 'tier_weekly', 'unidentified'];
const CODES: ExceptionCode[] = ['NO_POSITION', 'AISLE_ONLY', 'UNKNOWN_CODE', 'FROZEN_NO_FREEZER', 'NOT_IN_MV', 'DUP_POSITION'];

export interface ReportInput {
  hub: HubConfig;
  roles: Role[]; // plan roles
  slots: Slot[];
  units: Unit[];
  exceptions: PlanException[];
  route: Tier0Route;
  freezers: FreezerSplit;
  high: HighRotation;
  spare: number; // cycle capacity left after layers 1–3 (negative = overload)
  candidates: Unit[]; // rotation candidates before layer 4
  sections: Section[];
  ownerWeekly: number;
}

const r0 = (n: number) => Math.round(n);
const fmt = (n: number) => r0(n).toLocaleString('en-US');
const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

export function buildReport(x: ReportInput): LoadReport {
  const W = x.hub.cycleWeeks;
  const plan = x.slots.filter((s) => !s.extra);
  const items = plan.flatMap((s) => s.items);
  const cycleCapacity = sum(plan.map((s) => s.capacity));
  const cycleLoad = sum(items.map((i) => i.load));
  const unitByKey = new Map(x.units.map((u) => [u.key, u]));

  const layers: LayerSummary[] = LAYERS.map((layer) => {
    const its = x.slots.flatMap((s) => s.items).filter((i) => i.layer === layer);
    const keys = new Set(its.map((i) => i.unitKey));
    const cl = sum(its.map((i) => i.load));
    return { layer, units: keys.size, skus: r0(sum([...keys].map((k) => (unitByKey.get(k)?.count ?? 0) + (unitByKey.get(k)?.looseCount ?? 0)))), perWeek: cl / W, cycleLoad: cl };
  });

  const roles: RoleLoad[] = x.roles.map((role) => {
    const mine = plan.filter((s) => s.role === role.key);
    const byLayer = Object.fromEntries(LAYERS.map((l) => [l, 0])) as Record<Layer, number>;
    for (const i of mine.flatMap((s) => s.items)) byLayer[i.layer] += i.load;
    const cap = sum(mine.map((s) => s.capacity));
    const assigned = sum(Object.values(byLayer));
    const sec = x.sections.find((s) => s.role === role.key);
    const section = sec?.first ? `${sec.first} → ${sec.last}${sec.carnes ? ` + ${sec.carnes} de Carnes` : ''}` : sec?.carnes ? `${sec.carnes} de Carnes` : '';
    return { role: role.key, label: role.label, cycleCapacity: cap, assigned, byLayer, over: Math.max(0, assigned - cap), section };
  });

  const aisleJumpsList = plan
    .filter((s) => s.items.some((i) => i.layer === 'rotation'))
    .map((s) => ({ role: s.role, day: s.day, jumps: aisleJumps(s.items.filter((i) => i.layer === 'rotation').map((i) => unitByKey.get(i.unitKey)!)) }));

  const exceptions = Object.fromEntries(CODES.map((c) => [c, 0])) as Record<ExceptionCode, number>;
  for (const e of x.exceptions) exceptions[e.code]++;

  const unidentified = x.units.filter((u) => u.kind === 'unidentified');
  // Overload is a hub-level shortfall. Per-role overs (shelves are never split) show in roles[].
  const over = Math.max(0, Math.round(cycleLoad - cycleCapacity));
  const fix = over > 0 ? smallestFix(over, x, roles) : null;
  const shorterCycle = fitsIn(x);
  const leftoverWeekly = Math.max(0, x.spare) / W;

  const messages: string[] = [];
  messages.push(`Tier 0: ${x.route.covered} de ${x.route.tier0Skus} SKUs en la ruta semanal` + (x.route.uncovered.length ? ` (${x.route.uncovered.length} estantes no caben y quedan en la rotación mensual).` : '.'));
  messages.push(`Capacidad sobrante para tiers semanales: ${fmt(leftoverWeekly)} SKUs por semana → ${coveragePhrase(x.high.coverage)}.`);
  if (x.high.units.length) messages.push(`Estantes de tiers semanales: ${fmt(x.high.usefulSkus)} SKUs útiles de ${fmt(x.high.totalSkus)} SKUs totales.`);
  if (!x.high.coverage.some((c: TierCoverage) => c.total > 0 && c.coveredWeekly >= c.total) && over === 0)
    messages.push('Casi no hay capacidad para tiers semanales. Opciones: subir la capacidad de los líderes (240 → 300) o tier 1 cada 2 semanas.');
  if (unidentified.length) messages.push(`Ubicaciones sin identificar: ${fmt(sum(unidentified.map((u) => u.count)))} SKUs en ${unidentified.length} códigos (bloque extra del aux. de inventarios).`);
  if (fix) messages.push(fix);
  for (const r of roles) {
    if (r.over > 0.05 * r.cycleCapacity) messages.push(`${r.label} queda ${fmt(r.over)} SKUs arriba de su capacidad del ciclo (${fmt(r.assigned)} de ${fmt(r.cycleCapacity)}).`);
  }
  if (shorterCycle !== null) messages.push(`Con la capacidad actual, el ciclo completo cabe en ${shorterCycle} semanas.`);

  return {
    basis: x.hub.sizingBasis,
    cycleCapacity,
    cycleLoad,
    layers,
    roles,
    tier0: { skus: x.route.tier0Skus, covered: x.route.covered, uncoveredShelves: x.route.uncovered.map((u) => u.key), budget: x.route.budget },
    freezers: { a: x.freezers.a.map((u) => u.key), b: x.freezers.b.map((u) => u.key), kg: x.freezers.kg, pz: x.freezers.pz },
    weekly: { leftoverBeforeTiers: leftoverWeekly, tierCoverage: x.high.coverage, usefulSkus: x.high.usefulSkus, totalSkus: x.high.totalSkus },
    unidentified: { codes: unidentified.length, skus: sum(unidentified.map((u) => u.count)) },
    exceptions,
    aisleJumps: aisleJumpsList,
    overload: { over, fix },
    shorterCycle,
    messages,
  };
}

/**
 * Smallest single change that removes the overload: raise the most overloaded role's weekly
 * capacity by just enough. Adding Monday is offered as the alternative when the hub doesn't work it.
 */
function smallestFix(over: number, x: ReportInput, roles: RoleLoad[]): string {
  const W = x.hub.cycleWeeks;
  const worst = [...roles].sort((a, b) => b.over - a.over)[0]!;
  const role = x.roles.find((r) => r.key === worst.role)!;
  const need = Math.ceil(over / W);
  let msg = `Sobrecarga: faltan ${fmt(over)} SKUs en el ciclo (todo sigue asignado; el ciclo no se alarga). Arreglo más chico: subir la capacidad de ${role.label} de ${role.weeklyCapacity} a ${role.weeklyCapacity + need} SKUs por semana.`;
  if (!x.hub.workdays.includes(1)) {
    const monday = sum(x.roles.map((r) => r.weeklyCapacity / Math.max(1, r.days.filter((d) => x.hub.workdays.includes(d)).length))) * W;
    msg += monday >= over ? ` Otra opción: agregar lunes (+${fmt(monday)} SKUs por ciclo).` : ` Agregar lunes ayuda pero no alcanza (+${fmt(monday)} SKUs por ciclo).`;
  }
  return msg;
}

/** Fewest weeks (below cycle_weeks) the full cycle would fit in: weekly layers every week + rotation once. */
function fitsIn(x: ReportInput): number | null {
  const weeklyCap = sum(x.roles.map((r) => r.weeklyCapacity));
  const tier0 = sum(x.route.units.map((u) => u.load));
  const freezerAvg = (sum(x.freezers.a.map((u) => u.load)) + sum(x.freezers.b.map((u) => u.load))) / 2;
  const rotation = sum(x.candidates.map((u) => u.load));
  for (let w = 1; w < x.hub.cycleWeeks; w++) if (w * (tier0 + freezerAvg) + rotation <= w * weeklyCap) return w;
  return null;
}
