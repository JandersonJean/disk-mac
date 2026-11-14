import { CATEGORIES, type CategoryId } from '../../../src/types.js';
import type { Settings, SettingsPatch } from '../shared/types.js';
import { MENU_BAR_VALUE_OPTIONS } from '../shared/system-monitor.js';

/**
 * Categories the daily automatic run cleans out of the box.
 * Only content that is regenerated on demand and never user data. Homebrew is
 * left out: its cleanup (`brew cleanup --prune=all`) also removes old formula
 * versions, which an unattended run should not decide on its own.
 */
export const DEFAULT_AUTO_CATEGORIES: CategoryId[] = ['temp-files', 'browser-cache', 'system-logs'];

/**
 * Categories a "deep clean" (hard delete) scans by default: everything that
 * is not flagged as risky. Risky ones can still be picked by hand.
 */
export const DEFAULT_DEEP_CATEGORIES: CategoryId[] = (Object.keys(CATEGORIES) as CategoryId[]).filter(
  (id) => CATEGORIES[id].safetyLevel !== 'risky'
);

/** Risky categories are never allowed in unattended runs. */
export function isAllowedInAutoClean(id: CategoryId): boolean {
  return id in CATEGORIES && CATEGORIES[id].safetyLevel !== 'risky';
}

export const DEFAULT_SETTINGS: Settings = {
  autoClean: {
    enabled: true,
    hour: 10,
    minute: 0,
    categories: DEFAULT_AUTO_CATEGORIES,
    tempFilesMinAgeHours: 24,
  },
  backupEnabled: false,
  backupRetentionDays: 7,
  downloadsDaysOld: 30,
  largeFilesMinSize: 500 * 1024 * 1024,
  notifyAfterAutoClean: true,
  launchAtLogin: true,
  showFreedInMenuBar: false,
  showActivityMonitorInMenuBar: false,
  menuBarValue: 'none',
};

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Applies a (possibly untrusted) patch on top of the current settings and
 * returns a fully validated settings object.
 */
export function mergeSettings(current: Settings, patch: SettingsPatch | unknown): Settings {
  const p = (patch && typeof patch === 'object' ? patch : {}) as SettingsPatch;
  const auto = (p.autoClean && typeof p.autoClean === 'object' ? p.autoClean : {}) as Partial<Settings['autoClean']>;

  let categories = current.autoClean.categories;
  if (Array.isArray(auto.categories)) {
    categories = [...new Set(auto.categories)].filter(
      (id): id is CategoryId => typeof id === 'string' && isAllowedInAutoClean(id as CategoryId)
    );
  }

  return {
    autoClean: {
      enabled: bool(auto.enabled, current.autoClean.enabled),
      hour: clampInt(auto.hour ?? current.autoClean.hour, 0, 23, current.autoClean.hour),
      minute: clampInt(auto.minute ?? current.autoClean.minute, 0, 59, current.autoClean.minute),
      categories,
      tempFilesMinAgeHours: clampInt(
        auto.tempFilesMinAgeHours ?? current.autoClean.tempFilesMinAgeHours,
        0,
        24 * 30,
        current.autoClean.tempFilesMinAgeHours
      ),
    },
    backupEnabled: bool(p.backupEnabled, current.backupEnabled),
    backupRetentionDays: clampInt(p.backupRetentionDays ?? current.backupRetentionDays, 1, 365, current.backupRetentionDays),
    downloadsDaysOld: clampInt(p.downloadsDaysOld ?? current.downloadsDaysOld, 1, 365, current.downloadsDaysOld),
    largeFilesMinSize: clampInt(p.largeFilesMinSize ?? current.largeFilesMinSize, 1024, 100 * 1024 * 1024 * 1024, current.largeFilesMinSize),
    notifyAfterAutoClean: bool(p.notifyAfterAutoClean, current.notifyAfterAutoClean),
    launchAtLogin: bool(p.launchAtLogin, current.launchAtLogin),
    showFreedInMenuBar: bool(p.showFreedInMenuBar, current.showFreedInMenuBar),
    showActivityMonitorInMenuBar: bool(p.showActivityMonitorInMenuBar, current.showActivityMonitorInMenuBar),
    menuBarValue: typeof p.menuBarValue === 'string' && Object.hasOwn(MENU_BAR_VALUE_OPTIONS, p.menuBarValue)
      ? p.menuBarValue : current.menuBarValue,
  };
}

/** Builds settings from whatever was persisted on disk, falling back to defaults. */
export function loadSettingsFrom(raw: unknown): Settings {
  return mergeSettings(DEFAULT_SETTINGS, raw);
}
