import { ProcessActions } from './process-actions.js';
import { h, type Child } from './dom.js';
import { BackupsView } from './backups-view.js';
import { DiskToolsView } from './disk-tools-view.js';
import { systemDashboard, updateSystemReadings, type DashboardOptions } from './system-dashboard.js';
import { MENU_BAR_VALUE_OPTIONS, type MenuBarValue, type SystemSnapshot } from '../shared/system-monitor.js';
import type {
  AppState,
  CategoryId,
  CategoryInfo,
  CleanerApi,
  DeepScanPreview,
  InstalledApp,
  RunRecord,
  SettingsPatch,
  UninstallResult,
} from '../shared/types.js';
import {
  categoryDescription,
  categoryName,
  categorySafetyNote,
  formatWhen,
  formatSize,
  itemCount,
  modeLabel,
  safetyLabel,
  translateError,
} from './locale.js';

declare global {
  interface Window {
    cleaner: CleanerApi;
  }
}

type View = 'home' | 'activity' | 'optimize' | 'analyze' | 'deep' | 'uninstall' | 'backups' | 'history' | 'settings';

const api = window.cleaner;
const processActions = new ProcessActions(api, () => render(true));
const diskTools = new DiskToolsView(api, () => render(true));
const backupView = new BackupsView(api, () => render(true), updateSettings);
const viewEl = document.getElementById('view')!;

let state: AppState | null = null;
let view: View = 'home';
let error: string | null = null;

const deep = {
  selected: null as Set<CategoryId> | null,
  preview: null as DeepScanPreview | null,
  toDelete: new Set<CategoryId>(),
  expanded: new Set<CategoryId>(),
  confirming: false,
  result: null as RunRecord | null,
};

const expandedRuns = new Set<string>();
let installedApps: InstalledApp[] | null = null;
let installedAppWarnings: string[] = [];
let scanningInstalledApps = false;
let uninstallSearch = '';
let uninstallConfirmId: string | null = null;
let uninstallResult: UninstallResult | null = null;
// ---------------------------------------------------------------------------
// Actions

async function act<T>(fn: () => Promise<T>): Promise<T | undefined> {
  error = null;
  try {
    return await fn();
  } catch (e) {
    const message = e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e);
    error = translateError(message);
    render();
    return undefined;
  }
}

async function updateSettings(patch: SettingsPatch): Promise<void> {
  const next = await act(() => api.updateSettings(patch));
  if (next) {
    state = next;
    render();
  }
}

async function quickClean(): Promise<void> {
  await act(() => api.runQuickClean());
}

async function runDeepScan(): Promise<void> {
  const ids = [...(deep.selected ?? [])];
  deep.result = null;
  deep.confirming = false;
  const preview = await act(() => api.scanDeep(ids));
  if (preview) {
    deep.preview = preview;
    deep.toDelete = new Set(preview.categories.filter((c) => c.totalSize > 0 && c.safetyLevel !== 'risky').map((c) => c.id));
    render();
  }
}

async function runDeepClean(): Promise<void> {
  const ids = [...deep.toDelete];
  deep.confirming = false;
  const record = await act(() => api.cleanDeep(ids));
  if (record) {
    deep.result = record;
    deep.preview = null;
    render();
  } else if (error?.includes('expirou')) {
    // The main process refuses to delete from an old preview: go back so the user rescans.
    deep.preview = null;
    render();
  }
}

async function scanApps(preserveResult = false): Promise<void> {
  if (scanningInstalledApps) return;
  scanningInstalledApps = true;
  if (!preserveResult) uninstallResult = null;
  try {
    const found = await act(() => api.scanInstalledApps());
    if (found) {
      installedApps = found.apps;
      installedAppWarnings = found.warnings;
      uninstallConfirmId = null;
      render(true);
    }
  } finally {
    scanningInstalledApps = false;
  }
}

async function removeApp(id: string): Promise<void> {
  const result = await act(() => api.uninstallApplication(id));
  if (result) {
    uninstallResult = result;
    uninstallConfirmId = null;
    if (result.success) installedApps = (installedApps ?? []).filter((app) => app.id !== id);
    else await scanApps(true);
    render(true);
  }
}

// ---------------------------------------------------------------------------
// Shared pieces

function badge(text: string, kind: string): HTMLElement {
  return h('span', { class: `badge ${kind}` }, text);
}

function progressCard(s: AppState): HTMLElement | null {
  const { status } = s;
  if (status.phase === 'idle') return null;
  const pct = status.total ? Math.round(((status.completed ?? 0) / status.total) * 100) : 0;
  const verb = status.phase === 'scanning' ? 'Analisando' : 'Limpando';
  return h(
    'div',
    { class: 'card' },
    h(
      'div',
      { class: 'row' },
      h('div', { class: 'spinner' }),
      h('div', { class: 'grow ellipsis', style: 'flex:1' }, `${verb}${status.current ? ` ${categoryNameFromLabel(status.current)}` : ''}…`),
      h('span', { class: 'muted small' }, status.total ? `${status.completed}/${status.total}` : '')
    ),
    h('div', { class: 'bar' }, h('span', { style: `width:${pct}%` }))
  );
}

function activityCard(s: AppState): HTMLElement | null {
  const activity = s.activity;
  if (!activity) return null;
  const pct = activity.total ? Math.round((activity.completed / activity.total) * 100) : 0;
  return h(
    'div', { class: 'card activity-card' },
    h('div', { class: 'row' },
      h('div', { class: 'spinner' }),
      h('div', { class: 'grow ellipsis', style: 'flex:1' }, activity.current ? `${activity.label}: ${activityItemLabel(activity.current)}` : `${activity.label}…`),
      h('span', { class: 'muted small' }, activity.total ? `${activity.completed}/${activity.total}` : 'Em andamento')
    ),
    h('div', { class: 'bar' }, h('span', { style: `width:${pct}%` }))
  );
}

function activityItemLabel(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  if (!normalized.startsWith('/') && !normalized.startsWith('~/')) return value;
  return normalized.split('/').filter(Boolean).at(-1) ?? 'Item';
}

let systemSnapshot: SystemSnapshot | null = null;
let processQuery = '';
let processSort: DashboardOptions['sort'] = 'cpuPercent';
let processDescending = true;
const PROCESS_PAGE_SIZE = 100;
let visibleProcessCount = PROCESS_PAGE_SIZE;
function renderActivity(_s: AppState, existing?: HTMLElement): Child[] {
  return [systemDashboard(systemSnapshot, {
    query: processQuery, sort: processSort, descending: processDescending,
    selectedIdentity: processActions.selectedIdentity, selectionDisabled: processActions.locked,
    onSelect: (process) => processActions.select(process), processActions: processActions.render(systemSnapshot),
    visibleProcessCount,
    onShowMoreProcesses: () => { visibleProcessCount += PROCESS_PAGE_SIZE; render(true); },
    onQuery: (query) => { processQuery = query; visibleProcessCount = PROCESS_PAGE_SIZE; render(true); },
    onSort: (key) => {
      processDescending = processSort === key ? !processDescending : key !== 'name';
      processSort = key;
      visibleProcessCount = PROCESS_PAGE_SIZE;
      render(true);
    },
  }, existing)];
}

function categoryNameFromLabel(label: string): string {
  const category = state?.categories.find((item) => item.name === label);
  return category ? categoryName(category.id, label) : label;
}

function errorBanner(): HTMLElement | null {
  if (!error) return null;
  return h('div', { class: 'banner' }, h('div', { class: 'danger-text' }, error));
}

function fdaBanner(s: AppState): HTMLElement | null {
  if (s.fullDiskAccess !== false) return null;
  return h(
    'div',
    { class: 'banner' },
    h('strong', {}, 'Acesso total ao disco necessário'),
    h(
      'div',
      { class: 'small' },
      'Sem essa permissão, alguns caches não podem ser lidos ou removidos. Ative o Disk Mac em Privacidade e Segurança → Acesso Total ao Disco.'
    ),
    h('button', { class: 'btn link', onclick: () => void api.openFullDiskAccessSettings() }, 'Abrir Ajustes do Sistema →')
  );
}

function runBreakdown(record: RunRecord): HTMLElement {
  const rows = record.categories.filter((c) => c.cleanedItems > 0 || c.errors.length > 0);
  // Scanner failures live on the run, not on a category.
  const scanErrors = (record.errors ?? []).map((message) =>
    h('div', { class: 'list-item' }, h('div', { class: 'grow small danger-text' }, translateError(message)))
  );
  if (rows.length === 0 && scanErrors.length === 0) {
    return h('div', { class: 'muted small' }, 'Nenhum item precisava ser removido.');
  }
  return h(
    'div',
    { class: 'list' },
    record.backedUpSize && record.backedUpSize > 0 ? h('div', { class: 'list-item muted small' }, `Backup local do Disk Mac · ${formatSize(record.backedUpSize)} movidos (ainda ocupam espaço)`) : null,
    ...scanErrors,
    ...rows.map((c) =>
      h(
        'div',
        { class: 'list-item' },
        h(
          'div',
          { class: 'grow' },
          h('div', { class: 'ellipsis' }, categoryName(c.id, c.name)),
          h(
            'div',
            { class: 'muted small ellipsis' },
            `${itemCount(c.cleanedItems)}${c.errors.length ? ` · ${c.errors.map(translateError).join('; ')}` : ''}`
          )
        ),
        h('span', { class: 'size' }, c.backedUpSize ? `${formatSize(c.backedUpSize)} em backup` : formatSize(c.freedSpace))
      )
    )
  );
}

// ---------------------------------------------------------------------------
// Views

function renderHome(s: AppState): Child[] {
  const busy = s.status.phase !== 'idle' || s.activity !== null;
  const last = s.history[0];
  const diskUsed = s.disk ? 1 - s.disk.free / s.disk.total : 0;
  const diskClass = diskUsed > 0.95 ? 'danger' : diskUsed > 0.85 ? 'warn' : '';

  const autoLine = s.settings.autoClean.enabled
    ? s.nextAutoRunAt
      ? `Próxima limpeza automática: ${formatWhen(s.nextAutoRunAt)}`
      : 'Nenhuma categoria selecionada para a limpeza automática'
    : 'Limpeza automática desativada';

  return [
    errorBanner(),
    fdaBanner(s),
    s.disk &&
      h(
        'div',
        { class: 'card' },
        h(
          'div',
          { class: 'row' },
          h('span', { class: 'card-title' }, 'Disco'),
          h('span', { class: 'muted small' }, `${formatSize(s.disk.free)} livres de ${formatSize(s.disk.total)}`)
        ),
        h('div', { class: `bar ${diskClass}` }, h('span', { style: `width:${Math.round(diskUsed * 100)}%` }))
      ),
    progressCard(s),
    h(
      'div',
      { class: 'card' },
      h('span', { class: 'card-title' }, 'Espaço liberado'),
      h('div', { class: 'big-number' }, formatSize(s.totalFreed)),
      h('div', { class: 'muted small' }, autoLine)
    ),
    h(
      'div',
      { class: 'buttons' },
      h('button', { class: 'btn primary', disabled: busy, onclick: () => void quickClean() }, 'Limpar agora'),
      h('button', { class: 'btn', disabled: busy, onclick: () => setView('deep') }, 'Limpeza completa…')
    ),
    last &&
      h(
        'div',
        { class: 'card' },
        h(
          'div',
          { class: 'row' },
          h('span', { class: 'card-title' }, 'Última limpeza'),
          h('span', {}, badge(modeLabel(last.mode), last.mode === 'auto' ? 'auto' : ''))
        ),
        h(
          'div',
          { class: 'row' },
          h('span', { class: 'muted small' }, formatWhen(last.finishedAt)),
          h('strong', { class: last.freedSpace > 0 ? 'success-text' : '' }, `${formatSize(last.freedSpace)} liberados`)
        ),
        runBreakdown(last)
      ),
  ];
}

function renderDeep(s: AppState): Child[] {
  const busy = s.status.phase !== 'idle' || s.activity !== null;

  if (!deep.selected) {
    deep.selected = new Set(s.categories.filter((c) => c.safetyLevel !== 'risky').map((c) => c.id));
  }

  if (deep.result) {
    const r = deep.result;
    return [
      errorBanner(),
      h(
        'div',
        { class: 'card' },
        h('span', { class: 'card-title' }, 'Limpeza completa concluída'),
        h('div', { class: 'big-number success-text' }, formatSize(r.freedSpace)),
        h('div', { class: 'muted small' }, r.backedUpSize
          ? `${formatSize(r.backedUpSize)} movidos para backup; ${formatSize(r.freedSpace)} liberados diretamente.`
          : `${itemCount(r.cleanedItems)} removidos permanentemente`),
        runBreakdown(r)
      ),
      h(
        'div',
        { class: 'buttons' },
        h('button', { class: 'btn', onclick: () => { deep.result = null; render(); } }, 'Concluir')
      ),
    ];
  }

  if (deep.preview) {
    const p = deep.preview;
    const selectedSize = p.categories.filter((c) => deep.toDelete.has(c.id)).reduce((sum, c) => sum + c.totalSize, 0);
    const selectedItems = p.categories.filter((c) => deep.toDelete.has(c.id)).reduce((sum, c) => sum + c.itemCount, 0);
    const found = p.categories.filter((c) => c.totalSize > 0 || c.error);

    return [
      errorBanner(),
      progressCard(s),
      h(
        'div',
        { class: 'card' },
        h(
          'div',
          { class: 'row' },
          h('span', { class: 'card-title' }, 'Encontrado'),
          h('span', { class: 'muted small' }, formatSize(p.totalSize))
        ),
        found.length === 0
          ? h('div', { class: 'empty' }, 'Nada para limpar. 🎉')
          : h(
              'div',
              { class: 'list' },
              ...found.flatMap((c) => {
                const open = deep.expanded.has(c.id);
                return [
                  h(
                    'div',
                    { class: 'list-item' },
                    h('input', {
                      type: 'checkbox',
                      checked: deep.toDelete.has(c.id),
                      disabled: busy || c.totalSize === 0,
                      onchange: (e: Event) => {
                        if ((e.target as HTMLInputElement).checked) deep.toDelete.add(c.id);
                        else deep.toDelete.delete(c.id);
                        deep.confirming = false;
                        render();
                      },
                    }),
                    h(
                      'div',
                      {
                        class: 'grow',
                        onclick: () => {
                          if (open) deep.expanded.delete(c.id);
                          else deep.expanded.add(c.id);
                          render();
                        },
                      },
                      h('div', { class: 'ellipsis' }, `${open ? '▾' : '▸'} ${categoryName(c.id, c.name)} `, badge(safetyLabel(c.safetyLevel), c.safetyLevel)),
                      h(
                        'div',
                        { class: 'muted small ellipsis' },
                        c.error ? translateError(c.error) : itemCount(c.itemCount)
                      )
                    ),
                    h('span', { class: 'size' }, formatSize(c.totalSize))
                  ),
                  open &&
                    h(
                      'div',
                      { class: 'details' },
                      (categorySafetyNote(c.id, c.safetyNote) ?? c.safetyNote) && h('div', { class: 'small muted' }, `⚠︎ ${categorySafetyNote(c.id, c.safetyNote) ?? c.safetyNote}`),
                      ...c.topItems.map((item) =>
                        h(
                          'div',
                          { class: 'row' },
                          h(
                            'span',
                            {
                              class: 'path-link ellipsis',
                              title: item.path,
                              onclick: () => void api.revealPath(item.path),
                            },
                            item.name
                          ),
                          h('span', { class: 'size muted' }, formatSize(item.size))
                        )
                      ),
                      c.itemCount > c.topItems.length &&
                        h('div', { class: 'small muted' }, `…e mais ${c.itemCount - c.topItems.length}`)
                    ),
                ];
              })
            )
      ),
      deep.confirming
        ? h(
            'div',
            { class: 'banner' },
            h('strong', {}, `Continuar com ${itemCount(selectedItems)} (${formatSize(selectedSize)})?`),
            h('div', { class: 'small' }, s.settings.backupEnabled
              ? 'Itens compatíveis serão movidos para o backup. Categorias que usam ferramentas externas ou não suportam backup serão removidas diretamente.'
              : 'Os arquivos serão removidos diretamente, sem ir para a Lixeira. Esta ação não pode ser desfeita.'),
            h(
              'div',
              { class: 'buttons' },
              h('button', { class: 'btn', onclick: () => { deep.confirming = false; render(); } }, 'Cancelar'),
              h('button', { class: 'btn danger', disabled: busy, onclick: () => void runDeepClean() }, 'Remover')
            )
          )
        : h(
            'div',
            { class: 'buttons' },
            h('button', { class: 'btn', disabled: busy, onclick: () => { deep.preview = null; render(); } }, 'Voltar'),
            h(
              'button',
              {
                class: 'btn danger',
                disabled: busy || deep.toDelete.size === 0 || selectedSize === 0,
                onclick: () => { deep.confirming = true; render(); },
              },
              `Remover ${formatSize(selectedSize)}`
            )
          ),
    ];
  }

  const byLevel = (level: CategoryInfo['safetyLevel']) => s.categories.filter((c) => c.safetyLevel === level);
  const categoryRow = (c: CategoryInfo) =>
    h(
      'label',
      { class: 'list-item' },
      h('input', {
        type: 'checkbox',
        checked: deep.selected!.has(c.id),
        disabled: busy,
        onchange: (e: Event) => {
          if ((e.target as HTMLInputElement).checked) deep.selected!.add(c.id);
          else deep.selected!.delete(c.id);
          render();
        },
      }),
      h(
        'div',
        { class: 'grow' },
        h('div', { class: 'ellipsis' }, categoryName(c.id, c.name)),
        h('div', { class: 'muted small ellipsis', title: categorySafetyNote(c.id, c.safetyNote) ?? categoryDescription(c.id, c.description) }, categorySafetyNote(c.id, c.safetyNote) ?? categoryDescription(c.id, c.description))
      )
    );

  return [
    errorBanner(),
    fdaBanner(s),
    progressCard(s),
    h(
      'div',
      { class: 'card' },
      h('span', { class: 'card-title' }, 'Limpeza completa'),
      h(
        'div',
        { class: 'muted small' },
        'Analisa mais locais que a limpeza diária e permite remover os itens encontrados. Nada é removido sem sua confirmação.'
      ),
      h('div', { class: 'group-title' }, 'Seguro e requer atenção'),
      h('div', { class: 'list' }, ...[...byLevel('safe'), ...byLevel('moderate')].map(categoryRow)),
      h('div', { class: 'group-title danger-text' }, 'Arriscado — revise antes de remover'),
      h('div', { class: 'list' }, ...byLevel('risky').map(categoryRow))
    ),
    h(
      'div',
      { class: 'buttons' },
      h(
        'button',
        { class: 'btn primary', disabled: busy || deep.selected.size === 0, onclick: () => void runDeepScan() },
        `Analisar ${deep.selected.size} ${deep.selected.size === 1 ? 'categoria' : 'categorias'}`
      )
    ),
  ];
}

function renderUninstall(s: AppState): Child[] {
  const busy = s.status.phase !== 'idle' || s.activity !== null;
  const apps = installedApps ?? [];
  const query = uninstallSearch.trim().toLocaleLowerCase('pt-BR');
  const sourceName = (app: InstalledApp) => ({
    'app-bundle': 'Aplicativo macOS',
    'homebrew-cask': 'Homebrew Cask',
    'homebrew-formula': 'Homebrew Fórmula',
  })[app.source];
  const visibleApps = apps.filter((app) => !query || `${app.name} ${app.path ?? ''} ${sourceName(app)} ${app.version ?? ''}`.toLocaleLowerCase('pt-BR').includes(query));

  return [
    errorBanner(),
    uninstallResult && h('div', { class: uninstallResult.success ? 'banner success-banner' : 'banner' },
      h('strong', {}, uninstallResult.success ? 'Desinstalação concluída' : 'Desinstalação não concluída'),
      h('div', { class: 'small' }, `${uninstallResult.appName}: ${formatSize(uninstallResult.freedSpace)} liberados · ${uninstallResult.removedItems} itens removidos.`),
      ...uninstallResult.errors.map((message) => h('div', { class: 'small warning-text' }, translateError(message)))
    ),
    h('div', { class: 'row' },
      h('span', { class: 'muted small' }, installedApps === null ? 'A lista ainda não foi carregada.' : `${apps.length} itens encontrados`),
      h('button', { class: 'btn', disabled: busy, onclick: () => void scanApps() }, installedApps === null ? 'Buscar aplicativos' : 'Atualizar lista')
    ),
    installedApps !== null && h('input', {
      id: 'uninstall-search',
      class: 'search-input',
      type: 'search',
      value: uninstallSearch,
      placeholder: 'Buscar pelo nome ou local…',
      'aria-label': 'Buscar aplicativos instalados',
      oninput: (event: Event) => { uninstallSearch = (event.target as HTMLInputElement).value; render(true); },
    }),
    ...installedAppWarnings.map((warning) => h('div', { class: 'banner' }, h('strong', {}, 'Aviso da busca'), h('div', { class: 'small' }, translateError(warning)))),
    visibleApps.length === 0 && installedApps !== null
      ? h('div', { class: 'empty' }, query ? 'Nenhum aplicativo corresponde à busca.' : 'Nenhum aplicativo compatível foi encontrado nas pastas analisadas.')
      : h('div', { class: 'app-list' }, ...visibleApps.map((app) => {
        const confirming = uninstallConfirmId === app.id;
        return h('section', { class: 'card app-card' },
          h('div', { class: 'row app-card-top' },
            h('div', { class: 'grow' },
              h('div', { class: 'row app-name-line' }, h('strong', {}, app.name), badge(sourceName(app), app.source === 'homebrew-formula' ? 'moderate' : '')),
              app.path && h('div', { class: 'muted small ellipsis', title: app.path }, app.path),
              h('div', { class: 'muted small' }, app.source === 'homebrew-formula'
                ? `Homebrew · versão ${app.version || 'desconhecida'}`
                : `${formatSize(app.totalSize)} no total · ${app.relatedPaths.length} arquivos relacionados${app.version ? ` · versão ${app.version}` : ''}`)
            ),
            app.path && h('button', { class: 'btn link', onclick: () => void api.revealPath(app.path!) }, 'Mostrar no Finder')
          ),
          app.relatedPaths.length > 0 && h('details', {},
            h('summary', { class: 'muted small' }, 'Dados associados que serão removidos'),
            h('div', { class: 'app-details list' }, ...app.relatedPaths.map((path) => h('div', { class: 'list-item small ellipsis', title: path }, path)))
          ),
          confirming
            ? h('div', { class: 'banner' },
                  h('strong', {}, `Remover ${app.name}?`),
                  h('div', { class: 'small' }, app.source === 'homebrew-formula'
                    ? `O Homebrew removerá a fórmula ${app.name}. Dependências usadas por outros pacotes não serão removidas à força.`
                    : app.source === 'homebrew-cask'
                      ? `O Homebrew removerá o cask${app.version ? ` ${app.version}` : ''}; os dados de usuário listados serão excluídos permanentemente.`
                      : `O app e os ${app.relatedPaths.length} locais de dados associados serão excluídos permanentemente (${formatSize(app.totalSize)}).`),
                h('div', { class: 'buttons' },
                  h('button', { class: 'btn', disabled: busy, onclick: () => { uninstallConfirmId = null; render(); } }, 'Cancelar'),
                  h('button', { class: 'btn danger', disabled: busy, onclick: () => void removeApp(app.id) }, 'Excluir permanentemente')
                )
              )
            : h('button', { class: 'btn danger', disabled: busy, onclick: () => { uninstallConfirmId = app.id; render(); } }, 'Desinstalar…')
        );
      }))
  ];
}

function renderHistory(s: AppState): Child[] {
  if (s.history.length === 0) {
    return [h('div', { class: 'empty' }, 'Nenhuma limpeza registrada. A primeira execução aparecerá aqui.')];
  }
  return [
    h(
      'div',
      { class: 'card' },
      h(
        'div',
        { class: 'row' },
        h('span', { class: 'card-title' }, `${s.history.length} execuções`),
        h('span', { class: 'muted small' }, `${formatSize(s.totalFreed)} liberados no total`)
      ),
      h(
        'div',
        { class: 'list' },
        ...s.history.flatMap((r) => {
          const open = expandedRuns.has(r.id);
          return [
            h(
              'div',
              {
                class: 'list-item',
                onclick: () => {
                  if (open) expandedRuns.delete(r.id);
                  else expandedRuns.add(r.id);
                  render();
                },
              },
              h('span', { class: 'muted' }, open ? '▾' : '▸'),
              h(
                'div',
                { class: 'grow' },
                h('div', {}, formatWhen(r.finishedAt), ' ', badge(modeLabel(r.mode), r.mode === 'auto' ? 'auto' : '')),
                h('div', { class: 'muted small' }, itemCount(r.cleanedItems))
              ),
              h('span', { class: 'size' }, formatSize(r.freedSpace))
            ),
            open && h('div', { class: 'details' }, runBreakdown(r)),
          ];
        })
      )
    ),
    h(
      'div',
      { class: 'footer' },
      h('span', {}),
      h('button', { class: 'btn link', onclick: () => void act(() => api.clearHistory()).then((st) => { if (st) { state = st; render(); } }) }, 'Limpar histórico')
    ),
  ];
}

function toggleRow(label: string, hint: string | null, checked: boolean, onChange: (value: boolean) => void): HTMLElement {
  return h(
    'label',
    { class: 'list-item' },
    h('div', { class: 'grow' }, h('div', {}, label), hint && h('div', { class: 'muted small' }, hint)),
    h('input', {
      type: 'checkbox',
      class: 'toggle',
      checked,
      onchange: (e: Event) => onChange((e.target as HTMLInputElement).checked),
    })
  );
}

function renderSettings(s: AppState): Child[] {
  const auto = s.settings.autoClean;
  const autoCategories = s.categories.filter((c) => c.safetyLevel !== 'risky');

  return [
    errorBanner(),
    h(
      'div',
      { class: 'card' },
      h('span', { class: 'card-title' }, 'Limpeza automática'),
      h(
        'div',
        { class: 'list' },
        toggleRow('Limpar todos os dias', 'Executa em segundo plano', auto.enabled, (v) =>
          void updateSettings({ autoClean: { enabled: v } })
        ),
        h(
          'div',
          { class: 'list-item' },
          h('div', { class: 'grow' }, h('div', {}, 'Horário'), h('div', { class: 'muted small' }, 'Se o Mac estiver em repouso, executa quando ele despertar')),
          h('input', {
            type: 'time',
            value: `${String(auto.hour).padStart(2, '0')}:${String(auto.minute).padStart(2, '0')}`,
            disabled: !auto.enabled,
            onchange: (e: Event) => {
              const [hour, minute] = (e.target as HTMLInputElement).value.split(':').map(Number);
              void updateSettings({ autoClean: { hour, minute } });
            },
          })
        ),
        h(
          'div',
          { class: 'list-item' },
          h(
            'div',
            { class: 'grow' },
            h('div', {}, 'Manter arquivos temporários recentes'),
            h('div', { class: 'muted small' }, 'Horas sem uso antes de remover um arquivo temporário')
          ),
          h('input', {
            type: 'number',
            min: 0,
            max: 720,
            value: String(auto.tempFilesMinAgeHours),
            onchange: (e: Event) =>
              void updateSettings({ autoClean: { tempFilesMinAgeHours: Number((e.target as HTMLInputElement).value) } }),
          })
        )
      ),
      h('div', { class: 'group-title' }, 'Categorias da limpeza automática'),
      h(
        'div',
        { class: 'list' },
        ...autoCategories.map((c) =>
          h(
            'label',
            { class: 'list-item' },
            h('input', {
              type: 'checkbox',
              checked: auto.categories.includes(c.id),
              onchange: (e: Event) => {
                const set = new Set(auto.categories);
                if ((e.target as HTMLInputElement).checked) set.add(c.id);
                else set.delete(c.id);
                void updateSettings({ autoClean: { categories: [...set] } });
              },
            }),
            h(
              'div',
              { class: 'grow' },
              h('div', { class: 'ellipsis' }, `${categoryName(c.id, c.name)} `, badge(safetyLabel(c.safetyLevel), c.safetyLevel)),
              h('div', { class: 'muted small ellipsis', title: categoryDescription(c.id, c.description) }, categoryDescription(c.id, c.description))
            )
          )
        )
      ),
      h('div', { class: 'muted small' }, 'Categorias arriscadas (downloads, backups, arquivos grandes…) só ficam disponíveis na limpeza completa.')
    ),
    h(
      'div',
      { class: 'card' },
      h('span', { class: 'card-title' }, 'Geral'),
      h(
        'div',
        { class: 'list' },
        toggleRow('Notificar após a limpeza automática', null, s.settings.notifyAfterAutoClean, (v) =>
          void updateSettings({ notifyAfterAutoClean: v })
        ),
        toggleRow('Mostrar espaço liberado na barra de menus', null, s.settings.showFreedInMenuBar, (v) =>
          void updateSettings({ showFreedInMenuBar: v })
        ),
        toggleRow('Monitor do sistema na barra de menus', 'Clique no ícone para abrir os indicadores do Mac. O valor ao lado atualiza a cada 5 segundos em segundo plano.', s.settings.showActivityMonitorInMenuBar, (v) =>
          void updateSettings({ showActivityMonitorInMenuBar: v })
        ),
        h('label', { class: 'list-item' },
          h('span', { class: 'grow' }, 'Valor ao lado do gráfico'),
          h('select', { 'aria-label': 'Valor ao lado do gráfico', disabled: !s.settings.showActivityMonitorInMenuBar, onchange: (event: Event) =>
            void updateSettings({ menuBarValue: (event.target as HTMLSelectElement).value as MenuBarValue }) },
            ...Object.entries(MENU_BAR_VALUE_OPTIONS).map(([value, label]) =>
              h('option', { value, selected: s.settings.menuBarValue === value }, label))
          )
        ),
        toggleRow('Abrir ao iniciar sessão', 'Necessário para executar a limpeza diária', s.settings.launchAtLogin, (v) =>
          void updateSettings({ launchAtLogin: v })
        )
      )
    ),
    h('div', { class: 'card' },
      h('span', { class: 'card-title' }, 'Opções compartilhadas com a CLI'),
      h('label', { class: 'list-item' },
        h('div', { class: 'grow' }, h('div', {}, 'Considerar Downloads antigos após'), h('div', { class: 'muted small' }, 'A idade mínima usada na análise da categoria Downloads.')),
        h('input', {
          type: 'number', min: 1, max: 365, value: String(s.settings.downloadsDaysOld),
          onchange: (event: Event) => void updateSettings({ downloadsDaysOld: Number((event.target as HTMLInputElement).value) }),
        })
      ),
      h('label', { class: 'list-item' },
        h('div', { class: 'grow' }, h('div', {}, 'Tamanho mínimo para arquivos grandes'), h('div', { class: 'muted small' }, 'Arquivos menores que esse limite não entram na categoria Arquivos grandes.')),
        h('input', {
          type: 'number', min: 1, max: 102400, value: String(Math.round(s.settings.largeFilesMinSize / (1024 * 1024))),
          onchange: (event: Event) => void updateSettings({ largeFilesMinSize: Number((event.target as HTMLInputElement).value) * 1024 * 1024 }),
        }),
        h('span', { class: 'muted small' }, 'MB')
      )
    ),
    h(
      'div',
      { class: 'footer' },
      h('span', { class: 'muted small' }, `Disk Mac ${s.version}`),
      h('button', { class: 'btn link', onclick: () => void api.quit() }, 'Encerrar Disk Mac')
    ),
  ];
}

// ---------------------------------------------------------------------------

function setView(next: View): void {
  if (view === 'activity' && next !== 'activity') processActions.leave();
  view = next;
  void api.setSystemMonitorVisible(next === 'activity');
  if (next === 'activity') void api.getSystemSnapshot().then((snapshot) => { systemSnapshot = snapshot; render(); });
  error = null;
  viewEl.scrollTop = 0;
  render(true);
  if (next === 'uninstall' && installedApps === null && !scanningInstalledApps) void scanApps();
  if (next === 'optimize' || next === 'analyze') void diskTools.enter(next);
  if (next === 'backups') backupView.enter();
}

function render(force = false): void {
  document.querySelectorAll<HTMLButtonElement>('.tab').forEach((tab) => {
    tab.setAttribute('aria-selected', String(tab.dataset.view === view));
  });
  if (!state) return;

  // Don't yank an input out from under the user while they are editing it.
  const active = document.activeElement;
  if (!force && active instanceof HTMLInputElement && viewEl.contains(active) && active.type !== 'checkbox') {
    return;
  }
  const focusId = active instanceof HTMLElement && viewEl.contains(active) ? active.id : '';
  const selectionStart = focusId && active instanceof HTMLInputElement ? active.selectionStart : null;
  const selectionEnd = focusId && active instanceof HTMLInputElement ? active.selectionEnd : null;

  const scroll = viewEl.scrollTop;
  const tableScroll = viewEl.querySelector('.system-table-scroll, .analysis-table-scroll, .backup-preview-scroll')?.scrollTop ?? 0;
  const renderers: Record<View, (s: AppState) => Child[]> = {
    home: renderHome,
    activity: renderActivity,
    optimize: (s) => [diskTools.renderOptimize(s.status.phase !== 'idle' || Boolean(s.activity))],
    analyze: (s) => [diskTools.renderAnalyze(s.status.phase !== 'idle' || Boolean(s.activity))],
    deep: renderDeep,
    uninstall: renderUninstall,
    backups: (s) => [errorBanner(), backupView.render(s)],
    history: renderHistory,
    settings: renderSettings,
  };
  const title: Record<View, [string, string]> = {
    home: ['Visão geral', 'Acompanhe o espaço e as atividades do Disk Mac.'],
    activity: ['Monitor do sistema', 'CPU, memória, rede e processos do seu Mac em tempo real.'],
    optimize: ['Otimizar', 'Atualize caches e serviços com as ferramentas do macOS.'],
    analyze: ['Analisar disco', 'Explore suas pastas e descubra onde o espaço está sendo usado.'],
    deep: ['Limpeza completa', 'Revise categorias e confirme o que será removido.'],
    uninstall: ['Desinstalar aplicativos e pacotes', 'Remova apps, ferramentas do Homebrew e os dados relacionados encontrados.'],
    backups: ['Backups e restauração', 'Gerencie as cópias do Disk Mac e os snapshots locais do Time Machine.'],
    history: ['Histórico', 'Consulte as limpezas executadas pelo Disk Mac.'],
    settings: ['Ajustes', 'Configure a limpeza automática e o comportamento do aplicativo.'],
  };
  const heading = h('div', { class: 'page-heading' }, h('h1', {}, title[view][0]), h('p', {}, title[view][1]));
  const sharedActivity = view === 'activity' || (view === 'analyze' && state.activity?.kind === 'analyze') ? null : activityCard(state);
  const dashboard = view === 'activity' ? viewEl.querySelector<HTMLElement>('.system-dashboard') : null;
  if (dashboard) {
    renderActivity(state, dashboard);
  } else {
    const children = [heading, sharedActivity, ...renderers[view](state)].filter((c): c is Node | string => Boolean(c));
    viewEl.replaceChildren(...children);
  }
  viewEl.scrollTop = scroll;
  const table = viewEl.querySelector('.system-table-scroll, .analysis-table-scroll, .backup-preview-scroll');
  if (table) table.scrollTop = tableScroll;
  if (focusId) {
    const replacement = document.getElementById(focusId);
    if (replacement instanceof HTMLElement) {
      replacement.focus({ preventScroll: true });
      if (replacement instanceof HTMLInputElement && selectionStart !== null && selectionEnd !== null) replacement.setSelectionRange(selectionStart, selectionEnd);
    }
  }
}

document.querySelectorAll<HTMLButtonElement>('.tab').forEach((tab) => {
  tab.addEventListener('click', () => setView(tab.dataset.view as View));
});

api.onStateChanged((next) => {
  state = next;
  render();
});

api.onNavigateToActivity(() => setView('activity'));
api.onSystemSnapshot((snapshot) => {
  const sameProcesses = systemSnapshot?.processesSampledAt === snapshot.processesSampledAt;
  systemSnapshot = snapshot;
  if (view !== 'activity') return;
  const dashboard = viewEl.querySelector<HTMLElement>('.system-dashboard');
  if (!sameProcesses || !dashboard || !updateSystemReadings(dashboard, snapshot)) render(true);
});

void api.getState().then((initial) => {
  state = initial;
  render(true);
});
