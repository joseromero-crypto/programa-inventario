// In-memory navigation. Every page load starts at the hub picker (no remembered state);
// history entries carry the view so the phone's back button works inside the app.
export interface HubRef { hub_slug: string; display_name: string }
export type View = { name: 'picker' } | { name: 'hub'; hub: HubRef } | { name: 'fuentes'; hub?: HubRef };

type Renderer = (view: View) => void;
let render: Renderer = () => {};

export function startRouter(r: Renderer): void {
  render = r;
  const first: View = { name: 'picker' };
  history.replaceState(first, '');
  window.addEventListener('popstate', (e) => render((e.state as View | null) ?? first));
  render(first);
}

export function go(view: View): void {
  history.pushState(view, '');
  window.scrollTo(0, 0);
  render(view);
}

export function back(): void {
  history.back();
}
