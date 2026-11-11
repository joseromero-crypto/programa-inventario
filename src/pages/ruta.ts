// Hub › Ruta del día (spec 7.3): read-only guide. Role + date → the active plan's locations in
// walking order, each with total SKUs and SKUs expected with stock, plus tags. No item lists.
import type { RoleKey } from '../generator/types';
import { syncServerNow } from '../lib/sources/clock';
import { fetchHubConfig, type RoleRow } from '../lib/plan/inputs';
import { byWalk, slotTotals, unitTags, type ViewPlan, type ViewSlot } from '../lib/plan/model';
import { fetchActivePlanHead, fetchPlan } from '../lib/plan/store';
import { formatDay } from '../lib/time';
import type { HubRef } from '../router';
import { errorBox, esc, fmtInt, header, icons } from '../ui';

interface State {
  hub: HubRef;
  roles: RoleRow[];
  plan: ViewPlan;
  today: string;
  days: string[];
  day: string;
  role: RoleKey | null;
}

export async function renderRuta(root: HTMLElement, hub: HubRef): Promise<void> {
  root.innerHTML = `
    <main class="c-page">
      ${header({ title: 'Ruta del día', sub: hub.display_name, back: hub.display_name })}
      <div class="ic-stack" id="ruta"><div class="c-skeleton" style="height:44px"></div><div class="c-skeleton" style="height:120px"></div><div class="c-skeleton" style="height:360px"></div></div>
    </main>`;
  const box = root.querySelector<HTMLElement>('#ruta')!;
  try {
    const [today, { roles }, head] = await Promise.all([syncServerNow(), fetchHubConfig(hub.hub_slug), fetchActivePlanHead(hub.hub_slug)]);
    if (!head) {
      if (box.isConnected) box.innerHTML = `<div class="c-empty">${esc(hub.display_name)} no tiene un plan activo. El coordinador lo genera y lo activa en Plan.</div>`;
      return;
    }
    const plan = await fetchPlan(head);
    if (!box.isConnected) return;
    const days = [...new Set(plan.slots.map((s) => s.day))].sort();
    const day = days.find((d) => d >= today) ?? days[days.length - 1] ?? today;
    const st: State = { hub, roles, plan, today, days, day, role: null };
    pickRole(st);
    paint(box, st);
  } catch (e) {
    if (box.isConnected) box.innerHTML = errorBox('No se pudo cargar la ruta', (e as Error).message);
  }
}

function rolesOn(st: State, day: string): RoleKey[] {
  const present = new Set(st.plan.slots.filter((s) => s.day === day && s.units.length > 0).map((s) => s.role));
  return st.roles.map((r) => r.role_key).filter((k) => present.has(k));
}

function pickRole(st: State): void {
  const keys = rolesOn(st, st.day);
  if (!st.role || !keys.includes(st.role)) st.role = keys[0] ?? null;
}

const label = (st: State, k: RoleKey) => st.roles.find((r) => r.role_key === k)?.label ?? k;

function dayLabel(st: State, d: string): string {
  if (d === st.today) return `Hoy, ${formatDay(d)}`;
  return formatDay(d).replace(/^./, (c) => c.toUpperCase());
}

function paint(box: HTMLElement, st: State): void {
  const i = st.days.indexOf(st.day);
  const inPlan = i >= 0;
  const slots = st.plan.slots.filter((s) => s.day === st.day && s.role === st.role);
  const keys = rolesOn(st, st.day);
  const week = slots[0]?.week ?? st.plan.slots.find((s) => s.day === st.day)?.week;

  box.innerHTML = `
    <div class="ic-daynav">
      <button class="c-icon-btn c-icon-btn--sm" data-step="-1" aria-label="Día anterior" ${i <= 0 ? 'disabled' : ''}>${icons.back}</button>
      <div class="ic-daynav-label"><b>${esc(dayLabel(st, st.day))}</b><span class="ic-muted ic-small">${week ? `Semana ${week} del ciclo ${st.plan.cycleNo ?? ''}` : 'Fuera del plan activo'}</span></div>
      <button class="c-icon-btn c-icon-btn--sm" data-step="1" aria-label="Día siguiente" ${!inPlan || i >= st.days.length - 1 ? 'disabled' : ''}>${icons.chevron.replace('class="c-chev"', '')}</button>
    </div>
    <label class="c-field ic-date"><span class="c-label">Fecha</span>
      <input class="c-input c-input--sm" type="date" value="${st.day}" min="${st.days[0] ?? ''}" max="${st.days[st.days.length - 1] ?? ''}"></label>
    ${keys.length ? `<div class="c-chips" role="tablist" aria-label="Rol">${keys.map((k) => `<button class="c-chip${k === st.role ? ' is-active' : ''}" data-role="${k}">${esc(label(st, k))}</button>`).join('')}</div>` : ''}
    ${slots.length ? route(st, slots) : `<div class="c-empty">${inPlan ? 'Nadie tiene ubicaciones este día.' : 'El plan activo no cubre esta fecha.'}</div>`}`;

  box.querySelectorAll<HTMLButtonElement>('[data-step]').forEach((b) => b.addEventListener('click', () => {
    const d = st.days[st.days.indexOf(st.day) + Number(b.dataset.step)];
    if (d) go(box, st, d);
  }));
  box.querySelector<HTMLInputElement>('input[type="date"]')!.addEventListener('change', (e) => {
    const v = (e.target as HTMLInputElement).value;
    if (v) go(box, st, v);
  });
  box.querySelectorAll<HTMLButtonElement>('[data-role]').forEach((b) => b.addEventListener('click', () => {
    st.role = b.dataset.role as RoleKey;
    paint(box, st);
  }));
}

function go(box: HTMLElement, st: State, day: string): void {
  st.day = day;
  pickRole(st);
  paint(box, st);
}

function route(st: State, slots: ViewSlot[]): string {
  const main = slots.filter((s) => !s.extra);
  const extra = slots.filter((s) => s.extra);
  const all = slots.flatMap((s) => s.units);
  const t = slotTotals(all);
  const notes = slots.flatMap((s) => s.notes);
  let n = 0;
  const list = (ss: ViewSlot[]) => {
    const units = ss.flatMap((s) => s.units.map((u) => ({ u, gw: s.globalWeek }))).sort((a, b) => byWalk(a.u, b.u));
    return `<ol class="ic-route">${units.map(({ u, gw }) => {
      n++;
      const total = Math.round(u.skuCount + u.looseCount);
      return `
        <li class="ic-stop">
          <span class="ic-stop-n c-num" aria-hidden="true">${n}</span>
          <div class="ic-stop-body">
            <b class="ic-stop-key">${esc(u.unitKey)}</b>
            <div class="ic-stop-nums c-num"><span><b>${fmtInt(total)}</b> total SKUs</span><span><b>${fmtInt(Math.round(u.positiveEst))}</b> esperados con stock</span></div>
            <div class="ic-tags">${unitTags(u, gw).map((x) => `<span class="c-tag">${esc(x)}</span>`).join('')}</div>
          </div>
        </li>`;
    }).join('')}</ol>`;
  };
  return `
    <section class="c-highlight ic-route-sum" aria-label="Resumen del día">
      <span class="c-label ic-on-teal">${esc(label(st, st.role!))}</span>
      <div class="c-cells">
        <div class="c-cell"><span>Ubicaciones</span><b class="c-num">${fmtInt(t.locations)}</b></div>
        <div class="c-cell"><span>Total SKUs</span><b class="c-num">${fmtInt(t.skus)}</b></div>
        <div class="c-cell"><span>Con stock</span><b class="c-num">${fmtInt(t.positive)}</b></div>
      </div>
      <span class="ic-small">Esperados con stock: estimado (última confirmación).</span>
    </section>
    ${notes.map((x) => `<div class="c-card ic-note-card">${esc(x)}</div>`).join('')}
    ${main.some((s) => s.units.length) ? list(main) : ''}
    ${extra.some((s) => s.units.length) ? `<h2 class="ic-subhead">Bloque extra: ubicaciones sin identificar</h2><p class="c-help">Códigos del sorting que aún no tienen regla. Fuera de la capacidad del día.</p>${list(extra)}` : ''}`;
}
