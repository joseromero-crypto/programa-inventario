import { supabase } from '../lib/supabase';
import { go } from '../router';
import { errorBox, esc, header, navRow, soonRow } from '../ui';

interface Hub { hub_slug: string; display_name: string; active: boolean; in_plan: boolean }

const shell = (body: string) => `<main class="c-page">${header({ title: 'Confirmación de inventario', sub: 'Elige un hub para empezar.' })}${body}</main>`;

export async function renderHubPicker(root: HTMLElement): Promise<void> {
  root.innerHTML = shell(`<div class="c-list">${'<div class="c-skeleton" style="height:58px"></div>'.repeat(8)}</div>`);
  const { data, error } = await supabase
    .from('ic_hub_config').select('hub_slug, display_name, active, in_plan').order('sort_order').order('hub_slug');
  if (error) return void (root.innerHTML = shell(errorBox('No se pudieron cargar los hubs', error.message)));

  const hubs = (data as Hub[]).filter((h) => h.active);
  root.innerHTML = shell(`
    ${hubs.length
      ? `<nav class="c-list" aria-label="Hubs">${hubs.map((h) => h.in_plan
          ? navRow(h.display_name, `data-hub="${esc(h.hub_slug)}"`)
          : soonRow(h.display_name)).join('')}</nav>`
      : '<div class="c-empty">No hay hubs activos.</div>'}
    <section class="ic-section">
      <h2 class="c-label">Administración</h2>
      <nav class="c-list">${navRow('Fuentes de datos', 'data-action="fuentes"')}</nav>
    </section>`);

  root.querySelectorAll<HTMLButtonElement>('[data-hub]').forEach((b) => b.addEventListener('click', () => {
    const h = hubs.find((x) => x.hub_slug === b.dataset.hub)!;
    go({ name: 'hub', hub: { hub_slug: h.hub_slug, display_name: h.display_name } });
  }));
  root.querySelector('[data-action="fuentes"]')?.addEventListener('click', () => go({ name: 'fuentes' }));
}
