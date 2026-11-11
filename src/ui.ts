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

// ───────────── PIN dialog and toast ─────────────

export interface PinDialogOpts {
  title: string;
  text: string;
  confirm: string;
  /** Extra form fields above the PIN (e.g. the move target). */
  fieldsHtml?: string;
  /** Runs the action. Throw to show the message in the dialog and keep it open. The PIN is never kept. */
  run: (pin: string, modal: HTMLElement) => Promise<void>;
}

/** Asks for the admin PIN for one action. Resolves true when the action ran, false when cancelled. */
export function pinDialog(o: PinDialogOpts): Promise<boolean> {
  return new Promise((resolve) => {
    const bg = document.createElement('div');
    bg.className = 'c-modal-bg is-open';
    bg.innerHTML = `
      <form class="c-modal ic-modal" role="dialog" aria-modal="true" aria-labelledby="ic-modal-title" novalidate>
        <h2 class="c-h2" id="ic-modal-title">${esc(o.title)}</h2>
        <p>${esc(o.text)}</p>
        <div class="c-stack">
          ${o.fieldsHtml ?? ''}
          <label class="c-field"><span class="c-label">PIN de administración</span>
            <input class="c-input c-input--sm" name="pin" type="password" inputmode="numeric" autocomplete="off" required></label>
          <p class="c-help is-error" data-error hidden></p>
        </div>
        <div class="c-modal-actions">
          <button type="button" class="c-btn c-btn--outline" data-cancel>Cancelar</button>
          <button type="submit" class="c-btn c-btn--ink" data-ok>${esc(o.confirm)}</button>
        </div>
      </form>`;
    document.body.appendChild(bg);
    const form = bg.querySelector('form')!;
    const pin = form.querySelector<HTMLInputElement>('input[name="pin"]')!;
    const err = form.querySelector<HTMLElement>('[data-error]')!;
    const ok = form.querySelector<HTMLButtonElement>('[data-ok]')!;
    const close = (v: boolean) => {
      pin.value = '';
      bg.remove();
      document.removeEventListener('keydown', onKey);
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !ok.disabled) close(false);
    };
    document.addEventListener('keydown', onKey);
    form.querySelector('[data-cancel]')!.addEventListener('click', () => close(false));
    bg.addEventListener('click', (e) => {
      if (e.target === bg && !ok.disabled) close(false);
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!pin.value.trim()) {
        err.hidden = false;
        err.textContent = 'Escribe el PIN.';
        return pin.focus();
      }
      ok.disabled = true;
      const label = ok.textContent;
      ok.textContent = 'Guardando…';
      err.hidden = true;
      try {
        await o.run(pin.value.trim(), form);
        close(true);
      } catch (x) {
        ok.disabled = false;
        ok.textContent = label;
        err.hidden = false;
        err.textContent = (x as Error).message;
        pin.value = '';
        pin.focus();
      }
    });
    (form.querySelector<HTMLElement>('select, input') ?? pin).focus();
  });
}

let toastTimer = 0;
export function toast(text: string): void {
  let el = document.querySelector<HTMLElement>('.c-toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'c-toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.add('is-show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el!.classList.remove('is-show'), 3200);
}

/** Load bar: filled share of capacity; over capacity fills in ink and says by how much. */
export function loadBar(load: number, capacity: number): string {
  const over = capacity > 0 && load > capacity + 0.5;
  const pct = capacity > 0 ? Math.min(100, (load / capacity) * 100) : load > 0 ? 100 : 0;
  return `<span class="ic-bar${over ? ' is-over' : ''}" role="img" aria-label="${esc(`${Math.round(load)} de ${Math.round(capacity)}`)}"><span style="width:${pct.toFixed(1)}%"></span></span>`;
}
