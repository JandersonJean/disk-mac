import type { BackupOverview, BackupPreview, BackupTrashResult } from './backups.js';
import type { MenuBarValue, ProcessTerminationMode, ProcessTerminationReview, ProcessTerminationResult, ProcessTerminationTarget, SystemSnapshot } from './system-monitor.js';
import type { DiskAnalysisProgress, DiskAnalysisReport, DiskLocation, DiskTrashResult, OptimizationTask, OptimizationReport, OptimizationId } from './disk-tools.js';
import type { CategoryGroup, CategoryId, SafetyLevel } from '../../../src/types.js';

export type { CategoryId };

export type RunMode = 'auto' | 'quick' | 'deep';

export interface AutoCleanSettings {
  enabled: boolean;
  /** Local time of day for the daily run, 0-23 */
  hour: number;
  /** 0-59 */
  minute: number;
  categories: CategoryId[];
  /** Temp files are only removed by automatic runs when untouched for this many hours */
  tempFilesMinAgeHours: number;
}

export interface Settings {
  autoClean: AutoCleanSettings;
  backupEnabled: boolean;
  backupRetentionDays: number;
  downloadsDaysOld: number;
  largeFilesMinSize: number;
  notifyAfterAutoClean: boolean;
  launchAtLogin: boolean;
  /** Show the amount freed by the last run next to the menu bar icon */
  showFreedInMenuBar: boolean;
  /** Open the system monitor from the menu bar icon */
  showActivityMonitorInMenuBar: boolean;
  menuBarValue: MenuBarValue;
}

export interface CategoryRunResult {
  id: CategoryId;
  name: string;
  freedSpace: number;
  backedUpSize?: number;
  cleanedItems: number;
  errors: string[];
}

export interface RunRecord {
  id: string;
  mode: RunMode;
  startedAt: string;
  finishedAt: string;
  freedSpace: number;
  backedUpSize?: number;
  backupDir?: string;
  cleanedItems: number;
  categories: CategoryRunResult[];
  errors: string[];
}

export interface CategoryInfo {
  id: CategoryId;
  name: string;
  group: CategoryGroup;
  description: string;
  safetyLevel: SafetyLevel;
  safetyNote?: string;
}

export interface ScanPreviewItem {
  name: string;
  path: string;
  size: number;
}

export interface CategoryScanPreview {
  id: CategoryId;
  name: string;
  safetyLevel: SafetyLevel;
  safetyNote?: string;
  totalSize: number;
  itemCount: number;
  topItems: ScanPreviewItem[];
  error?: string;
}

export interface DeepScanPreview {
  scannedAt: string;
  totalSize: number;
  categories: CategoryScanPreview[];
}

export type RunPhase = 'idle' | 'scanning' | 'cleaning';

export interface RunStatus {
  phase: RunPhase;
  mode?: RunMode;
  completed?: number;
  total?: number;
  current?: string;
}

export interface DiskInfo {
  total: number;
  free: number;
}

export interface AppState {
  version: string;
  settings: Settings;
  history: RunRecord[];
  totalFreed: number;
  nextAutoRunAt: string | null;
  status: RunStatus;
  disk: DiskInfo | null;
  fullDiskAccess: boolean | null;
  categories: CategoryInfo[];
  activity: ActivityStatus | null;
}

export interface ActivityStatus {
  kind: 'uninstall' | 'maintenance' | 'backup' | 'analyze';
  label: string;
  phase: 'running';
  completed: number;
  total: number;
  current?: string;
  startedAt: string;
}

export interface InstalledApp {
  id: string;
  source: 'app-bundle' | 'homebrew-cask' | 'homebrew-formula';
  name: string;
  path?: string;
  size: number;
  relatedPaths: string[];
  totalSize: number;
  version?: string;
}

export interface InstalledAppsResult {
  apps: InstalledApp[];
  warnings: string[];
}

export interface UninstallResult {
  success: boolean;
  appName: string;
  freedSpace: number;
  removedItems: number;
  errors: string[];
}

export interface MaintenanceResult {
  success: boolean;
  message: string;
  error?: string;
  requiresSudo?: boolean;
}

export interface SnapshotList {
  dates: string[];
  error?: string;
}

export interface BackupInfo {
  path: string;
  date: string;
  size: number;
}

export interface BackupRestoreResult {
  success: number;
  failed: number;
  errors: string[];
}

export type SettingsPatch = Partial<Omit<Settings, 'autoClean'>> & {
  autoClean?: Partial<AutoCleanSettings>;
};

/** API exposed to the renderer through the preload script (window.cleaner) */
export interface CleanerApi {
  getOptimizationTasks(): Promise<OptimizationTask[]>;
  optimizeSystem(ids: OptimizationId[]): Promise<OptimizationReport>;
  getDiskLocations(): Promise<DiskLocation[]>;
  chooseDiskFolder(): Promise<string | null>;
  analyzeDisk(path: string): Promise<DiskAnalysisReport | null>;
  cancelDiskAnalysis(): Promise<void>;
  trashDiskItems(reportId: string, paths: string[]): Promise<DiskTrashResult>;
  onDiskAnalysisProgress(listener: (progress: DiskAnalysisProgress) => void): () => void;
  reviewProcessTermination(target: ProcessTerminationTarget): Promise<ProcessTerminationReview>;
  cancelProcessTermination(token: string): Promise<void>;
  terminateSystemProcess(token: string, mode: ProcessTerminationMode): Promise<ProcessTerminationResult>;
  getSystemSnapshot(): Promise<SystemSnapshot | null>;
  setSystemMonitorVisible(visible: boolean): Promise<void>;
  openSystemMonitor(): Promise<void>;
  onSystemSnapshot(listener: (snapshot: SystemSnapshot) => void): () => void;
  getState(): Promise<AppState>;
  updateSettings(patch: SettingsPatch): Promise<AppState>;
  runQuickClean(): Promise<RunRecord | null>;
  scanDeep(categoryIds: CategoryId[]): Promise<DeepScanPreview>;
  cleanDeep(categoryIds: CategoryId[]): Promise<RunRecord | null>;
  clearHistory(): Promise<AppState>;
  scanInstalledApps(): Promise<InstalledAppsResult>;
  uninstallApplication(id: string): Promise<UninstallResult>;
  listTimeMachineSnapshots(): Promise<SnapshotList>;
  clearTimeMachineSnapshots(dates: string[]): Promise<MaintenanceResult>;
  getBackupOverview(): Promise<BackupOverview>;
  previewBackup(path: string): Promise<BackupPreview>;
  trashExpiredBackups(token: string, paths: string[]): Promise<BackupTrashResult>;
  restoreBackup(path: string): Promise<BackupRestoreResult>;
  openFullDiskAccessSettings(): Promise<void>;
  revealPath(path: string): Promise<void>;
  quit(): Promise<void>;
  onNavigateToActivity(listener: () => void): () => void;
  onStateChanged(listener: (state: AppState) => void): () => void;
}

export const IPC = {
  getOptimizationTasks: 'cleaner:optimization-tasks',
  optimizeSystem: 'cleaner:optimize-system',
  getDiskLocations: 'cleaner:disk-locations',
  chooseDiskFolder: 'cleaner:choose-disk-folder',
  analyzeDisk: 'cleaner:analyze-disk',
  cancelDiskAnalysis: 'cleaner:cancel-disk-analysis',
  trashDiskItems: 'cleaner:trash-disk-items',
  diskAnalysisProgress: 'cleaner:disk-analysis-progress',
  reviewProcessTermination: 'cleaner:review-process-termination',
  cancelProcessTermination: 'cleaner:cancel-process-termination',
  terminateSystemProcess: 'cleaner:terminate-system-process',
  getSystemSnapshot: 'cleaner:system-snapshot',
  setSystemMonitorVisible: 'cleaner:system-visible',
  openSystemMonitor: 'cleaner:open-system-monitor',
  systemSnapshotChanged: 'cleaner:system-snapshot-changed',
  getState: 'cleaner:get-state',
  updateSettings: 'cleaner:update-settings',
  runQuickClean: 'cleaner:run-quick-clean',
  scanDeep: 'cleaner:scan-deep',
  cleanDeep: 'cleaner:clean-deep',
  clearHistory: 'cleaner:clear-history',
  scanInstalledApps: 'cleaner:scan-installed-apps',
  uninstallApplication: 'cleaner:uninstall-application',
  listTimeMachineSnapshots: 'cleaner:list-time-machine-snapshots',
  clearTimeMachineSnapshots: 'cleaner:clear-time-machine-snapshots',
  getBackupOverview: 'cleaner:backup-overview',
  previewBackup: 'cleaner:preview-backup',
  trashExpiredBackups: 'cleaner:trash-expired-backups',
  restoreBackup: 'cleaner:restore-backup',
  openFullDiskAccessSettings: 'cleaner:open-fda-settings',
  revealPath: 'cleaner:reveal-path',
  quit: 'cleaner:quit',
  navigateToActivity: 'cleaner:navigate-to-activity',
  stateChanged: 'cleaner:state-changed',
} as const;
