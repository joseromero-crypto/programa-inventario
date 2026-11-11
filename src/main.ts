import './styles/calii-theme.css';
import './styles/app.css';
import { back, startRouter, type View } from './router';
import { renderHubPicker } from './pages/hubPicker';
import { renderHubHome } from './pages/hubHome';
import { renderFuentes } from './pages/fuentes';
import { renderPlan } from './pages/plan';
import { renderRuta } from './pages/ruta';

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('#app not found');

root.addEventListener('click', (e) => {
  if ((e.target as Element).closest('[data-action="back"]')) back();
});

startRouter((view: View) => {
  switch (view.name) {
    case 'picker': return void renderHubPicker(root);
    case 'hub': return renderHubHome(root, view.hub);
    case 'fuentes': return void renderFuentes(root, view.hub);
    case 'plan': return void renderPlan(root, view.hub);
    case 'ruta': return void renderRuta(root, view.hub);
  }
});
