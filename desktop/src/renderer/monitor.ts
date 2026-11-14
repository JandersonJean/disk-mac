import type { CleanerApi } from '../shared/types.js';
import type { SystemSnapshot } from '../shared/system-monitor.js';
import { systemDashboard, updateSystemReadings } from './system-dashboard.js';

const api = (window as Window & { cleaner: CleanerApi }).cleaner;
const container = document.getElementById('system-content')!;

// Electron can focus a scroll region as the popover opens. Only draw its focus
// ring after keyboard navigation, rather than making a mouse-opened panel look selected.
const clearKeyboardNavigation = () => document.body.classList.remove('keyboard-navigation');
document.addEventListener('pointerdown', clearKeyboardNavigation, true);
window.addEventListener('blur', clearKeyboardNavigation);
document.addEventListener('keydown', (event) => {
  if (['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
    document.body.classList.add('keyboard-navigation');
  }
});

let lastProcessesSampledAt: string | null | undefined;
function render(snapshot: SystemSnapshot | null): void {
  const scroll = container.scrollTop;
  const existing = container.querySelector<HTMLElement>('.system-dashboard') ?? undefined;
  if (snapshot && existing && snapshot.processesSampledAt === lastProcessesSampledAt
    && updateSystemReadings(existing, snapshot)) return;
  lastProcessesSampledAt = snapshot?.processesSampledAt;
  const dashboard = systemDashboard(snapshot, {
    compact: true, query: '', sort: 'cpuPercent', descending: true,
    onQuery: () => undefined, onSort: () => undefined,
  }, existing);
  if (!existing) container.replaceChildren(dashboard);
  container.scrollTop = scroll;
}
document.getElementById('open-system-monitor')!.addEventListener('click', () => void api.openSystemMonitor());
api.onSystemSnapshot(render);
void api.getSystemSnapshot().then(render);
