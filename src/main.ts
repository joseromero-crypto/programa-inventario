import './styles/calii-theme.css';
import './styles/app.css';
import { renderHubPicker } from './pages/hubPicker';

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('#app not found');

// No remembered state: every load starts at the hub picker.
renderHubPicker(root);
