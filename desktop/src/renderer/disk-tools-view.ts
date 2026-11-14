import type { CleanerApi } from '../shared/types.js';
import type { DiskAnalysisProgress, DiskAnalysisReport, DiskEntry, DiskLocation, DiskTrashResult, OptimizationId, OptimizationReport, OptimizationTask } from '../shared/disk-tools.js';
import { h } from './dom.js';
import { formatSize } from './locale.js';
import { treemap } from './treemap.js';

const outcomeLabels = { applied: 'Concluída', skipped: 'Ignorada', failed: 'Falhou', cancelled: 'Cancelada' };
const entrySize = (entry: DiskEntry) => {
  if (entry.status === 'partial' && entry.inode === 0) return 'Não medido';
  return entry.status === 'unavailable' ? 'Indisponível' : `${formatSize(entry.bytes)}${entry.status === 'partial' ? '+' : ''}`;
};
const canOpen = (entry: DiskEntry) => entry.kind === 'directory' || entry.kind === 'application';

export class DiskToolsView {
  private tasks: OptimizationTask[] | null = null;
  private tasksLoading = false;
  private chosen = new Set<OptimizationId>();
  private reviewOptimization = false;
  private optimizing = false;
  private optimizationReport: OptimizationReport | null = null;
  private locations: DiskLocation[] | null = null;
  private locationsLoading = false;
  private report: DiskAnalysisReport | null = null;
  private progress: DiskAnalysisProgress | null = null;
  private scanning = false;
  private cancelling = false;
  private cancelled = false;
  private query = '';
  private mode: 'folders' | 'files' = 'folders';
  private selected = new Set<string>();
  private reviewTrash = false;
  private moving = false;
  private trashResult: DiskTrashResult | null = null;
  private visibleCount = 100;
  private error: string | null = null;

  constructor(private readonly api: CleanerApi, private readonly refresh: () => void) {
    api.onDiskAnalysisProgress((progress) => { this.progress = progress; this.refresh(); });
  }
  async enter(view: 'optimize' | 'analyze'): Promise<void> {
    try {
      if (view === 'optimize' && !this.tasks && !this.tasksLoading) {
        this.tasksLoading = true;
        this.tasks = await this.api.getOptimizationTasks();
        this.chosen = new Set(this.tasks.filter((task) => task.recommended && task.available).map((task) => task.id));
      }
      if (view === 'analyze' && !this.locations && !this.locationsLoading) {
        this.locationsLoading = true;
        this.locations = await this.api.getDiskLocations();
      }
    } catch (error) { this.setError(error); }
    finally { this.tasksLoading = false; this.locationsLoading = false; this.refresh(); }
  }
  private setError(error: unknown): void {
    this.error = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error);
  }
  private async optimize(): Promise<void> {
    this.optimizing = true; this.reviewOptimization = false; this.error = null; this.optimizationReport = null; this.refresh();
    try { this.optimizationReport = await this.api.optimizeSystem([...this.chosen]); }
    catch (error) { this.setError(error); }
    finally { this.optimizing = false; this.refresh(); }
  }
  private async chooseFolder(): Promise<void> {
    try { const path = await this.api.chooseDiskFolder(); if (path) await this.scan(path); }
    catch (error) { this.setError(error); this.refresh(); }
  }
  private async scan(path: string, preserveTrashResult = false): Promise<void> {
    if (this.scanning) return;
    this.scanning = true; this.cancelling = false; this.cancelled = false; this.error = null;
    this.report = null; this.progress = { path, currentPath: path, files: 0, bytes: 0, elapsedMs: 0 };
    this.selected.clear(); this.reviewTrash = false; this.query = ''; this.visibleCount = 100;
    if (!preserveTrashResult) this.trashResult = null;
    this.refresh();
    try { this.report = await this.api.analyzeDisk(path); this.cancelled = this.report === null; }
    catch (error) { this.setError(error); }
    finally { this.scanning = false; this.cancelling = false; this.refresh(); }
  }
  private async cancel(): Promise<void> {
    this.cancelling = true; this.refresh();
    try { await this.api.cancelDiskAnalysis(); }
    catch (error) { this.setError(error); this.cancelling = false; this.refresh(); }
  }
  private async trash(): Promise<void> {
    const report = this.report;
    if (!report) return;
    this.moving = true; this.reviewTrash = false; this.error = null; this.refresh();
    try {
      this.trashResult = await this.api.trashDiskItems(report.id, [...this.selected]);
      this.selected.clear();
      if (this.trashResult.moved.length) await this.scan(report.path, true);
    } catch (error) { this.setError(error); }
    finally { this.moving = false; this.refresh(); }
  }

  renderOptimize(otherBusy: boolean): HTMLElement {
    const busy = otherBusy || this.optimizing;
    const chosen = (this.tasks ?? []).filter((task) => this.chosen.has(task.id));
    return h('section', { class: 'disk-tools' },
      this.error && h('div', { class: 'banner' }, this.error),
      h('p', { class: 'muted small', style: 'margin:0' }, 'Escolha as rotinas necessárias. Revise os efeitos antes de executar e acompanhe o resultado de cada uma.'),
      !this.tasks && h('div', { class: 'empty' }, this.tasksLoading ? 'Verificando rotinas disponíveis…' : 'Não foi possível carregar as rotinas.',
        !this.tasksLoading && h('button', { class: 'btn', onclick: () => void this.enter('optimize') }, 'Tentar novamente')),
      ...(this.tasks ? [
        { title: 'Caches e serviços', description: 'Atualize componentes do Finder e da rede.', ids: ['quicklook', 'icons', 'dns', 'applications'] },
        { title: 'Diagnóstico e ações avançadas', description: 'Escolha conforme a necessidade. Algumas rotinas exigem administrador ou continuam em segundo plano.', ids: ['file-cache', 'spotlight', 'periodic', 'disk-check'] },
      ].map((group) => h('section', { class: 'optimization-group' },
        h('div', { class: 'optimization-group-heading' }, h('h3', {}, group.title), h('p', { class: 'muted small' }, group.description)),
        h('div', { class: 'optimization-grid' }, ...this.tasks!.filter((task) => group.ids.includes(task.id)).map((task) => this.optimizationCard(task, busy)))
      )) : []),
      this.tasks && h('div', { class: 'tool-action-bar' }, h('span', { class: 'muted' }, `${chosen.length} ${chosen.length === 1 ? 'rotina selecionada' : 'rotinas selecionadas'}`),
        h('button', { class: 'btn primary', disabled: busy || !chosen.length || this.reviewOptimization, onclick: () => { this.reviewOptimization = true; this.refresh(); } }, this.optimizing ? 'Otimizando…' : 'Revisar otimização…')),
      this.reviewOptimization && h('section', { class: 'banner tool-confirm' }, h('strong', {}, 'Executar as rotinas selecionadas?'),
        h('ul', {}, ...chosen.map((task) => h('li', {}, `${task.title}: ${task.impact}`))),
        h('div', { class: 'buttons' }, h('button', { class: 'btn', disabled: busy, onclick: () => { this.reviewOptimization = false; this.refresh(); } }, 'Cancelar'),
          h('button', { class: 'btn primary', disabled: busy, onclick: () => void this.optimize() }, `Executar ${chosen.length} ${chosen.length === 1 ? 'rotina' : 'rotinas'}`))),
      this.optimizationReport && h('section', { class: 'card optimization-report' }, h('div', { class: 'row' }, h('strong', {}, 'Resultado da otimização'),
        h('span', { class: 'muted small' }, new Date(this.optimizationReport.finishedAt).toLocaleTimeString('pt-BR'))),
        ...this.optimizationReport.results.map((result) => h('div', { class: 'optimization-result' },
          h('span', { class: `outcome-dot ${result.status}` }), h('div', { class: 'grow' }, h('strong', {}, result.title), h('p', { class: 'muted small' }, result.message)),
          h('span', { class: 'task-meta' }, outcomeLabels[result.status]))))
    );
  }

  private optimizationCard(task: OptimizationTask, busy: boolean): HTMLElement {
    return h('label', { class: `optimization-card${this.chosen.has(task.id) ? ' is-selected' : ''}${!task.available ? ' is-unavailable' : ''}` },
      h('input', { type: 'checkbox', checked: this.chosen.has(task.id), disabled: busy || !task.available || this.reviewOptimization,
        onchange: (event: Event) => { if ((event.target as HTMLInputElement).checked) this.chosen.add(task.id); else this.chosen.delete(task.id); this.refresh(); } }),
      h('div', { class: 'grow' }, h('strong', {}, task.title), h('p', { class: 'muted small' }, task.description),
        h('span', { class: 'task-meta' }, !task.available ? 'Indisponível neste Mac' : task.administrator ? 'Autorização do macOS' : 'Sem senha de administrador'),
        h('p', { class: 'task-impact' }, task.impact)));
  }

  renderAnalyze(otherBusy: boolean): HTMLElement {
    const busy = otherBusy || this.scanning || this.moving;
    const report = this.report;
    const list = report ? this.mode === 'folders' ? report.entries : report.largestFiles : [];
    const filtered = list.filter((entry) => `${entry.name} ${entry.path}`.toLocaleLowerCase('pt-BR').includes(this.query.toLocaleLowerCase('pt-BR')));
    const selectedEntries = list.filter((entry) => this.selected.has(entry.path));
    return h('section', { class: 'disk-tools' },
      this.error && h('div', { class: 'banner' }, this.error),
      h('div', { class: 'analysis-locations' }, ...(this.locations ?? []).map((location) => h('button', { class: 'location-button', disabled: busy, title: location.path, onclick: () => void this.scan(location.path) }, location.name)),
        h('button', { class: 'btn', disabled: busy, onclick: () => void this.chooseFolder() }, 'Escolher pasta ou volume…')),
      this.scanning && this.progress && h('div', { class: 'card analysis-progress' },
        h('div', { class: 'row' }, h('span', { class: 'spinner' }), h('strong', { class: 'grow' }, 'Medindo o espaço ocupado'),
          h('button', { class: 'btn', disabled: this.cancelling, onclick: () => void this.cancel() }, this.cancelling ? 'Cancelando…' : 'Cancelar análise')),
        h('div', { class: 'system-value' }, formatSize(this.progress.bytes)),
        h('div', { class: 'muted small' }, `${this.progress.files.toLocaleString('pt-BR')} arquivos encontrados · ${Math.round(this.progress.elapsedMs / 1000)} s`),
        h('div', { class: 'muted small ellipsis', title: this.progress.currentPath }, this.progress.currentPath)),
      !report && !this.scanning && h('div', { class: 'analysis-empty' }, h('span', { class: 'analysis-empty-mark', 'aria-hidden': 'true' }, '▦'),
        h('h2', {}, this.cancelled ? 'Análise cancelada' : 'Veja o que ocupa espaço'),
        h('p', { class: 'muted' }, 'Escolha uma pasta para visualizar a distribuição do espaço e encontrar arquivos grandes.')),
      this.trashResult && h('div', { class: this.trashResult.errors.length ? 'banner' : 'banner success-banner' },
        h('strong', {}, `${this.trashResult.moved.length} ${this.trashResult.moved.length === 1 ? 'item movido' : 'itens movidos'} à Lixeira.`),
        ...this.trashResult.errors.map((error) => h('p', { class: 'small' }, error))),
      report && h('div', { class: 'analysis-pathbar' },
        h('div', { class: 'analysis-breadcrumbs' }, ...this.breadcrumbs(report.path).map((crumb) => h('button', { class: 'breadcrumb', disabled: busy || crumb.path === report.path, title: crumb.path, onclick: () => void this.scan(crumb.path) }, crumb.name))),
        h('button', { class: 'btn', disabled: busy, onclick: () => void this.scan(report.path) }, 'Atualizar análise')),
      report && h('div', { class: 'analysis-stats' },
        h('div', {}, h('span', { class: 'system-label' }, 'Espaço medido'), h('strong', {}, report.status === 'unavailable' ? 'Indisponível' : `${formatSize(report.bytes)}${report.status === 'partial' ? '+' : ''}`)),
        h('div', {}, h('span', { class: 'system-label' }, 'Arquivos medidos'), h('strong', {}, report.status === 'unavailable' ? '—' : report.files.toLocaleString('pt-BR'))),
        h('div', {}, h('span', { class: 'system-label' }, 'Leitura'), h('strong', {}, report.status === 'complete' ? 'Concluída' : report.status === 'partial' ? 'Parcial' : 'Sem acesso'))),
      report && report.status !== 'complete' && h('div', { class: 'banner', role: 'status' },
        h('strong', {}, report.status === 'partial' ? 'Análise parcial' : 'Pasta indisponível'),
        ...report.warnings.map((warning) => h('p', { class: 'small' }, warning))),
      report && report.status !== 'unavailable' && this.map(report, busy),
      report && report.status !== 'unavailable' && h('section', { class: 'card analysis-items' },
        h('div', { class: 'analysis-table-toolbar' },
          h('div', { class: 'analysis-modes' }, ...(['folders', 'files'] as const).map((mode) => h('button', { class: this.mode === mode ? 'is-active' : '', 'aria-pressed': this.mode === mode, disabled: busy,
            onclick: () => { this.mode = mode; this.selected.clear(); this.reviewTrash = false; this.visibleCount = 100; this.refresh(); } }, mode === 'folders' ? 'Nesta pasta' : 'Maiores arquivos'))),
          h('input', { type: 'search', id: 'disk-analysis-search', class: 'search-input', value: this.query, placeholder: 'Filtrar por nome ou caminho', 'aria-label': 'Filtrar análise de disco', disabled: this.scanning,
            oninput: (event: Event) => { this.query = (event.target as HTMLInputElement).value; this.visibleCount = 100; this.refresh(); } })),
        this.mode === 'files' && h('p', { class: 'muted small' }, 'Os 50 maiores arquivos encontrados em toda a pasta analisada.'),
        h('div', { class: 'analysis-table-scroll' }, h('table', { class: 'analysis-table' },
          h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'Nome'), h('th', {}, 'Espaço em disco'), h('th', {}, 'Ações'))),
          h('tbody', {}, ...filtered.slice(0, this.visibleCount).map((entry) => this.entryRow(entry, report.bytes, busy))))),
        !filtered.length && h('div', { class: 'empty' }, 'Nenhum item corresponde ao filtro.'),
        filtered.length > this.visibleCount && h('button', { class: 'btn', onclick: () => { this.visibleCount += 100; this.refresh(); } }, `Mostrar mais (${filtered.length - this.visibleCount} restantes)`),
        h('div', { class: 'tool-action-bar' }, h('span', { class: 'muted small' }, `${this.selected.size} selecionados · ${formatSize(selectedEntries.reduce((sum, entry) => sum + entry.bytes, 0))} medidos`),
          h('button', { class: 'btn danger', disabled: busy || !this.selected.size || this.reviewTrash, onclick: () => { this.reviewTrash = true; this.refresh(); } }, 'Revisar envio à Lixeira…'))),
      this.reviewTrash && h('section', { class: 'banner tool-confirm' }, h('strong', {}, `Mover ${this.selected.size} ${this.selected.size === 1 ? 'item' : 'itens'} à Lixeira?`),
        h('p', { class: 'small' }, 'Você poderá restaurá-los pelo Finder. Os itens continuam ocupando espaço até esvaziar a Lixeira.'),
        h('p', { class: 'small' }, 'No APFS, cópias clonadas e snapshots podem manter blocos em uso. O espaço recuperado pode ser menor que o valor medido.'),
        h('ul', { class: 'trash-review-list' }, ...selectedEntries.map((entry) => h('li', {}, entry.path))),
        h('div', { class: 'buttons' }, h('button', { class: 'btn', disabled: busy, onclick: () => { this.reviewTrash = false; this.refresh(); } }, 'Cancelar'),
          h('button', { class: 'btn danger', disabled: busy, onclick: () => void this.trash() }, 'Mover à Lixeira'))),
      report && report.status !== 'unavailable' && h('p', { class: 'muted small analysis-footnote' }, 'A análise soma o espaço alocado dos itens lidos. No APFS, cópias clonadas podem compartilhar blocos. “+” indica que a medição ficou incompleta.')
    );
  }
  private breadcrumbs(path: string): DiskLocation[] {
    const parts = path.split('/').filter(Boolean);
    return [{ name: 'Disco', path: '/' }, ...parts.map((name, index) => ({ name, path: '/' + parts.slice(0, index + 1).join('/') }))];
  }
  private map(report: DiskAnalysisReport, busy: boolean): HTMLElement {
    const entries = report.entries.filter((entry) => entry.bytes > 0);
    const displayed = entries.slice(0, 23).map((entry) => ({ ...entry, other: false }));
    if (entries.length > 23) displayed.push({ ...entries[23], path: '', name: `Outros ${entries.length - 23} itens`, bytes: entries.slice(23).reduce((sum, entry) => sum + entry.bytes, 0), other: true });
    const tiles = treemap(displayed);
    return h('div', { class: 'disk-map', 'aria-label': 'Mapa da ocupação da pasta' },
      !tiles.length && h('div', { class: 'empty' }, 'Nenhum espaço mensurável nesta pasta.'),
      ...tiles.map(({ item, x, y, width, height }, index) => h('button', {
        class: `disk-tile tone-${index % 6}${height < 22 || width < 12 ? ' compact-tile' : ''}`, disabled: busy || item.other,
        style: `left:${x}%;top:${y}%;width:${width}%;height:${height}%;`,
        title: `${item.name} · ${entrySize(item)}`, 'aria-label': `${item.name}, ${entrySize(item)}`,
        onclick: () => canOpen(item) ? void this.scan(item.path) : void this.api.revealPath(item.path),
      }, h('strong', {}, item.name), h('span', {}, entrySize(item)))));
  }
  private entryRow(entry: DiskEntry, total: number, busy: boolean): HTMLElement {
    const restriction = entry.trashReason ?? (entry.kind === 'application' || /\.app(?:\/|$)/i.test(entry.path) ? 'Use Desinstalar apps.' : entry.status !== 'complete' ? 'A análise deste item está incompleta.' : null);
    return h('tr', {},
      h('td', {}, h('input', { type: 'checkbox', 'aria-label': `Selecionar ${entry.name}`, checked: this.selected.has(entry.path), disabled: busy || Boolean(restriction) || this.reviewTrash || (this.selected.size >= 100 && !this.selected.has(entry.path)), title: restriction ?? 'Selecionar para mover à Lixeira',
        onchange: (event: Event) => { if ((event.target as HTMLInputElement).checked) this.selected.add(entry.path); else this.selected.delete(entry.path); this.refresh(); } })),
      h('td', { class: 'analysis-name' }, h('button', { class: 'analysis-entry-name', disabled: busy, title: entry.path, onclick: () => canOpen(entry) ? void this.scan(entry.path) : void this.api.revealPath(entry.path) },
        h('span', { class: 'entry-icon', 'aria-hidden': 'true' }, canOpen(entry) ? '▸' : entry.kind === 'symlink' ? '↗' : '·'), entry.name),
        this.mode === 'files' && h('div', { class: 'muted small ellipsis', title: entry.path }, entry.path)),
      h('td', { class: 'analysis-size' }, entrySize(entry), h('div', { class: 'size-track' }, h('span', { style: `width:${total ? Math.min(100, entry.bytes / total * 100) : 0}%` }))),
      h('td', {}, h('button', { class: 'btn link', disabled: busy, onclick: () => void this.api.revealPath(entry.path) }, 'Finder')));
  }
}
