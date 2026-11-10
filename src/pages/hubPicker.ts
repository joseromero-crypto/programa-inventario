// Phase 0 placeholder. In 0.5 this lists the 7 MHs from ic_hub_config.
export function renderHubPicker(root: HTMLElement): void {
  root.innerHTML = `
    <main class="c-page">
      <header class="c-header">
        <div class="c-brand"><span class="c-brand-mark"></span>Calii</div>
        <h1 class="c-title">Confirmación de inventario</h1>
        <p class="c-sub">Elige un hub para empezar.</p>
      </header>
      <div class="c-empty">Los hubs aparecerán aquí cuando Supabase esté conectado.</div>
    </main>
  `;
}
