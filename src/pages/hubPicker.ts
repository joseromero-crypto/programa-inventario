import { supabase } from '../lib/supabase';

interface Hub { hub_slug: string; display_name: string; active: boolean; in_plan: boolean }

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const chevron = '<svg class="c-chev" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';

function shell(body: string): string {
  return `
    <main class="c-page">
      <header class="c-header">
        <div class="c-brand"><span class="c-brand-mark"></span>Calii</div>
        <h1 class="c-title">Confirmación de inventario</h1>
        <p class="c-sub">Elige un hub para empezar.</p>
      </header>
      ${body}
    </main>`;
}

// Hub picker on every load (no remembered state). Selecting a hub comes with the 0.5 screens.
export async function renderHubPicker(root: HTMLElement): Promise<void> {
  root.innerHTML = shell(`<div class="c-list">${'<div class="c-skeleton" style="height:58px"></div>'.repeat(7)}</div>`);
  const { data, error } = await supabase.from('ic_hub_config').select('hub_slug, display_name, active, in_plan').order('sort_order').order('hub_slug');
  if (error) {
    root.innerHTML = shell(`<div class="c-highlight c-highlight--ink"><b>No se pudieron cargar los hubs</b><span>${esc(error.message)}</span></div>`);
    return;
  }
  const hubs = (data as Hub[]).filter((h) => h.active);
  root.innerHTML = shell(hubs.length
    ? `<nav class="c-list">${hubs.map((h) => h.in_plan
        ? `<button class="c-list-row" data-hub="${esc(h.hub_slug)}">
            <span class="c-list-row-title">${esc(h.display_name)}</span>${chevron}
          </button>`
        : `<div class="c-list-row is-disabled" aria-disabled="true">
            <span class="c-list-row-title">${esc(h.display_name)}</span>
            <span class="c-tag c-tag--neutral">Próximamente</span>
          </div>`).join('')}</nav>`
    : '<div class="c-empty">No hay hubs activos.</div>');
}
