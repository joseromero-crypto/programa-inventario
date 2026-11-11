import { go, type HubRef } from '../router';
import { header, navRow, soonRow } from '../ui';

// Phase 0: the hub screen only links to its data sources; plan screens arrive in later phases.
export function renderHubHome(root: HTMLElement, hub: HubRef): void {
  root.innerHTML = `
    <main class="c-page">
      ${header({ title: hub.display_name, back: 'Hubs' })}
      <nav class="c-list">
        ${soonRow('Plan')}
        ${soonRow('Ruta del día')}
        ${soonRow('Seguimiento')}
      </nav>
      <section class="ic-section">
        <h2 class="c-label">Administración</h2>
        <nav class="c-list">${navRow('Fuentes de datos', 'data-action="fuentes"')}</nav>
      </section>
    </main>`;
  root.querySelector('[data-action="fuentes"]')!.addEventListener('click', () => go({ name: 'fuentes', hub }));
}
