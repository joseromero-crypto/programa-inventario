// Admin › Fuentes (phase 0.5): freshness of sorting, Masterview and confirmations, per hub.
import { supabase } from '../lib/supabase';
import { compileRules, unmatchedCodes, type LocationRule } from '../lib/locationRules';
import { fetchFreshness, type Freshness, type HubFreshness } from '../lib/sources/freshness';
import { fetchSorting, fetchSortingVersion, summarizeSorting } from '../lib/sources/sorting';
import { ageInDays, formatDateTime, formatDay, formatShortDay, localDate, now, relativeDays, workdaysBetween } from '../lib/time';
import type { HubRef } from '../router';
import { errorBox, esc, fmtInt, fmtPct, header } from '../ui';

const SORTING_STALE_DAYS = 21;
const CONF_STALE_WORKDAYS = 2; // Mon–Fri only
const SHEET_COLUMNS = 55;
const SHEET_CELL_LIMIT = 10_000_000;
const CODES_VISIBLE = 12;

type HubRule = LocationRule & { hub_slug: string };

const staleTag = (text: string) => `<span class="c-tag c-tag--ink">${esc(text)}</span>`;
const okTag = (text: string) => `<span class="c-row ic-ok"><span class="c-dot"></span>${esc(text)}</span>`;

function kv(rows: [string, string][]): string {
  return `<dl class="ic-kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
}

function age(iso: string | null): { days: number | null; text: string } {
  if (!iso) return { days: null, text: 'Sin datos' };
  const d = new Date(iso);
  const days = ageInDays(d);
  return { days, text: `${esc(relativeDays(days))}<span class="ic-when">${esc(formatDateTime(d))}</span>` };
}

// ───────────────────────── page ─────────────────────────

export async function renderFuentes(root: HTMLElement, hub?: HubRef): Promise<void> {
  root.innerHTML = `
    <main class="c-page">
      ${header({ title: 'Fuentes de datos', sub: hub ? hub.display_name : 'Todos los hubs', back: hub ? hub.display_name : 'Hubs' })}
      <div class="ic-stack" id="fuentes"><div class="c-skeleton" style="height:180px"></div><div class="c-skeleton" style="height:420px"></div></div>
    </main>`;
  const box = root.querySelector<HTMLElement>('#fuentes')!;

  let fresh: Freshness;
  let rules: HubRule[];
  try {
    const [f, r] = await Promise.all([
      fetchFreshness(),
      supabase.from('ic_location_rules').select('hub_slug, priority, match_regex, normalize_to, kind, group_label, active'),
    ]);
    if (r.error) throw new Error(r.error.message);
    fresh = f;
    rules = r.data as HubRule[];
  } catch (e) {
    if (box.isConnected) box.innerHTML = errorBox('No se pudieron cargar las fuentes', (e as Error).message);
    return;
  }
  if (!box.isConnected) return; // user navigated away

  const hubs = fresh.hubs.filter((h) => h.in_plan && (!hub || h.hub_slug === hub.hub_slug));
  box.innerHTML = sharedCard(fresh) + hubs.map((h) => hubCard(h)).join('');

  // Sorting files load per hub and fill in as they arrive.
  await Promise.all(hubs.map(async (h) => {
    const slot = box.querySelector<HTMLElement>(`[data-sorting="${CSS.escape(h.hub_slug)}"]`);
    let html: string;
    let stale = false;
    try {
      const [file, version] = await Promise.all([fetchSorting(h.hub_slug), fetchSortingVersion(h.hub_slug).catch(() => null)]);
      const r = sortingSection(file.updatedAt, version, summarizeSorting(file), rules.filter((x) => x.hub_slug === h.hub_slug));
      html = r.html;
      stale = r.stale;
    } catch (e) {
      html = `<p class="ic-muted">No se pudo leer el sorting: ${esc((e as Error).message)}</p>`;
      stale = true;
    }
    if (!slot?.isConnected) return;
    slot.innerHTML = html;
    setStatus(box, h, stale);
  }));
}

// ───────────────────────── shared sources ─────────────────────────

function sharedCard(f: Freshness): string {
  const cur = f.cursors.find((c) => c.source_name === 'ic_confirmaciones');
  const sheetRows = cur?.row_count_seen ?? null;
  const cells = sheetRows === null ? null : sheetRows * SHEET_COLUMNS;
  const ratio = cells === null ? 0 : cells / SHEET_CELL_LIMIT;
  const mv = age(f.mv.last_import);
  const load = age(cur?.updated_at ?? null);

  return `
    <article class="c-card ic-card">
      <h2 class="c-h2">Compartidas</h2>
      <h3 class="ic-subhead">Masterview</h3>
      ${kv([['Importado', mv.text], ['Productos', `<span class="c-num">${fmtInt(f.mv.products)}</span>`]])}
      <h3 class="ic-subhead">Hoja Download</h3>
      ${kv([
        ['Filas', sheetRows === null ? 'Sin datos' : `<span class="c-num">${fmtInt(sheetRows - 1)}</span>`],
        ['Última carga', load.text],
        ['Guardadas hasta fila', cur ? `<span class="c-num">${fmtInt(cur.last_row)}</span>` : 'Sin datos'],
      ])}
      ${cells === null ? '' : `
        <div class="ic-meter" role="meter" aria-valuemin="0" aria-valuemax="${SHEET_CELL_LIMIT}" aria-valuenow="${cells}"
             aria-label="Celdas usadas de la hoja: ${fmtPct(ratio)} del límite de 10 millones">
          <div class="c-between">
            <span class="c-label">Celdas (filas × ${SHEET_COLUMNS}) vs límite de 10 M</span>
            ${ratio >= 0.8 ? staleTag(fmtPct(ratio)) : `<b class="c-num">${fmtPct(ratio)}</b>`}
          </div>
          <div class="ic-meter-track"><span style="width:${Math.min(100, ratio * 100).toFixed(1)}%"></span></div>
          <span class="ic-muted c-num">${fmtInt(cells)} de ${fmtInt(SHEET_CELL_LIMIT)} · solo esta pestaña</span>
        </div>`}
    </article>`;
}

// ───────────────────────── per hub ─────────────────────────

function hubCard(h: HubFreshness): string {
  const last = age(h.last_event_ts);
  // Workdays only (Mon–Fri): a Friday confirmation is still fresh on Monday.
  const confStale = h.last_event_ts === null
    || workdaysBetween(localDate(new Date(h.last_event_ts)), localDate(now())) > CONF_STALE_WORKDAYS;
  return `
    <article class="c-card ic-card" data-hub-card="${esc(h.hub_slug)}" data-conf-stale="${confStale}">
      <div class="c-between">
        <h2 class="c-h2">${esc(h.display_name)}</h2>
        <span data-status><span class="c-skeleton" style="display:inline-block;width:72px;height:24px"></span></span>
      </div>
      <h3 class="ic-subhead">Sorting</h3>
      <div data-sorting="${esc(h.hub_slug)}"><div class="c-skeleton" style="height:120px"></div></div>
      <h3 class="ic-subhead">Confirmaciones</h3>
      ${kv([['Última', `${last.text}${confStale ? ` ${staleTag(`Más de ${CONF_STALE_WORKDAYS} días hábiles`)}` : ''}`]])}
      ${dailyChart(h.daily)}
    </article>`;
}

function setStatus(box: HTMLElement, h: HubFreshness, sortingStale: boolean): void {
  const card = box.querySelector<HTMLElement>(`[data-hub-card="${CSS.escape(h.hub_slug)}"]`);
  const el = card?.querySelector<HTMLElement>('[data-status]');
  if (!card || !el) return;
  const stale = sortingStale || card.dataset.confStale === 'true';
  el.innerHTML = stale ? staleTag('Desactualizado') : okTag('Al día');
}

function sortingSection(updatedAt: string, version: string | null, s: ReturnType<typeof summarizeSorting>, hubRules: LocationRule[]) {
  const upd = age(updatedAt);
  const stale = upd.days === null || upd.days > SORTING_STALE_DAYS;
  const { compiled, errors } = compileRules(hubRules);
  const missing = unmatchedCodes(s.codeCounts, compiled);
  const versionDate = version && !Number.isNaN(Date.parse(version)) ? formatDateTime(new Date(version)) : version;
  const pct = s.rows ? s.fullPosition / s.rows : 0;

  const chip = (c: { code: string; rows: number }) =>
    `<span class="c-tag c-tag--neutral"><span class="c-num">${esc(c.code)}</span><span class="ic-muted">${fmtInt(c.rows)}</span></span>`;
  const codes = missing.length === 0 ? '' : `
    <div class="ic-codes">
      ${missing.slice(0, CODES_VISIBLE).map(chip).join('')}
      ${missing.length > CODES_VISIBLE ? `<details><summary>Ver ${missing.length - CODES_VISIBLE} más</summary><div class="ic-codes">${missing.slice(CODES_VISIBLE).map(chip).join('')}</div></details>` : ''}
    </div>`;

  const html = `
    ${kv([
      ['Actualizado', `${upd.text}${stale ? ` ${staleTag(`Más de ${SORTING_STALE_DAYS} días`)}` : ''}`],
      ['Versión', versionDate ? esc(versionDate) : 'Sin version.txt'],
      ['Filas', `<span class="c-num">${fmtInt(s.rows)}</span>`],
      ['Posición completa', `<span class="c-num">${fmtPct(pct)}</span> <span class="ic-muted c-num">(${fmtInt(s.fullPosition)})</span>`],
      ['Solo pasillo · sin posición', `<span class="c-num">${fmtInt(s.aisleOnly)} · ${fmtInt(s.noPosition)}</span>`],
      ['Códigos sin regla', `<span class="c-num">${fmtInt(missing.length)}</span> <span class="ic-muted c-num">de ${fmtInt(s.codeCounts.size)}</span>`],
    ])}
    ${codes}
    ${errors.length ? `<p class="ic-muted">${errors.length} regla(s) con expresión inválida: ${errors.map((e) => esc(e.rule.match_regex)).join(', ')}</p>` : ''}`;
  return { html, stale };
}

/** 14-day confirmations strip: one series, bars anchored to the baseline, hover/focus tooltip per day. */
function dailyChart(daily: { d: string; n: number }[]): string {
  if (!daily.length) return '';
  const max = Math.max(1, ...daily.map((x) => x.n));
  const total = daily.reduce((a, x) => a + x.n, 0);
  const peak = daily.reduce((a, x) => (x.n > a.n ? x : a), daily[0]!);
  const cols = daily.map((x, i) => {
    const edge = i < 3 ? ' is-start' : i > daily.length - 4 ? ' is-end' : '';
    const h = x.n === 0 ? '' : `style="height:${Math.max(4, (x.n / max) * 100).toFixed(1)}%"`;
    return `<div class="ic-spark-col${edge}" tabindex="0" data-tip="${esc(`${formatDay(x.d)} · ${fmtInt(x.n)}`)}" aria-label="${esc(`${formatDay(x.d)}: ${x.n}`)}">
      <span class="ic-spark-bar${x.n === 0 ? ' is-zero' : ''}" ${h}></span></div>`;
  }).join('');
  return `
    <figure class="ic-spark-fig">
      <figcaption class="c-between"><span class="c-label">Por día, últimos 14 días</span><b class="c-num">${fmtInt(total)}</b></figcaption>
      <div class="ic-spark" role="group" aria-label="${esc(`Confirmaciones por día, últimos 14 días. Total ${total}. Máximo ${peak.n} el ${formatDay(peak.d)}.`)}">${cols}</div>
      <div class="ic-spark-axis ic-muted"><span>${esc(formatShortDay(daily[0]!.d))}</span><span>${esc(formatShortDay(daily[daily.length - 1]!.d))}</span></div>
    </figure>`;
}
