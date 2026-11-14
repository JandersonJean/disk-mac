import { ProcessController } from './process-control.js';
import { BackupManager } from './backup-manager.js';
import { removeReviewedSnapshots } from './backup-snapshots.js';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  powerMonitor,
  screen,
  shell,
  Tray,
  type IpcMainInvokeEvent,
} from 'electron';
import { constants } from 'node:fs';
import { access, copyFile, mkdir, statfs } from 'fs/promises';
import { dirname, join } from 'path';
import { ALL_SCANNERS } from '../../../src/scanners/index.js';
import { hasFullDiskAccess } from '../../../src/utils/fda.js';
import { formatSize } from '../../../src/utils/size.js';
import { restoreBackup } from '../../../src/utils/backup.js';
import { loadConfig, saveConfig } from '../../../src/utils/config.js';
import { scanUninstallTargets, uninstallTarget } from '../../../src/commands/uninstall.js';
import { listTimeMachineSnapshotDates } from '../../../src/maintenance/index.js';
import { IPC, type ActivityStatus, type AppState, type CategoryId, type DiskInfo, type RunRecord, type SettingsPatch } from '../shared/types.js';
import { CleanerController } from './controller.js';
import { Store } from './store.js';
import { SystemMonitor } from './system-monitor.js';
import { createTrayChart } from './tray-chart.js';
import { MENU_BAR_VALUE_OPTIONS, type MenuBarValue } from '../shared/system-monitor.js';
import { optimizationTasks, optimizeSystem } from './optimizer.js';
import { DiskExplorer, diskLocations, trashAnalyzedItems, trashRestriction } from './disk-explorer.js';

const TICK_INTERVAL_MS = 60 * 1000;
const FDA_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles';

function formatSizePtBr(bytes: number): string {
  return formatSize(bytes).replace('.', ',');
}

let tray: Tray | null = null;
let trayShowsMonitor = false;
let monitorWindow: BrowserWindow | null = null;
let monitorHiddenAt = 0;
let monitorViewVisible = false;
let quitting = false;
const systemMonitor = new SystemMonitor((snapshot) => {
  if (snapshot) {
    if (monitorViewVisible && isWindowVisible(win)) win.webContents.send(IPC.systemSnapshotChanged, snapshot);
    if (isWindowVisible(monitorWindow)) monitorWindow.webContents.send(IPC.systemSnapshotChanged, snapshot);
  }
  updateSystemTray();
});
let win: BrowserWindow | null = null;
let controller: CleanerController;
let store: Store;
let currentActivity: ActivityStatus | null = null;
const processController = new ProcessController();
const backupManager = new BackupManager();
const diskExplorer = new DiskExplorer(join(__dirname, 'disk-analysis-worker.cjs'));

const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) {
  app.quit();
}

/** Disk and permission probes are cheap but run on every progress update, so cache them briefly. */
function cached<T>(fn: () => Promise<T>, ttlMs: number): () => Promise<T> {
  let value: { at: number; promise: Promise<T> } | null = null;
  return () => {
    if (!value || Date.now() - value.at > ttlMs) {
      value = { at: Date.now(), promise: fn() };
    }
    return value.promise;
  };
}

const getDisk = cached(async (): Promise<DiskInfo | null> => {
  try {
    const stats = await statfs('/');
    return { total: stats.blocks * stats.bsize, free: stats.bavail * stats.bsize };
  } catch {
    return null;
  }
}, 5000);

const getFullDiskAccess = cached(hasFullDiskAccess, 10000);

function assetPath(name: string): string {
  return join(__dirname, '..', 'assets', name);
}

function runningAppBundlePath(): string | null {
  return app.isPackaged ? dirname(dirname(dirname(process.execPath))) : null;
}

function createTrayIcon(): Electron.NativeImage {
  const icon = nativeImage.createFromPath(assetPath('trayTemplate.png'));
  icon.setTemplateImage(true);
  return icon;
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 860,
    minHeight: 620,
    show: false,
    title: 'Disk Mac',
    center: true,
    backgroundColor: '#f6f6f8',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.loadFile(join(__dirname, 'renderer', 'index.html'));
  window.on('closed', () => {
    processController.cancel();
    if (win === window) win = null;
    monitorViewVisible = false;
    if (!quitting && tray && !tray.isDestroyed()) app.setActivationPolicy('accessory');
    syncSystemMonitoring();
  });

  window.on('show', syncSystemMonitoring);
  window.on('hide', syncSystemMonitoring);
  window.on('minimize', syncSystemMonitoring);
  window.on('restore', syncSystemMonitoring);

  // Only show our bundled page.
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());

  return window;
}

function showWindow(): void {
  if (!controller || quitting) return;
  if (!win) app.setActivationPolicy('regular');
  if (!win) win = createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  void controller.getState().then(broadcast);
}

function toggleWindow(): void {
  if (win?.isVisible()) {
    win.hide();
  } else {
    showWindow();
  }
}

function showActivityMonitor(): void {
  monitorWindow?.close();
  showWindow();
  const window = win;
  if (!window || quitting) return;
  const navigate = () => {
    if (!window.isDestroyed()) window.webContents.send(IPC.navigateToActivity);
  };
  if (window.webContents.isLoading()) window.webContents.once('did-finish-load', navigate);
  else navigate();
}

function broadcast(state: AppState): void {
  if (win && !win.isDestroyed()) {
    win.webContents.send(IPC.stateChanged, { ...state, activity: currentActivity });
  }
  updateTray(state);

}

function updateTray(state: AppState): void {
  if (!tray) return;
  const showMonitor = state.settings.showActivityMonitorInMenuBar;
  if (showMonitor !== trayShowsMonitor) {
    tray.setImage(showMonitor ? createTrayChart() : createTrayIcon());
    trayShowsMonitor = showMonitor;
  }
  if (showMonitor) { updateSystemTray(); return; }
  const busy = state.status.phase !== 'idle';
  const last = state.history[0];

  let title = '';
  if (busy) {
    title = ' …';
  } else if (state.settings.showFreedInMenuBar && last && last.freedSpace > 0) {
    title = ` ${formatSizePtBr(last.freedSpace)}`;
  }
  tray.setTitle(title);

  const tooltip = busy
    ? 'Disk Mac — limpeza em andamento…'
    : last
      ? `Disk Mac — última execução liberou ${formatSizePtBr(last.freedSpace)}`
      : 'Disk Mac';
  tray.setToolTip(tooltip);
}

function isWindowVisible(window: BrowserWindow | null): window is BrowserWindow {
  return Boolean(window && !window.isDestroyed() && window.isVisible() && !window.isMinimized());
}

function syncSystemMonitoring(): void {
  if (!store || quitting) return;
  if ((monitorViewVisible && isWindowVisible(win)) || isWindowVisible(monitorWindow)) {
    systemMonitor.setMode('full');
    return;
  }
  const { showActivityMonitorInMenuBar, menuBarValue } = store.settings;
  if (!showActivityMonitorInMenuBar || menuBarValue === 'none') {
    systemMonitor.setMode('off');
    return;
  }
  const metric = menuBarValue === 'cpu' || menuBarValue === 'memory' ? menuBarValue : 'network';
  systemMonitor.setMode(metric);
}

function updateSystemTray(): void {
  if (!tray || !store?.settings.showActivityMonitorInMenuBar) return;
  const point = systemMonitor.getHistory().at(-1);
  const metric = store.settings.menuBarValue;
  const percent = (value: number | null | undefined) =>
    value == null ? '—' : `${value.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;
  const rate = (value: number | null | undefined) =>
    value == null ? '—' : `${formatSizePtBr(Math.round(value))}/s`;
  const titles: Record<MenuBarValue, () => string> = {
    none: () => '',
    cpu: () => `CPU ${percent(point?.cpuPercent)}`,
    memory: () => `RAM ${percent(point?.memoryPercent)}`,
    'network-down': () => `↓ ${rate(point?.networkDown)}`,
    'network-up': () => `↑ ${rate(point?.networkUp)}`,
  };
  const title = titles[metric]();
  const display = title ? ` ${title}` : '';
  if (tray.getTitle() !== display) tray.setTitle(display, { fontType: 'monospacedDigit' });
  tray.setToolTip(title ? `Disk Mac — ${title} · clique para ver o sistema` : 'Disk Mac — clique para ver o sistema');
}

function toggleSystemPopover(): void {
  if (monitorWindow?.isVisible()) { monitorWindow.close(); return; }
  // A tray click can blur the panel before Electron dispatches the click itself.
  // Keep that click from immediately reopening the panel it just dismissed.
  if (Date.now() - monitorHiddenAt < 300) return;
  if (!monitorWindow) {
    monitorWindow = new BrowserWindow({
      width: 400, height: 690, show: false, frame: false, resizable: false,
      skipTaskbar: true, alwaysOnTop: true, roundedCorners: true,
      backgroundColor: '#202326',
      webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    const window = monitorWindow;
    window.loadFile(join(__dirname, 'renderer', 'monitor.html'));
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.on('blur', () => { if (!quitting && !window.isDestroyed()) window.close(); });
    window.on('show', syncSystemMonitoring);
    window.on('closed', () => {
      monitorHiddenAt = Date.now();
      monitorWindow = null;
      syncSystemMonitoring();
    });
  }
  const anchor = tray!.getBounds();
  const area = screen.getDisplayNearestPoint({ x: anchor.x, y: anchor.y }).workArea;
  const height = Math.min(690, area.height - 16);
  monitorWindow.setBounds({
    x: Math.round(Math.max(area.x + 8, Math.min(anchor.x + anchor.width / 2 - 200, area.x + area.width - 408))),
    y: Math.round(Math.max(area.y + 4, Math.min(anchor.y + anchor.height + 6, area.y + area.height - height - 8))),
    width: 400, height,
  });
  monitorWindow.show();
  monitorWindow.focus();
  syncSystemMonitoring();
}

function buildContextMenu(): Menu {
  return Menu.buildFromTemplate([
    { label: 'Abrir Disk Mac', click: showWindow },
    { label: 'Monitor do sistema', click: showActivityMonitor },
    {
      label: 'Valor ao lado do gráfico',
      enabled: store.settings.showActivityMonitorInMenuBar,
      submenu: (Object.entries(MENU_BAR_VALUE_OPTIONS) as [MenuBarValue, string][]).map(([value, label]) => ({
        label,
        type: 'radio',
        checked: store.settings.menuBarValue === value,
        click: () => { void controller.updateSettings({ menuBarValue: value }).catch(console.error); },
      })),
    },
    {
      label: 'Limpar agora',
      enabled: !controller.isBusy && !currentActivity,
      click: () => { if (!currentActivity) void controller.runQuickClean().catch(() => undefined); },
    },
    { type: 'separator' },
    {
      label: 'Abrir ao iniciar sessão',
      type: 'checkbox',
      checked: store.settings.launchAtLogin,
      click: (item) => void controller.updateSettings({ launchAtLogin: item.checked }),
    },
    { type: 'separator' },
    { label: 'Encerrar Disk Mac', role: 'quit' },
  ]);
}

function applyLoginItem(openAtLogin: boolean): void {
  // Registering a login item from an unpackaged dev build would point at the Electron binary.
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin });
}

function notifyRun(record: RunRecord): void {
  if (!Notification.isSupported()) return;
  if (record.mode === 'auto' && !store.settings.notifyAfterAutoClean) return;
  // Manual runs started from the popover show their result there.
  if (record.mode !== 'auto' && win?.isVisible()) return;

  const title = record.mode === 'auto' ? 'Limpeza diária concluída' : 'Limpeza concluída';
  const body =
    record.freedSpace > 0
      ? `${formatSizePtBr(record.freedSpace)} liberados em ${record.cleanedItems} ${record.cleanedItems === 1 ? 'item' : 'itens'}.`
      : 'Seu Mac já está limpo. Nada para remover.';
  const notification = new Notification({ title, body, silent: true });
  notification.on('click', showWindow);
  notification.show();
}

/** Only accept IPC from our own bundled page. */
function fromOurPage(event: IpcMainInvokeEvent): boolean {
  return [win, monitorWindow].some((window) => window && !window.isDestroyed() && window.webContents.id === event.sender.id)
    && (event.senderFrame?.url.startsWith('file://') ?? false);
}

function handle<T>(channel: string, fn: (...args: unknown[]) => Promise<T> | T): void {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!fromOurPage(event)) throw new Error('Unauthorized IPC sender');
    return fn(...args);
  });
}

function assertNoActiveWork(): void {
  if (controller.isBusy || currentActivity) throw new Error('Outra tarefa está em andamento. Aguarde a conclusão antes de iniciar uma nova.');
}

function stateWithActivity(): Promise<AppState> {
  return controller.getState().then((state) => ({ ...state, activity: currentActivity }));
}

async function runActivity<T>(
  kind: ActivityStatus['kind'],
  label: string,
  work: (progress: (completed: number, total: number, current?: string) => void) => Promise<T>
): Promise<T> {
  assertNoActiveWork();
  currentActivity = { kind, label, phase: 'running', completed: 0, total: 0, startedAt: new Date().toISOString() };
  broadcast(await controller.getState());
  const progress = (completed: number, total: number, current?: string) => {
    currentActivity = currentActivity ? { ...currentActivity, completed, total, current } : null;
    void controller.getState().then(broadcast);
  };
  try {
    return await work(progress);
  } finally {
    currentActivity = null;
    void controller.getState().then(broadcast);
  }
}

function registerIpc(): void {
  handle(IPC.getOptimizationTasks, () => optimizationTasks());
  handle(IPC.optimizeSystem, (ids) => runActivity('maintenance', 'Otimizando o Mac', (progress) => optimizeSystem(ids, progress)));
  handle(IPC.getDiskLocations, () => diskLocations());
  handle(IPC.chooseDiskFolder, async () => {
    const choice = await dialog.showOpenDialog(win!, { title: 'Escolha uma pasta ou volume para analisar', properties: ['openDirectory'] });
    return choice.canceled ? null : choice.filePaths[0] ?? null;
  });
  handle(IPC.analyzeDisk, (path) => {
    if (typeof path !== 'string') throw new Error('Selecione uma pasta válida.');
    return runActivity('analyze', 'Analisando o espaço em disco', async (progress) => {
      const report = await diskExplorer.scan(path, (update) => {
        progress(update.files, 0, update.currentPath);
        if (win && !win.isDestroyed()) win.webContents.send(IPC.diskAnalysisProgress, update);
      });
      const protectedPaths = [app.getPath('userData'), ...(runningAppBundlePath() ? [runningAppBundlePath()!] : [])];
      if (report) for (const entry of [...report.entries, ...report.largestFiles]) {
        entry.trashReason = trashRestriction(entry, report.path, protectedPaths) ?? undefined;
      }
      return report;
    });
  });
  handle(IPC.cancelDiskAnalysis, () => diskExplorer.cancel());
  handle(IPC.trashDiskItems, (id, paths) => runActivity('analyze', 'Movendo itens à Lixeira', async () => {
    const report = diskExplorer.report;
    if (!report || id !== report.id) throw new Error('A análise expirou. Analise a pasta novamente antes de mover itens à Lixeira.');
    const protectedPaths = [app.getPath('userData'), ...(runningAppBundlePath() ? [runningAppBundlePath()!] : [])];
    const result = await trashAnalyzedItems(report, paths, (path) => shell.trashItem(path), protectedPaths);
    if (result.moved.length) diskExplorer.report = null;
    return result;
  }));
  // Process control is available only in the full monitor, not the menu bar panel.
  ipcMain.handle(IPC.reviewProcessTermination, (event, target) => {
    if (!fromOurPage(event) || event.sender.id !== win?.webContents.id) throw new Error('Abra o Monitor do sistema na janela principal.');
    const known = systemMonitor.getSnapshot()?.processes.some((item) => item.pid === target?.pid && item.identity === target?.identity);
    if (!known) throw new Error('O processo não está na leitura atual. Selecione-o novamente.');
    return processController.review(target);
  });
  ipcMain.handle(IPC.terminateSystemProcess, async (event, token, mode) => {
    if (!fromOurPage(event) || event.sender.id !== win?.webContents.id) throw new Error('Abra o Monitor do sistema na janela principal.');
    const result = await processController.terminate(token, mode);
    void systemMonitor.refreshProcesses(true).catch(() => undefined);
    return result;
  });
  ipcMain.handle(IPC.cancelProcessTermination, (event, token) => {
    if (!fromOurPage(event) || event.sender.id !== win?.webContents.id) return;
    processController.cancel(token);
  });
  handle(IPC.getSystemSnapshot, () => systemMonitor.getSnapshot());
  handle(IPC.openSystemMonitor, showActivityMonitor);
  ipcMain.handle(IPC.setSystemMonitorVisible, (event, visible) => {
    if (!fromOurPage(event) || event.sender.id !== win?.webContents.id || typeof visible !== 'boolean') return;
    monitorViewVisible = visible;
    syncSystemMonitoring();
  });
  handle(IPC.getState, () => stateWithActivity());
  handle(IPC.updateSettings, async (patch) => {
    const settingsPatch = patch as SettingsPatch;
    const next = await controller.updateSettings(settingsPatch);
    if (
      typeof settingsPatch.backupEnabled === 'boolean' ||
      typeof settingsPatch.backupRetentionDays === 'number' ||
      typeof settingsPatch.downloadsDaysOld === 'number' ||
      typeof settingsPatch.largeFilesMinSize === 'number'
    ) {
      const config = await loadConfig();
      await saveConfig({
        ...config,
        backupEnabled: next.settings.backupEnabled,
        backupRetentionDays: next.settings.backupRetentionDays,
        downloadsDaysOld: next.settings.downloadsDaysOld,
        largeFilesMinSize: next.settings.largeFilesMinSize,
      });
    }
    return stateWithActivity();
  });
  handle(IPC.runQuickClean, () => { assertNoActiveWork(); return controller.runQuickClean(); });
  handle(IPC.scanDeep, (ids) => { assertNoActiveWork(); return controller.scanDeep(ids as CategoryId[]); });
  handle(IPC.cleanDeep, (ids) => { assertNoActiveWork(); return controller.cleanDeep(ids as CategoryId[]); });
  handle(IPC.clearHistory, async () => {
    await controller.clearHistory();
    return stateWithActivity();
  });
  handle(IPC.scanInstalledApps, () => runActivity('uninstall', 'Localizando aplicativos instalados', async (progress) => {
    const runningAppPath = runningAppBundlePath();
    const result = await scanUninstallTargets(runningAppPath ? [runningAppPath] : []);
    progress(1, 1, 'Aplicativos encontrados');
    return result;
  }));
  handle(IPC.uninstallApplication, (id) => {
    if (typeof id !== 'string') throw new Error('Invalid application identifier');
    const runningAppPath = runningAppBundlePath();
    return runActivity('uninstall', 'Desinstalando aplicativo', (progress) => uninstallTarget(id, progress, runningAppPath ? [runningAppPath] : []));
  });
  handle(IPC.listTimeMachineSnapshots, () => listTimeMachineSnapshotDates());
  handle(IPC.clearTimeMachineSnapshots, (dates) => runActivity('backup', 'Removendo snapshots locais', () => removeReviewedSnapshots(dates)));
  handle(IPC.getBackupOverview, () => runActivity('backup', 'Lendo backups locais', () => backupManager.overview()));
  handle(IPC.previewBackup, (path) => runActivity('backup', 'Conferindo arquivos do backup', () => backupManager.preview(path)));
  handle(IPC.trashExpiredBackups, (token, paths) => runActivity('backup', 'Movendo backups vencidos à Lixeira', () =>
    backupManager.trashExpired(token, paths, store.settings.backupRetentionDays, (path) => shell.trashItem(path))));
  handle(IPC.restoreBackup, (path) => runActivity('backup', 'Restaurando backup', async (progress) => {
    const selected = await backupManager.assertSession(path);
    progress(0, 1, 'Preservando arquivos que já existem nos destinos');
    const result = await restoreBackup(selected);
    progress(1, 1, 'Restauração concluída');
    return result;
  }));
  handle(IPC.openFullDiskAccessSettings, () => shell.openExternal(FDA_SETTINGS_URL));
  handle(IPC.revealPath, (path) => {
    if (typeof path === 'string' && path.startsWith('/')) shell.showItemInFolder(path);
  });
  handle(IPC.quit, () => app.quit());
}

function startScheduler(): void {
  const tick = () => { if (!currentActivity) void controller.tick().catch((error) => console.error('Auto clean failed:', error)); };
  setInterval(tick, TICK_INTERVAL_MS);
  powerMonitor.on('resume', tick);
  powerMonitor.on('unlock-screen', tick);
  // Give the system a moment after login before touching the disk.
  setTimeout(tick, 30 * 1000);
}

/** Preserve state created by the previously installed test and desktop builds. */
async function migrateLegacyState(): Promise<void> {
  const destinationDirectory = app.getPath('userData');
  const destination = join(destinationDirectory, 'state.json');
  try {
    await access(destination);
    return;
  } catch {
    // The new app has not written state yet.
  }

  const appData = app.getPath('appData');
  for (const legacyName of ['Mac Cleaner Fork Test', 'Mac Cleaner']) {
    const legacyState = join(appData, legacyName, 'state.json');
    try {
      await access(legacyState);
      await mkdir(destinationDirectory, { recursive: true });
      await copyFile(legacyState, destination, constants.COPYFILE_EXCL);
      console.info(`Migrated Disk Mac settings and history from ${legacyName}.`);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') return;
      if (code !== 'ENOENT') console.warn(`Could not migrate app data from ${legacyName}:`, error);
    }
  }
}

app.on('second-instance', showWindow);
app.on('activate', showWindow);

// Menu bar apps keep running with no windows open.
app.on('window-all-closed', () => undefined);

app.whenReady().then(async () => {
  if (!isPrimaryInstance) return;

  await migrateLegacyState();
  const cliConfig = await loadConfig();
  store = await Store.open(app.getPath('userData'));
  if (
    store.settings.backupEnabled !== (cliConfig.backupEnabled === true) ||
    store.settings.backupRetentionDays !== (cliConfig.backupRetentionDays ?? 7) ||
    store.settings.downloadsDaysOld !== (cliConfig.downloadsDaysOld ?? 30) ||
    store.settings.largeFilesMinSize !== (cliConfig.largeFilesMinSize ?? 500 * 1024 * 1024)
  ) {
    await store.updateSettings({
      backupEnabled: cliConfig.backupEnabled === true,
      backupRetentionDays: cliConfig.backupRetentionDays ?? 7,
      downloadsDaysOld: cliConfig.downloadsDaysOld ?? 30,
      largeFilesMinSize: cliConfig.largeFilesMinSize ?? 500 * 1024 * 1024,
    });
  }
  controller = new CleanerController({
    store,
    registry: ALL_SCANNERS,
    version: app.getVersion(),
    getDisk,
    getFullDiskAccess,
    getScanOptions: async () => ({ daysOld: store.settings.downloadsDaysOld, minSize: store.settings.largeFilesMinSize }),
    onStateChanged: broadcast,
    onRunFinished: notifyRun,
    onSettingsChanged: (state) => {
      applyLoginItem(state.settings.launchAtLogin);
      if (!state.settings.showActivityMonitorInMenuBar) monitorWindow?.close();
      syncSystemMonitoring();
    },
  });

  applyLoginItem(store.settings.launchAtLogin);
  registerIpc();

  tray = new Tray(createTrayIcon());
  tray.setIgnoreDoubleClickEvents(true);
  tray.on('click', () => store.settings.showActivityMonitorInMenuBar ? toggleSystemPopover() : toggleWindow());
  tray.on('right-click', () => tray?.popUpContextMenu(buildContextMenu()));
  syncSystemMonitoring();

  win = createWindow();
  win.once('ready-to-show', () => win?.show());
  updateTray(await controller.getState());
  startScheduler();
});

app.on('before-quit', () => {
  quitting = true;
  systemMonitor.setMode('off');
  diskExplorer.cancel();
});
