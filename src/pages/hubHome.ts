import { go, type HubRef } from '../router';
import { header, navRow, soonRow } from '../ui';

export function renderHubHome(root: HTMLElement, hub: HubRef): void {
  root.innerHTML = `
    <main class="c-page">
      ${header({ title: hub.display_name, back: 'Hubs' })}
      <nav class="c-list">
        ${navRow('Ruta del día', 'data-go="ruta"')}
        ${navRow('Plan', 'data-go="plan"')}
        ${soonRow('Seguimiento')}
      </nav>
      <section class="ic-section">
        <h2 class="c-label">Administración</h2>
        <nav class="c-list">${navRow('Fuentes de datos', 'data-go="fuentes"')}</nav>
      </section>
    </main>`;
  root.querySelectorAll<HTMLElement>('[data-go]').forEach((b) => b.addEventListener('click', () => {
    const name = b.dataset.go as 'ruta' | 'plan' | 'fuentes';
    go({ name, hub });
  }));
}
