// Small shared UI helpers (Calii theme classes). Markup only, no data access.

export const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const svg = (paths: string, size = 20, cls = '') =>
  `<svg${cls ? ` class="${cls}"` : ''} width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

export const icons = {
  chevron: svg('<path d="m9 6 6 6-6 6"/>', 20, 'c-chev'),
  back: svg('<path d="m15 6-6 6 6 6"/>', 20),
};

export function header(opts: { title: string; sub?: string; back?: string }): string {
  return `
    <header class="c-header">
      <div class="c-between">
        <div class="c-brand"><span class="c-brand-mark"></span>Calii</div>
        ${opts.back ? `<button class="c-btn c-btn--ghost c-btn--sm" data-action="back">${icons.back}${esc(opts.back)}</button>` : ''}
      </div>
      <h1 class="c-title">${esc(opts.title)}</h1>
      ${opts.sub ? `<p class="c-sub">${esc(opts.sub)}</p>` : ''}
    </header>`;
}

export function navRow(label: string, attrs: string, meta = ''): string {
  return `<button class="c-list-row" ${attrs}><span class="c-list-row-title">${esc(label)}</span>${meta}${icons.chevron}</button>`;
}

export function soonRow(label: string): string {
  return `<div class="c-list-row is-disabled" aria-disabled="true"><span class="c-list-row-title">${esc(label)}</span><span class="c-tag c-tag--neutral">Próximamente</span></div>`;
}

export function errorBox(title: string, detail: string): string {
  return `<div class="c-highlight c-highlight--ink"><b>${esc(title)}</b><span>${esc(detail)}</span></div>`;
}

export const fmtInt = (n: number): string => n.toLocaleString('es-MX');
export const fmtPct = (n: number): string => `${(Math.round(n * 1000) / 10).toLocaleString('es-MX')} %`;
