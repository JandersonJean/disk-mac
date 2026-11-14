import { LIVE_METRIC_INTERVAL_MS, METRIC_HISTORY_MS, PROCESS_INTERVAL_MS, type SystemSnapshot, type SystemProcess } from '../shared/system-monitor.js';

type Child = Node | string | null;
function el(tag: string, cls = '', ...children: Child[]): HTMLElement {
  const node = document.createElement(tag);
  node.className = cls;
  children.forEach((child) => { if (child !== null) node.append(child); });
  return node;
}
const percent = (n: number | null) => n === null ? '—' : `${n.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;
function bytes(n: number | null): string {
  if (n === null) return '—';
  const unit = Math.min(4, Math.max(0, Math.floor(Math.log2(Math.max(1, n)) / 10)));
  return `${(n / 1024 ** unit).toLocaleString('pt-BR', { maximumFractionDigits: unit ? 1 : 0 })} ${['B', 'KB', 'MB', 'GB', 'TB'][unit]}`;
}
const rate = (n: number | null) => n === null ? '—' : `${bytes(n)}/s`;

const SVG_NS = 'http://www.w3.org/2000/svg';
const CHART_WIDTH = 240;
const CHART_GAP_MS = 8_000;
const CHART_DURATION_MS = 480;
type ChartPoint = { at: number; value: number | null };
const chartAnimations = new WeakMap<SVGElement, Animation>();
const metricSnapshots = new WeakMap<HTMLElement, SystemSnapshot>();

function updateChart(svg: SVGSVGElement, points: ChartPoint[], label: string, minimumScale = 100): void {
  svg.setAttribute('viewBox', '0 0 240 48');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'system-sparkline');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);

  const end = points.at(-1)?.at;
  if (end === undefined) return;
  const from = end - METRIC_HISTORY_MS;
  // Retain one point to the left so lines can enter through the viewport edge.
  const firstVisible = points.findIndex((point) => point.at >= from);
  const series = points.slice(Math.max(0, firstVisible - 1));
  const peak = Math.max(minimumScale, ...series.map(({ value }) => value ?? 0));
  const scale = minimumScale === 100 ? 100 : 2 ** Math.ceil(Math.log2(peak));
  const y = (value: number) => 45 - Math.min(1, Math.max(0, value / scale)) * 42;
  const x = (timestamp: number) => (timestamp - from) / METRIC_HISTORY_MS * (CHART_WIDTH - 2);

  let previous: number | undefined;
  const path = series.map(({ at, value }) => {
    if (value === null) {
      previous = undefined;
      return '';
    }
    const command = previous !== undefined && at > previous && at - previous <= CHART_GAP_MS ? 'L' : 'M';
    previous = at;
    return `${command}${x(at).toFixed(2)},${y(value).toFixed(2)}`;
  }).join(' ');

  let plot = svg.querySelector('g');
  if (!plot) {
    plot = document.createElementNS(SVG_NS, 'g');
    plot.classList.add('system-sparkline-plot');
    const line = document.createElementNS(SVG_NS, 'path');
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', 'currentColor');
    line.setAttribute('stroke-width', '1.6');
    line.setAttribute('stroke-linecap', 'round');
    line.setAttribute('stroke-linejoin', 'round');
    line.setAttribute('vector-effect', 'non-scaling-stroke');
    const marker = document.createElementNS(SVG_NS, 'circle');
    marker.setAttribute('r', '1.6');
    marker.setAttribute('fill', 'currentColor');
    plot.append(line, marker);
    svg.append(plot);
  }
  plot.querySelector('path')!.setAttribute('d', path);
  const marker = plot.querySelector('circle')!;
  const latest = points.at(-1)?.value ?? null;
  if (latest === null) marker.setAttribute('visibility', 'hidden');
  else {
    marker.removeAttribute('visibility');
    marker.setAttribute('cx', String(x(end)));
    marker.setAttribute('cy', String(y(latest)));
  }

  const previousEnd = svg.dataset.end ? Number(svg.dataset.end) : null;
  svg.dataset.end = String(end);
  chartAnimations.get(plot)?.cancel();
  const delta = previousEnd === null ? 0 : end - previousEnd;
  if (delta > 0 && delta <= CHART_GAP_MS && svg.isConnected && !document.hidden
    && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const offset = delta / METRIC_HISTORY_MS * (CHART_WIDTH - 2) / CHART_WIDTH * 100;
    chartAnimations.set(plot, plot.animate(
      [{ transform: `translateX(${offset}%)` }, { transform: 'translateX(0)' }],
      { duration: CHART_DURATION_MS, easing: 'ease-out' },
    ));
  }
}

function updateMetrics(grid: HTMLElement, snapshot: SystemSnapshot): void {
  if (metricSnapshots.get(grid) === snapshot) return;
  metricSnapshots.set(grid, snapshot);
  const s = snapshot;
  const cards = [
    { title: 'CPU', value: percent(s.cpu.usagePercent), detail: `${s.cpu.logicalCores} núcleos lógicos · carga ${s.cpu.loadAverage[0]?.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) ?? '—'}`, chart: 'Histórico de uso total da CPU', field: 'cpuPercent' },
    { title: 'GPU', value: percent(s.gpuPercent ?? null), detail: s.gpuPercent == null ? 'Leitura indisponível' : 'Uso da GPU mais ativa', chart: 'Histórico de uso da GPU', field: 'gpuPercent' },
    { title: 'Memória', value: percent(s.memory.usagePercent), detail: `${bytes(s.memory.usedBytes)} usados de ${bytes(s.memory.totalBytes)}`, chart: 'Histórico de uso da memória', field: 'memoryPercent' },
    { title: 'Rede · recebendo', value: rate(s.network.receivedBytesPerSecond), detail: `↑ ${rate(s.network.sentBytesPerSecond)} enviados`, chart: 'Histórico de tráfego recebido', field: 'networkDown', minimumScale: 1024 },
    { title: 'Disco · disponível', value: bytes(s.disk?.freeBytes ?? null), detail: s.disk ? `${bytes(s.disk.usedBytes)} usados de ${bytes(s.disk.totalBytes)}` : 'Leitura indisponível' },
    { title: 'Swap', value: bytes(s.memory.swapUsedBytes), detail: `Comprimida: ${bytes(s.memory.compressedBytes)} · cache: ${bytes(s.memory.cachedBytes)}` },
    { title: 'Bateria', value: s.battery ? percent(s.battery.percent) : '—', detail: s.battery
      ? `${s.battery.powerSource} · ${s.battery.charging ? 'Carregando' : 'Sem carregamento'}` : 'Sem bateria ou leitura indisponível' },
  ] as const;
  const history = s.history.map((point) => ({ point, at: Date.parse(point.at) })).filter(({ at }) => Number.isFinite(at));
  cards.forEach((data, index) => {
    let card = grid.children.item(index);
    if (!card) {
      card = el('article', 'system-metric',
        el('div', 'system-label', data.title), el('strong', 'system-value'),
        'chart' in data ? document.createElementNS(SVG_NS, 'svg') : null, el('div', 'system-detail'));
      grid.append(card);
    }
    const value = card.querySelector('.system-value')!;
    const detail = card.querySelector('.system-detail')!;
    if (value.textContent !== data.value) value.textContent = data.value;
    if (detail.textContent !== data.detail) detail.textContent = data.detail;
    if ('chart' in data) {
      updateChart(card.querySelector('svg')!, history.map(({ point, at }) => ({ at, value: point[data.field] ?? null })),
        data.chart, 'minimumScale' in data ? data.minimumScale : undefined);
    }
  });
}

export interface DashboardOptions {
  compact?: boolean;
  query: string;
  sort: 'cpuPercent' | 'memoryBytes' | 'name' | 'pid';
  descending: boolean;
  onQuery(value: string): void;
  onSort(value: DashboardOptions['sort']): void;
  selectedIdentity?: string;
  selectionDisabled?: boolean;
  onSelect?(process: SystemProcess): void;
  processActions?: HTMLElement;
  visibleProcessCount?: number;
  onShowMoreProcesses?(): void;
}

export function updateSystemReadings(root: HTMLElement, snapshot: SystemSnapshot): boolean {
  const grid = root.querySelector<HTMLElement>('.system-metrics');
  const status = root.querySelector<HTMLElement>('.system-sample-status');
  const errors = root.querySelector<HTMLElement>('.system-errors');
  if (!grid || !status || !errors) return false;
  updateMetrics(grid, snapshot);
  const updated = new Date(snapshot.sampledAt).toLocaleTimeString('pt-BR');
  status.textContent = `Atualizado às ${updated} · indicadores a cada ${LIVE_METRIC_INTERVAL_MS} ms · processos a cada ${PROCESS_INTERVAL_MS / 1000} s`;
  errors.hidden = snapshot.errors.length === 0;
  errors.textContent = snapshot.errors.join(' · ');
  return true;
}

export function systemDashboard(snapshot: SystemSnapshot | null, options: DashboardOptions, existing?: HTMLElement): HTMLElement {
  const root = existing ?? el('section', `system-dashboard${options.compact ? ' compact-system' : ''}`);
  if (!snapshot) {
    root.replaceChildren(el('div', 'empty', 'Coletando os indicadores do Mac…'));
    return root;
  }
  const s = snapshot;
  let grid = root.querySelector<HTMLElement>('.system-metrics');
  if (!grid) {
    grid = el('div', 'system-metrics');
    root.replaceChildren(grid);
  }
  updateMetrics(grid, snapshot);
  while (grid.nextSibling) grid.nextSibling.remove();

  const panel = el('section', 'system-process-panel');
  const toolbar = el('div', 'system-process-toolbar', el('strong', '', options.compact ? 'Processos · maior uso de CPU' : `Processos do sistema (${s.processes.length})`));
  if (!options.compact) {
    const search = document.createElement('input');
    search.id = 'system-process-search';
    search.className = 'search-input';
    search.type = 'search';
    search.placeholder = 'Buscar nome, usuário ou PID';
    search.setAttribute('aria-label', 'Buscar processos do sistema');
    search.value = options.query;
    search.addEventListener('input', () => options.onQuery(search.value));
    toolbar.append(search);
  }
  panel.append(toolbar);
  if (!options.compact && options.processActions) panel.append(options.processActions);
  const table = document.createElement('table');
  table.className = 'system-process-table';
  const head = document.createElement('thead');
  const headers = document.createElement('tr');
  const cols: [string, DashboardOptions['sort']][] = [['Processo', 'name'], ['CPU', 'cpuPercent'], ['Memória', 'memoryBytes'], ['PID', 'pid']];
  for (const [label, key] of cols) {
    if (options.compact && key === 'pid') continue;
    const th = document.createElement('th');
    if (options.compact) th.textContent = label;
    else {
      const button = el('button', 'system-sort', label + (options.sort === key ? options.descending ? ' ↓' : ' ↑' : ''));
      button.addEventListener('click', () => options.onSort(key));
      th.setAttribute('aria-sort', options.sort === key ? options.descending ? 'descending' : 'ascending' : 'none');
      th.append(button);
    }
    headers.append(th);
  }
  if (!options.compact) headers.append(el('th', '', 'Usuário'));
  head.append(headers);
  table.append(head);
  const body = document.createElement('tbody');
  const query = options.query.toLocaleLowerCase('pt-BR');
  const processes = query
    ? s.processes.filter((p) => `${p.name} ${p.user} ${p.pid}`.toLocaleLowerCase('pt-BR').includes(query))
    : [...s.processes];
  const sort = options.compact ? 'cpuPercent' : options.sort;
  const direction = options.compact || options.descending ? -1 : 1;
  processes.sort((a: SystemProcess, b: SystemProcess) => {
    const first = a[sort], second = b[sort];
    if (first === null || second === null) {
      if (first === second) return b.memoryBytes - a.memoryBytes || a.pid - b.pid;
      return first === null ? 1 : -1;
    }
    const comparison = typeof first === 'string' ? first.localeCompare(String(second), 'pt-BR') : first - Number(second);
    return comparison * direction || a.pid - b.pid;
  });
  const visible = processes.slice(0, options.compact ? 5 : options.visibleProcessCount ?? processes.length);
  // Keep a selected process reachable when its rank changes between readings.
  if (!options.compact && options.selectedIdentity && !visible.some((p) => p.identity === options.selectedIdentity)) {
    const selected = processes.find((p) => p.identity === options.selectedIdentity);
    if (selected) visible.push(selected);
  }
  for (const p of visible) {
    const name = el('td', 'system-process-name');
    name.title = p.name;
    const selectable = !options.compact && Boolean(options.onSelect);
    const selected = selectable && options.selectedIdentity === p.identity;
    const row = el('tr', `${selectable ? 'process-selectable' : ''}${selected ? ' is-selected' : ''}`, name, el('td', '', percent(p.cpuPercent)), el('td', '', bytes(p.memoryBytes)));
    if (selectable) {
      const radio = document.createElement('input');
      radio.type = 'radio'; radio.name = 'selected-system-process'; radio.id = `system-process-select-${p.pid}`;
      radio.setAttribute('aria-label', `Selecionar ${p.name}, PID ${p.pid}`);
      radio.checked = selected; radio.disabled = Boolean(options.selectionDisabled);
      radio.addEventListener('change', () => { if (!options.selectionDisabled) options.onSelect?.(p); });
      name.append(el('label', 'process-name-label', radio, el('span', '', p.name)));
      row.addEventListener('click', (event) => {
        // The radio/label already handles keyboard and pointer selection.
        if (!options.selectionDisabled && !(event.target instanceof HTMLInputElement) && !(event.target instanceof Element && event.target.closest('label'))) options.onSelect?.(p);
      });
      row.setAttribute('aria-selected', String(selected));
    } else name.textContent = p.name;
    if (!options.compact) row.append(el('td', '', String(p.pid)), el('td', 'system-process-user', p.user));
    body.append(row);
  }
  table.append(body);
  const scroll = el('div', 'system-table-scroll', table);
  panel.append(scroll);
  if (!options.compact && options.onShowMoreProcesses && visible.length < processes.length) {
    const more = el('button', 'btn link', `Mostrar mais processos (${visible.length} de ${processes.length})`);
    more.id = 'show-more-system-processes';
    more.addEventListener('click', options.onShowMoreProcesses);
    panel.append(more);
  }
  if (!processes.length) panel.append(el('div', 'empty', !s.processesSampledAt ? 'Coletando processos…'
    : s.errors.some((e) => /^Processos:/.test(e)) ? 'A lista de processos está indisponível nesta leitura.' : 'Nenhum processo encontrado.'));
  root.append(panel);
  const footer = el('div', 'system-footnote', el('div', 'system-sample-status'));
  if (!options.compact) footer.append(el('div', '', 'A CPU por processo é calculada entre duas leituras. 100% equivale ao uso de um núcleo. Memória por processo é residente (RSS).'));
  root.append(footer, el('div', 'banner system-errors'));
  updateSystemReadings(root, s);
  return root;
}
