// Hub › Plan (spec 7.2, 5.1): generate a draft, review it week × role × day, move locations, activate.
// Every write asks for the admin PIN once (ic-admin); the PIN is never kept.
import { generate } from '../generator';
import type { ExceptionCode, Layer, RoleKey } from '../generator/types';
import { syncServerNow } from '../lib/sources/clock';
import { fetchHubConfig, loadGeneratorInput, type HubConfigRow, type RoleRow } from '../lib/plan/inputs';
import { slotTotals, toDraftPayload, viewFromPayload, type ExceptionRow, type ViewPlan, type ViewSlot, type ViewUnit } from '../lib/plan/model';
import { activatePlan, fetchPlan, fetchPlanHeads, moveUnit, saveDraft } from '../lib/plan/store';
import { formatDateTime, formatDay } from '../lib/time';
import type { DraftPayload } from '../../supabase/functions/_shared/plan_admin';
import type { HubRef } from '../router';
import { errorBox, esc, fmtInt, header, loadBar, pinDialog, toast } from '../ui';

const LAYER_LABEL: Record<Layer, string> = {
  tier0: 'Tier 0',
  freezer: 'Congeladores',
  tier_weekly: 'Tiers semanales',
  rotation: 'Rotación mensual',
  unidentified: 'Sin identificar',
};
const LAYER_ORDER: Layer[] = ['tier0', 'freezer', 'tier_weekly', 'rotation', 'unidentified'];

const EXC_LABEL: Record<ExceptionCode, string> = {
  AISLE_ONLY: 'Solo pasillo (se confirman al visitar el pasillo)',
  NO_POSITION: 'Sin posición en el sorting',
  UNKNOWN_CODE: 'Código sin regla',
  FROZEN_NO_FREEZER: 'Congelado sin congelador',
  NOT_IN_MV: 'No está en Masterview',
  DUP_POSITION: 'Posición duplicada',
};
const EXC_ROWS_SHOWN = 300;

type Tab = 'preview' | 'draft' | 'active';

interface State {
  hub: HubRef;
  cfg: HubConfigRow;
  roles: RoleRow[];
  today: string;
  draft: ViewPlan | null;
  active: ViewPlan | null;
  preview: { view: ViewPlan; payload: DraftPayload } | null;
  tab: Tab | null;
  week: number;
}

const r0 = (n: number) => fmtInt(Math.round(n));

export async function renderPlan(root: HTMLElement, hub: HubRef): Promise<void> {
  root.innerHTML = `
    <main class="c-page c-page--wide">
      ${header({ title: 'Plan', sub: hub.display_name, back: hub.display_name })}
      <div class="ic-stack" id="plan"><div class="c-skeleton" style="height:120px"></div><div class="c-skeleton" style="height:420px"></div></div>
    </main>`;
  const box = root.querySelector<HTMLElement>('#plan')!;
  try {
    const [today, { hub: cfg, roles }, heads] = await Promise.all([syncServerNow(), fetchHubConfig(hub.hub_slug), fetchPlanHeads(hub.hub_slug)]);
    const [draft, active] = await Promise.all([heads.draft ? fetchPlan(heads.draft) : null, heads.active ? fetchPlan(heads.active) : null]);
    if (!box.isConnected) return;
    const st: State = { hub, cfg, roles, today, draft, active, preview: null, tab: draft ? 'draft' : active ? 'active' : null, week: 1 };
    st.week = currentWeek(shown(st), today);
    paint(box, st);
  } catch (e) {
    if (box.isConnected) box.innerHTML = errorBox('No se pudo cargar el plan', (e as Error).message);
  }
}

function shown(st: State): ViewPlan | null {
  if (st.tab === 'preview') return st.preview?.view ?? null;
  if (st.tab === 'draft') return st.draft;
  if (st.tab === 'active') return st.active;
  return null;
}

function currentWeek(p: ViewPlan | null, today: string): number {
  if (!p) return 1;
  const s = p.slots.find((x) => x.day >= today);
  return s?.week ?? 1;
}

async function reload(box: HTMLElement, st: State, tab: Tab): Promise<void> {
  const heads = await fetchPlanHeads(st.hub.hub_slug);
  [st.draft, st.active] = await Promise.all([heads.draft ? fetchPlan(heads.draft) : null, heads.active ? fetchPlan(heads.active) : null]);
  st.tab = tab === 'draft' && !st.draft ? (st.active ? 'active' : null) : tab;
  if (box.isConnected) paint(box, st);
}

// ───────────── page ─────────────

function paint(box: HTMLElement, st: State): void {
  const p = shown(st);
  box.innerHTML = `
    ${tabsAndActions(st)}
    ${p ? planBody(p, st) : emptyState(st)}`;
  wire(box, st);
}

function emptyState(st: State): string {
  return `<div class="c-empty">${esc(st.hub.display_name)} todavía no tiene plan. Usa “Generar borrador” para armar el ciclo de ${st.cfg.cycle_weeks} semanas.</div>`;
}

function tabsAndActions(st: State): string {
  const tabs: [Tab, string][] = [];
  if (st.preview) tabs.push(['preview', 'Borrador sin guardar']);
  if (st.draft) tabs.push(['draft', 'Borrador guardado']);
  if (st.active) tabs.push(['active', 'Plan activo']);
  const p = shown(st);
  // One loud teal element per view: the next step for what's on screen.
  const primary = st.tab === 'preview' ? 'save' : st.tab === 'draft' ? 'activate' : 'generate';
  const btn = (action: string, label: string) => `<button class="c-btn ${primary === action ? 'c-btn--teal' : 'c-btn--outline'}" data-action="${action}">${esc(label)}</button>`;
  return `
    <section class="ic-plan-top">
      <div class="c-between">
        ${tabs.length > 1 ? `<div class="c-seg" role="tablist">${tabs.map(([t, l]) => `<button role="tab" data-tab="${t}" class="${st.tab === t ? 'is-active' : ''}">${esc(l)}</button>`).join('')}</div>` : `<span class="c-label">${tabs[0] ? esc(tabs[0][1]) : ''}</span>`}
        <div class="c-row ic-actions">
          ${btn('generate', 'Generar borrador')}
          ${st.tab === 'preview' ? btn('save', 'Guardar borrador') : ''}
          ${st.tab === 'draft' ? btn('activate', 'Activar') : ''}
        </div>
      </div>
      ${p ? `<p class="c-sub">${esc(planLine(p, st))}</p>` : ''}
      <div id="plan-progress"></div>
    </section>`;
}

function planLine(p: ViewPlan, st: State): string {
  const weeks = `${p.cycleWeeks} semanas desde ${formatDay(p.cycleStart)}`;
  const gw = p.slots[0]?.globalWeek;
  const global = gw ? `, semana global ${gw}` : '';
  if (p.status === 'preview') return `Ciclo de ${weeks}${global}. Todavía no está guardado: revisa y guarda el borrador para poder mover ubicaciones.`;
  if (p.status === 'draft') return `Borrador del ciclo ${p.cycleNo}: ${weeks}${global}. Guardado ${p.createdAt ? formatDateTime(new Date(p.createdAt)) : ''}. Mueve ubicaciones si hace falta y luego actívalo.${st.active ? ' Al activarlo, el plan activo actual se cierra sin cambios.' : ''}`;
  return `Ciclo ${p.cycleNo}: ${weeks}${global}. Activo desde ${p.activatedAt ? formatDateTime(new Date(p.activatedAt)) : ''}.`;
}

function planBody(p: ViewPlan, st: State): string {
  const report = p.report;
  const basisLabel = report.basis === 'catalog' ? 'SKUs' : 'esperados con stock';
  const normal = p.slots.filter((s) => !s.extra);
  const capacity = normal.reduce((t, s) => t + s.capacity, 0);
  const load = normal.reduce((t, s) => t + slotTotals(s.units).load, 0);
  const locations = new Set(p.slots.flatMap((s) => s.units.map((u) => u.unitKey))).size;
  const excTotal = report.exceptionList?.length ?? Object.values(report.exceptions ?? {}).reduce((a, b) => a + b, 0);
  const over = Math.max(0, load - capacity);

  const banner = over > 0.5 || (report.overload?.over ?? 0) > 0.5
    ? `<div class="c-highlight c-highlight--ink ic-banner"><b>Sobrecarga: el ciclo lleva ${r0(Math.max(over, report.overload?.over ?? 0))} SKUs más de lo que cabe.</b>${report.overload?.fix ? `<span>${esc(report.overload.fix)}</span>` : ''}<span>Todo queda asignado; el ciclo no se alarga.</span></div>`
    : '';

  return `
    ${banner}
    <div class="c-grid ic-stats">
      ${stat('Capacidad del ciclo', r0(capacity))}
      ${stat(`Carga (${basisLabel})`, r0(load))}
      ${stat('Ubicaciones', fmtInt(locations))}
      ${stat('Excepciones', fmtInt(excTotal))}
    </div>
    ${rolesCard(p, st)}
    ${report.messages?.length ? `<section class="c-card ic-card"><h2 class="ic-subhead">Reporte de carga</h2><ul class="ic-msgs">${report.messages.map((m) => `<li>${esc(m)}</li>`).join('')}</ul></section>` : ''}
    ${weekGrid(p, st)}
    ${exceptionsPanel(report.exceptionList ?? [])}`;
}

const stat = (label: string, value: string) => `<div class="c-stat"><span class="c-stat-label">${esc(label)}</span><span class="c-stat-value">${value}</span></div>`;

function roleLabel(st: State, key: RoleKey): string {
  return st.roles.find((r) => r.role_key === key)?.label ?? key;
}

function planRoleKeys(p: ViewPlan, st: State): RoleKey[] {
  const present = new Set(p.slots.map((s) => s.role));
  return st.roles.map((r) => r.role_key).filter((k) => present.has(k));
}

function rolesCard(p: ViewPlan, st: State): string {
  const sections = new Map((p.report.roles ?? []).map((r) => [r.role, r.section]));
  const rows = planRoleKeys(p, st).map((k) => {
    const slots = p.slots.filter((s) => s.role === k && !s.extra);
    const cap = slots.reduce((t, s) => t + s.capacity, 0);
    const load = slots.reduce((t, s) => t + slotTotals(s.units).load, 0);
    const over = load - cap;
    return `
      <div class="ic-role">
        <div class="c-between"><b>${esc(roleLabel(st, k))}</b><span class="c-num ic-nowrap">${r0(load)} / ${r0(cap)}${over > 0.5 ? ` <span class="c-tag c-tag--ink">+${r0(over)}</span>` : ''}</span></div>
        ${loadBar(load, cap)}
        ${sections.get(k) ? `<span class="ic-muted ic-small">Sección ${esc(sections.get(k))}</span>` : ''}
      </div>`;
  });
  return `<section class="c-card ic-card"><h2 class="ic-subhead">Carga por rol en el ciclo</h2><div class="ic-roles">${rows.join('')}</div></section>`;
}

// ───────────── week × role × day grid ─────────────

function weekGrid(p: ViewPlan, st: State): string {
  const weeks = [...new Set(p.slots.map((s) => s.week))].sort((a, b) => a - b);
  if (!weeks.includes(st.week)) st.week = weeks[0] ?? 1;
  const slots = p.slots.filter((s) => s.week === st.week);
  const days = [...new Set(slots.map((s) => s.day))].sort();
  const roleKeys = planRoleKeys(p, st);
  const gw = slots[0]?.globalWeek;
  const movable = p.status === 'draft';

  const rows = roleKeys.filter((k) => slots.some((s) => s.role === k && !s.extra)).map((k) => `
    <tr><th scope="row">${esc(roleLabel(st, k))}</th>${days.map((d) => {
      const s = slots.find((x) => x.role === k && x.day === d && !x.extra);
      return `<td>${s ? cell(s, movable && d >= st.today) : '<span class="ic-muted">—</span>'}</td>`;
    }).join('')}</tr>`);
  const extras = slots.filter((s) => s.extra);
  if (extras.length) {
    rows.push(`<tr class="ic-extra-row"><th scope="row">Bloque extra<span class="ic-muted ic-small">fuera de capacidad</span></th>${days.map((d) => {
      const s = extras.find((x) => x.day === d);
      return `<td>${s ? `<span class="ic-muted ic-small">${esc(roleLabel(st, s.role))}</span>${cell(s, movable && d >= st.today)}` : ''}</td>`;
    }).join('')}</tr>`);
  }

  return `
    <section class="ic-week">
      <div class="c-between">
        <h2 class="c-h2">Semana ${st.week}${gw ? ` <span class="ic-muted ic-small">semana global ${gw}</span>` : ''}</h2>
        <div class="c-seg" role="tablist" aria-label="Semana">${weeks.map((w) => `<button data-week="${w}" class="${w === st.week ? 'is-active' : ''}">Semana ${w}</button>`).join('')}</div>
      </div>
      ${movable ? '<p class="c-help">Toca una ubicación para moverla a otro día o rol. Los días que ya pasaron no se cambian.</p>' : ''}
      <div class="c-table-wrap ic-grid-wrap">
        <table class="c-table ic-grid">
          <thead><tr><th>Rol</th>${days.map((d) => `<th${d === st.today ? ' class="is-today"' : ''}>${esc(formatDay(d))}${d === st.today ? ' · hoy' : ''}</th>`).join('')}</tr></thead>
          <tbody>${rows.join('')}</tbody>
        </table>
      </div>
    </section>`;
}

function cell(s: ViewSlot, movable: boolean): string {
  const t = slotTotals(s.units);
  const groups = LAYER_ORDER.map((layer) => {
    const us = s.units.filter((u) => u.layer === layer);
    if (!us.length) return '';
    const label = layer === 'freezer' ? `Congeladores grupo ${s.globalWeek % 2 === 1 ? 'A' : 'B'}` : LAYER_LABEL[layer];
    return `<div class="ic-layer"><span class="ic-layer-label">${esc(label)}</span><div class="ic-units">${us.map((u) => unitChip(u, s, movable)).join('')}</div></div>`;
  }).join('');
  return `
    <div class="ic-cell">
      <div class="ic-cell-nums"><b class="c-num">${fmtInt(t.skus)} SKUs</b><span class="c-num">${fmtInt(t.positive)} con stock</span></div>
      ${s.extra ? '' : loadBar(t.load, s.capacity)}
      ${s.extra ? '' : `<span class="ic-muted ic-small c-num ic-nowrap">carga ${r0(t.load)} / cap. ${r0(s.capacity)}</span>`}
      ${groups || '<span class="ic-muted ic-small">Sin ubicaciones</span>'}
      ${s.notes.map((n) => `<span class="ic-note">${esc(n)}</span>`).join('')}
    </div>`;
}

function unitChip(u: ViewUnit, s: ViewSlot, movable: boolean): string {
  const title = `${u.unitKey}: ${Math.round(u.skuCount + u.looseCount)} SKUs, ${Math.round(u.positiveEst)} con stock${u.moved ? ' (movida)' : ''}`;
  const cls = `ic-unit${u.moved ? ' is-moved' : ''}`;
  return movable && u.id !== null
    ? `<button class="${cls}" data-su="${u.id}" data-day="${s.day}" data-role="${s.role}" data-extra="${s.extra}" title="${esc(title)}">${esc(u.unitKey)}</button>`
    : `<span class="${cls}" title="${esc(title)}">${esc(u.unitKey)}</span>`;
}

// ───────────── exceptions ─────────────

function exceptionsPanel(list: ExceptionRow[]): string {
  if (!list.length) return '';
  const byCode = new Map<ExceptionCode, ExceptionRow[]>();
  for (const e of list) (byCode.get(e[0]) ?? byCode.set(e[0], []).get(e[0])!).push(e);
  const groups = [...byCode].sort((a, b) => b[1].length - a[1].length).map(([code, rows]) => `
    <details class="ic-exc">
      <summary><span>${esc(EXC_LABEL[code] ?? code)}</span><span class="c-tag c-tag--on-white c-num">${fmtInt(rows.length)}</span></summary>
      <div class="c-table-wrap"><table class="c-table">
        <thead><tr><th>Producto</th><th>SKU</th><th>Posición en sorting</th><th>Dónde se cubre</th></tr></thead>
        <tbody>${rows.slice(0, EXC_ROWS_SHOWN).map(([, sku, name, rawPos, unitKey, aisle]) => `
          <tr><td>${esc(name)}</td><td class="ic-nowrap">${esc(sku ?? '—')}</td><td class="ic-nowrap">${esc(rawPos || '—')}</td>
          <td>${unitKey ? esc(unitKey) : aisle ? `buscar en pasillo ${esc(aisle)}` : '<span class="ic-muted">sin ubicación</span>'}</td></tr>`).join('')}</tbody>
      </table></div>
      ${rows.length > EXC_ROWS_SHOWN ? `<p class="c-help">Se muestran ${EXC_ROWS_SHOWN} de ${fmtInt(rows.length)}.</p>` : ''}
    </details>`).join('');
  return `<section class="c-card ic-card"><h2 class="ic-subhead">Excepciones <span class="ic-muted">por tipo</span></h2>${groups}</section>`;
}

// ───────────── actions ─────────────

function wire(box: HTMLElement, st: State): void {
  box.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) => b.addEventListener('click', () => {
    st.tab = b.dataset.tab as Tab;
    st.week = currentWeek(shown(st), st.today);
    paint(box, st);
  }));
  box.querySelectorAll<HTMLButtonElement>('[data-week]').forEach((b) => b.addEventListener('click', () => {
    st.week = Number(b.dataset.week);
    paint(box, st);
  }));
  box.querySelector('[data-action="generate"]')?.addEventListener('click', () => void onGenerate(box, st));
  box.querySelector('[data-action="save"]')?.addEventListener('click', () => void onSave(box, st));
  box.querySelector('[data-action="activate"]')?.addEventListener('click', () => void onActivate(box, st));
  box.querySelectorAll<HTMLButtonElement>('[data-su]').forEach((b) => b.addEventListener('click', () => void onMove(box, st, b)));
}

async function onGenerate(box: HTMLElement, st: State): Promise<void> {
  const progress = box.querySelector<HTMLElement>('#plan-progress')!;
  box.querySelectorAll<HTMLButtonElement>('.ic-actions button').forEach((b) => (b.disabled = true));
  progress.innerHTML = '<p class="c-help">Leyendo sorting, Masterview, tiers y stock…</p>';
  try {
    const loaded = await loadGeneratorInput(st.hub.hub_slug);
    progress.innerHTML = '<p class="c-help">Armando el plan…</p>';
    await new Promise((r) => setTimeout(r, 0)); // let the message paint before the generator runs
    const plan = generate(loaded.input);
    const payload = toDraftPayload(plan, loaded.input.hub.walkingOrder, {
      sorting_updated_at: loaded.sortingVersion,
      anchor_monday: loaded.input.anchorMonday,
      sizing_basis: loaded.input.hub.sizingBasis,
      counts: loaded.counts,
    });
    st.preview = { view: viewFromPayload(payload), payload };
    st.tab = 'preview';
    st.week = currentWeek(st.preview.view, st.today);
    if (box.isConnected) paint(box, st);
  } catch (e) {
    if (!box.isConnected) return;
    box.querySelectorAll<HTMLButtonElement>('.ic-actions button').forEach((b) => (b.disabled = false));
    progress.innerHTML = errorBox('No se pudo generar el borrador', (e as Error).message);
  }
}

async function onSave(box: HTMLElement, st: State): Promise<void> {
  const payload = st.preview?.payload;
  if (!payload) return;
  const done = await pinDialog({
    title: 'Guardar borrador',
    text: st.draft ? 'Reemplaza el borrador guardado. El plan activo no cambia.' : 'Guarda el borrador para poder mover ubicaciones y activarlo. El plan activo no cambia.',
    confirm: 'Guardar',
    run: async (pin) => {
      await saveDraft(pin, payload);
    },
  });
  if (!done) return;
  st.preview = null;
  toast('Borrador guardado');
  await reload(box, st, 'draft');
}

async function onActivate(box: HTMLElement, st: State): Promise<void> {
  const draft = st.draft;
  if (!draft?.id) return;
  const done = await pinDialog({
    title: 'Activar plan',
    text: st.active
      ? `El borrador pasa a ser el plan de ${st.hub.display_name}. El plan activo (ciclo ${st.active.cycleNo}) se cierra tal como está: las semanas pasadas no se reescriben.`
      : `El borrador pasa a ser el plan de ${st.hub.display_name} y aparece en la Ruta del día.`,
    confirm: 'Activar',
    run: async (pin) => {
      await activatePlan(pin, draft.id!);
    },
  });
  if (!done) return;
  toast('Plan activado');
  await reload(box, st, 'active');
}

async function onMove(box: HTMLElement, st: State, chip: HTMLButtonElement): Promise<void> {
  const draft = st.draft;
  if (!draft?.id) return;
  const id = Number(chip.dataset.su);
  const fromDay = chip.dataset.day!;
  const fromRole = chip.dataset.role as RoleKey;
  const unit = draft.slots.flatMap((s) => s.units).find((u) => u.id === id);
  if (!unit) return;
  const targets = draft.slots.filter((s) => !s.extra && s.day >= st.today);
  const days = [...new Set(targets.map((s) => s.day))].sort();
  const roles = planRoleKeys(draft, st).filter((k) => targets.some((s) => s.role === k));
  const fields = `
    <div class="ic-move-from"><b>${esc(unit.unitKey)}</b><span class="ic-muted">${fmtInt(Math.round(unit.skuCount + unit.looseCount))} SKUs · ${fmtInt(Math.round(unit.positiveEst))} con stock · ahora ${esc(formatDay(fromDay))}, ${esc(roleLabel(st, fromRole))}${chip.dataset.extra === 'true' ? ' (bloque extra)' : ''}</span></div>
    <label class="c-field"><span class="c-label">Día</span>
      <select class="c-select c-select--sm" name="day">${days.map((d) => {
        const w = targets.find((s) => s.day === d)!.week;
        return `<option value="${d}"${d === fromDay ? ' selected' : ''}>${esc(formatDay(d))} · semana ${w}</option>`;
      }).join('')}</select></label>
    <label class="c-field"><span class="c-label">Rol</span>
      <select class="c-select c-select--sm" name="role">${roles.map((k) => `<option value="${k}"${k === fromRole ? ' selected' : ''}>${esc(roleLabel(st, k))}</option>`).join('')}</select></label>`;
  const done = await pinDialog({
    title: 'Mover ubicación',
    text: 'Se mueve solo esta visita; las otras semanas no cambian.',
    confirm: 'Mover',
    fieldsHtml: fields,
    run: async (pin, modal) => {
      const day = modal.querySelector<HTMLSelectElement>('select[name="day"]')!.value;
      const role = modal.querySelector<HTMLSelectElement>('select[name="role"]')!.value as RoleKey;
      if (!targets.some((s) => s.day === day && s.role === role)) throw new Error(`${roleLabel(st, role)} no trabaja ese día en el plan.`);
      if (day === fromDay && role === fromRole && chip.dataset.extra !== 'true') throw new Error('La ubicación ya está en ese día y rol.');
      await moveUnit(pin, draft.id!, id, day, role);
      st.week = targets.find((s) => s.day === day)!.week;
    },
  });
  if (!done) return;
  toast(`${unit.unitKey} movida`);
  await reload(box, st, 'draft');
}
