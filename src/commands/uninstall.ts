import chalk from 'chalk';
import confirm from '@inquirer/confirm';
import checkbox from '@inquirer/checkbox';
import { physicalFs } from '../utils/physical-fs.js';
import { spawn } from 'child_process';
import { join, basename, resolve } from 'path';
import { homedir } from 'os';
import { exists, getSize, formatSize, createCleanProgress, isProtectedPath, validatePathSafety, sanitizeDisplayName } from '../utils/index.js';
import { debugError, errorCode, formatError } from '../utils/errors.js';

const { readdir, stat, rm, readFile, lstat, unlink, access } = physicalFs;

/**
 * Escapes all regex metacharacters in a string.
 * This prevents regex injection attacks when using user-provided patterns.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Reads the bundle identifier from an app's Info.plist.
 * This is more secure than guessing from the app name.
 */
async function getBundleId(appPath: string): Promise<string | null> {
  try {
    const plistPath = join(appPath, 'Contents', 'Info.plist');
    const content = await readFile(plistPath);
    let plistContent = content.toString('utf-8');
    if (content.subarray(0, 6).toString() === 'bplist') {
      plistContent = await convertBinaryPlistToXml(plistPath);
    }
    
    // Parse CFBundleIdentifier from plist
    // Note: This is a simple regex parser. For production, consider using a proper plist parser.
    const match = plistContent.match(/<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/);
    if (match && match[1]) {
      // Validate the bundle ID format (should be reverse domain notation)
      const bundleId = match[1].trim();
      if (/^[a-zA-Z][a-zA-Z0-9.-]*$/.test(bundleId)) {
        return bundleId;
      }
    }
    return null;
  } catch (error) {
    debugError(`getBundleId(${appPath})`, error);
    return null;
  }
}

function convertBinaryPlistToXml(plistPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', plistPath], {
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr || `plutil exited with code ${code}`)));
  });
}

/**
 * Safely removes a file or directory with security checks.
 * Returns the failure reason, or null on success.
 */
async function safeRemove(path: string): Promise<string | null> {
  // Validate path safety
  const safetyError = validatePathSafety(path);
  if (safetyError) {
    console.error(safetyError);
    return 'blocked by safety check';
  }

  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) {
      await unlink(path);
    } else {
      await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
    return null;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    debugError(`safeRemove(${path})`, error);
    return errorCode(error);
  }
}

function removalFailure(label: string, code: string): string {
  const hint = code === 'ENOTEMPTY' || code === 'EBUSY'
    ? ' Feche o aplicativo e tente novamente; ainda há arquivos na pasta.'
    : code === 'EACCES' || code === 'EPERM'
      ? ' Verifique as permissões desse local no macOS.'
      : '';
  return `Não foi possível remover ${label} (${code}).${hint}`;
}

export interface InstalledAppInfo {
  name: string;
  path: string;
  size: number;
  relatedPaths: string[];
  totalSize: number;
}

export interface UninstallResult {
  success: boolean;
  appName: string;
  freedSpace: number;
  removedItems: number;
  errors: string[];
}

export type InstallSource = 'app-bundle' | 'homebrew-cask' | 'homebrew-formula';

export type InstalledTarget = Omit<InstalledAppInfo, 'path'> & {
  id: string;
  source: InstallSource;
  path?: string;
  version?: string;
};

export interface InstalledTargetsResult {
  apps: InstalledTarget[];
  warnings: string[];
}

interface UninstallCommandOptions {
  yes?: boolean;
  dryRun?: boolean;
  noProgress?: boolean;
}

const APPLICATIONS_DIR = '/Applications';
const USER_APPLICATIONS_DIR = join(homedir(), 'Applications');

const RELATED_PATHS_TEMPLATES = [
  join(homedir(), 'Library', 'Application Support', '{APP_NAME}'),
  join(homedir(), 'Library', 'Preferences', '{BUNDLE_ID}.plist'),
  join(homedir(), 'Library', 'Preferences', '{APP_NAME}.plist'),
  join(homedir(), 'Library', 'Caches', '{APP_NAME}'),
  join(homedir(), 'Library', 'Caches', '{BUNDLE_ID}'),
  join(homedir(), 'Library', 'Logs', '{APP_NAME}'),
  join(homedir(), 'Library', 'Saved Application State', '{BUNDLE_ID}.savedState'),
  join(homedir(), 'Library', 'WebKit', '{APP_NAME}'),
  join(homedir(), 'Library', 'HTTPStorages', '{BUNDLE_ID}'),
  join(homedir(), 'Library', 'Containers', '{BUNDLE_ID}'),
  join(homedir(), 'Library', 'Group Containers', '*.{APP_NAME}'),
];

export async function uninstallCommand(options: UninstallCommandOptions): Promise<void> {
  console.log(chalk.cyan('\nScanning installed applications...\n'));

  const apps = await scanInstalledApps();

  if (apps.length === 0) {
    console.log(chalk.yellow('No applications found.\n'));
    return;
  }

  const choices = apps.map((app) => ({
    name: `${sanitizeDisplayName(app.name).padEnd(35)} ${chalk.yellow(formatSize(app.totalSize).padStart(10))} ${chalk.dim(`(+${app.relatedPaths.length} related)`)}`,
    value: app.name,
    checked: false,
  }));

  const selectedApps = await checkbox<string>({
    message: 'Select applications to uninstall:',
    choices,
    pageSize: 15,
  });

  if (selectedApps.length === 0) {
    console.log(chalk.yellow('\nNo applications selected.\n'));
    return;
  }

  const appsToRemove = apps.filter((a) => selectedApps.includes(a.name));
  const totalSize = appsToRemove.reduce((sum, a) => sum + a.totalSize, 0);
  const totalPaths = appsToRemove.reduce((sum, a) => sum + 1 + a.relatedPaths.length, 0);

  console.log();
  console.log(chalk.bold('Applications to uninstall:'));
  for (const app of appsToRemove) {
    console.log(`  ${chalk.red('✗')} ${sanitizeDisplayName(app.name)} (${formatSize(app.totalSize)})`);
    for (const related of app.relatedPaths) {
      console.log(chalk.dim(`      └─ ${sanitizeDisplayName(related.replace(homedir(), '~'))}`));
    }
  }
  console.log();
  console.log(chalk.bold(`Total: ${formatSize(totalSize)} will be freed (${totalPaths} items)`));
  console.log();

  if (options.dryRun) {
    console.log(chalk.cyan('[DRY RUN] Would uninstall the above applications.\n'));
    return;
  }

  if (!options.yes) {
    const proceed = await confirm({
      message: 'Proceed with uninstallation?',
      default: false,
    });

    if (!proceed) {
      console.log(chalk.yellow('\nUninstallation cancelled.\n'));
      return;
    }
  }

  const showProgress = !options.noProgress && process.stdout.isTTY;
  const progress = showProgress ? createCleanProgress(appsToRemove.length) : null;

  let uninstalledCount = 0;
  let freedSpace = 0;
  const errors: string[] = [];

  for (let i = 0; i < appsToRemove.length; i++) {
    const app = appsToRemove[i];
    progress?.update(i, `Uninstalling ${sanitizeDisplayName(app.name)}...`);

    try {
      // Use safe remove with security checks
      const removeError = await safeRemove(app.path);
      if (removeError) {
        errors.push(`${sanitizeDisplayName(app.name)}: Failed to remove app bundle (${removeError})`);
        continue;
      }
      freedSpace += app.size;

      for (const relatedPath of app.relatedPaths) {
        const relatedSize = await getSize(relatedPath);
        // Use safe remove for related paths too
        const relatedError = await safeRemove(relatedPath);
        if (relatedError) {
          // Leftover files are not fatal, but the user needs to know they remain
          errors.push(`${app.name}: Failed to remove ${relatedPath.replace(homedir(), '~')} (${relatedError})`);
          continue;
        }
        freedSpace += relatedSize;
      }

      uninstalledCount++;
    } catch (error) {
      // Sanitize error message to avoid leaking path information
      errors.push(`${sanitizeDisplayName(app.name)}: ${sanitizeDisplayName(formatError(error).replaceAll(homedir(), '~'))}`);
    }
  }

  progress?.finish();

  console.log();
  console.log(chalk.bold.green('✓ Uninstallation Complete'));
  console.log(chalk.dim('─'.repeat(50)));
  console.log(`  Apps uninstalled: ${uninstalledCount}`);
  console.log(`  Space freed: ${chalk.green(formatSize(freedSpace))}`);

  if (errors.length > 0) {
    console.log();
    console.log(chalk.red('Errors:'));
    for (const error of errors) {
      console.log(chalk.red(`  ✗ ${error}`));
    }
    process.exitCode = 1;
  }

  console.log();
}

/** Lists app bundles and matching per-user support files for the desktop UI and CLI. */
export async function scanInstalledApps(): Promise<InstalledAppInfo[]> {
  const apps: InstalledAppInfo[] = [];

  for (const appDir of [APPLICATIONS_DIR, USER_APPLICATIONS_DIR]) {
    if (!(await exists(appDir))) continue;

    try {
      const entries = await readdir(appDir);

      for (const entry of entries) {
        if (!entry.endsWith('.app')) continue;

        const appPath = join(appDir, entry);
        const appName = basename(entry, '.app');

        try {
          const stats = await stat(appPath);
          if (!stats.isDirectory()) continue;

          const bundleId = await getBundleId(appPath);
          // Apple-bundled apps are part of macOS or iWork's managed app set;
          // do not present them as ordinary removable third-party installs.
          if (bundleId?.startsWith('com.apple.')) continue;

          const appSize = await getSize(appPath);
          const relatedPaths = await findRelatedPaths(appName, appPath);

          let totalRelatedSize = 0;
          for (const path of relatedPaths) {
            totalRelatedSize += await getSize(path);
          }

          apps.push({
            name: appName,
            path: appPath,
            size: appSize,
            relatedPaths,
            totalSize: appSize + totalRelatedSize,
          });
        } catch (error) {
          debugError(`getInstalledApps(${appPath})`, error);
          continue;
        }
      }
    } catch (error) {
      debugError(`getInstalledApps(${appDir})`, error);
      continue;
    }
  }

  return apps.sort((a, b) => b.totalSize - a.totalSize);
}

const BREW_PATHS = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'];

async function getBrewPath(): Promise<string | null> {
  for (const path of BREW_PATHS) {
    try {
      await access(path);
      return path;
    } catch {
      // Try the other standard Homebrew prefix.
    }
  }
  return null;
}

function runBrew(brewPath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(brewPath, args, { timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `brew exited with code ${code}`)));
  });
}

function parseBrewPackages(output: string): { name: string; version: string }[] {
  return output.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const [name, ...version] = line.split(/\s+/);
    return { name, version: version.join(' ') };
  }).filter((entry) => /^[A-Za-z0-9@+._/-]+$/.test(entry.name) && !entry.name.startsWith('-'));
}

function comparableAppName(value: string): string {
  return value.toLocaleLowerCase('en-US').replace(/[^a-z0-9]/g, '');
}

/** Combines regular app bundles with Homebrew casks and formulae. */
export async function scanUninstallTargets(excludePaths: string[] = []): Promise<InstalledTargetsResult> {
  const excluded = new Set(excludePaths.map((path) => resolve(path)));
  const bundles = (await scanInstalledApps()).filter((bundle) => !excluded.has(resolve(bundle.path)));
  const targets: InstalledTarget[] = bundles.map((app) => ({ ...app, id: `bundle:${app.path}`, source: 'app-bundle' }));
  const warnings: string[] = [];
  const brewPath = await getBrewPath();
  if (!brewPath) return { apps: targets, warnings };

  let casks: { name: string; version: string }[] = [];
  let formulae: { name: string; version: string }[] = [];
  try {
    casks = parseBrewPackages(await runBrew(brewPath, ['list', '--cask', '--versions']));
  } catch {
    warnings.push('Homebrew Casks: não foi possível consultar a lista de aplicativos.');
  }
  try {
    formulae = parseBrewPackages(await runBrew(brewPath, ['list', '--formula', '--versions']));
  } catch {
    warnings.push('Homebrew Fórmulas: não foi possível consultar a lista de pacotes.');
  }

  const bundleByName = new Map(bundles.map((bundle) => [comparableAppName(bundle.name), bundle]));
  const matchedBundlePaths = new Set<string>();
  for (const cask of casks) {
    const bundle = bundleByName.get(comparableAppName(cask.name));
    if (bundle) matchedBundlePaths.add(bundle.path);
    targets.push({
      id: `cask:${cask.name}`,
      source: 'homebrew-cask',
      name: bundle?.name ?? cask.name,
      path: bundle?.path,
      size: bundle?.size ?? 0,
      relatedPaths: bundle?.relatedPaths ?? [],
      totalSize: bundle?.totalSize ?? 0,
      version: cask.version,
    });
  }
  for (const formula of formulae) {
    targets.push({
      id: `formula:${formula.name}`,
      source: 'homebrew-formula',
      name: formula.name,
      size: 0,
      relatedPaths: [],
      totalSize: 0,
      version: formula.version,
    });
  }

  const unique = targets.filter((target) => target.source !== 'app-bundle' || !matchedBundlePaths.has(target.path ?? ''));
  return { apps: unique.sort((a, b) => b.totalSize - a.totalSize || a.name.localeCompare(b.name)), warnings };
}

/** Uninstalls a target only after it is found again in a fresh inventory scan. */
export async function uninstallTarget(
  targetId: string,
  onProgress?: (completed: number, total: number, current: string) => void,
  excludePaths: string[] = []
): Promise<UninstallResult> {
  const inventory = await scanUninstallTargets(excludePaths);
  const target = inventory.apps.find((candidate) => candidate.id === targetId);
  if (!target) throw new Error('Application was not found in the installed application list. Scan again before uninstalling.');
  if (target.source === 'app-bundle') {
    return uninstallApplication(target.path!, onProgress);
  }

  const brewPath = await getBrewPath();
  if (!brewPath) throw new Error('O Homebrew não está mais disponível. Atualize a lista de aplicativos.');
  const packageName = target.id.slice(target.source === 'homebrew-cask' ? 'cask:'.length : 'formula:'.length);
  if (!/^[A-Za-z0-9@+._/-]+$/.test(packageName) || packageName.startsWith('-')) {
    throw new Error('O identificador do pacote Homebrew é inválido. Atualize a lista de aplicativos.');
  }

  const total = 1 + (target.path ? 1 : 0) + target.relatedPaths.length;
  let completed = 0;
  onProgress?.(completed, total, target.name);
  const kindArg = target.source === 'homebrew-cask' ? '--cask' : '--formula';
  try {
    await runBrew(brewPath, ['uninstall', kindArg, packageName]);
  } catch (error) {
    debugError(`uninstallTarget(${target.id})`, error);
    throw new Error(`O Homebrew não conseguiu remover ${target.name}. Verifique se o pacote está em uso e tente novamente.`, { cause: error });
  }
  completed++;
  onProgress?.(completed, total, target.name);
  let freedSpace = 0;
  let removedItems = 1;
  const errors: string[] = [];
  if (target.path && await exists(target.path)) {
    const size = await getSize(target.path);
    const removeError = await safeRemove(target.path);
    if (removeError) errors.push(removalFailure('o aplicativo', removeError));
    else { freedSpace += size; removedItems++; }
    completed++;
    onProgress?.(completed, total, target.path);
  }
  for (const relatedPath of target.relatedPaths) {
    const size = await getSize(relatedPath);
    const removeError = await safeRemove(relatedPath);
    if (removeError) errors.push(removalFailure(relatedPath.replace(homedir(), '~'), removeError));
    else { freedSpace += size; removedItems++; }
    completed++;
    onProgress?.(completed, total, relatedPath);
  }
  onProgress?.(total, total, target.name);
  return { success: errors.length === 0, appName: target.name, freedSpace, removedItems, errors };
}

/**
 * Removes one freshly discovered app bundle and its related per-user files.
 * The renderer can only request an app path returned by scanInstalledApps;
 * the path is revalidated against a fresh scan immediately before deletion.
 */
export async function uninstallApplication(
  appPath: string,
  onProgress?: (completed: number, total: number, current: string) => void
): Promise<UninstallResult> {
  const apps = await scanInstalledApps();
  const app = apps.find((candidate) => candidate.path === appPath);
  if (!app) {
    throw new Error('Application was not found in the installed application list. Scan again before uninstalling.');
  }

  const errors: string[] = [];
  let freedSpace = 0;
  let removedItems = 0;
  const total = 1 + app.relatedPaths.length;
  let completed = 0;

  onProgress?.(completed, total, app.name);
  const appError = await safeRemove(app.path);
  completed++;
  onProgress?.(completed, total, app.name);
  if (appError) {
    errors.push(removalFailure('o aplicativo', appError));
    return { success: false, appName: app.name, freedSpace, removedItems, errors };
  }
  freedSpace += app.size;
  removedItems++;

  for (const relatedPath of app.relatedPaths) {
    onProgress?.(completed, total, relatedPath);
    const size = await getSize(relatedPath);
    const removeError = await safeRemove(relatedPath);
    completed++;
    onProgress?.(completed, total, relatedPath);
    if (removeError) {
      errors.push(removalFailure(relatedPath.replace(homedir(), '~'), removeError));
      continue;
    }
    freedSpace += size;
    removedItems++;
  }

  return { success: errors.length === 0, appName: app.name, freedSpace, removedItems, errors };
}

async function findRelatedPaths(appName: string, appPath?: string): Promise<string[]> {
  const paths: string[] = [];
  const home = homedir();
  
  // Try to get the real bundle ID from the app's Info.plist
  let bundleId: string | null = null;
  if (appPath) {
    bundleId = await getBundleId(appPath);
  }
  
  // Fall back to guessing if we couldn't read the bundle ID
  if (!bundleId) {
    bundleId = appName.toLowerCase().replace(/\s+/g, '.');
  }

  for (const template of RELATED_PATHS_TEMPLATES) {
    const variations = [
      template.replace('{APP_NAME}', appName).replace('{BUNDLE_ID}', bundleId),
      template.replace('{APP_NAME}', appName.toLowerCase()).replace('{BUNDLE_ID}', bundleId),
      template.replace('{APP_NAME}', appName.replace(/\s+/g, '')).replace('{BUNDLE_ID}', bundleId),
    ];

    for (const path of variations) {
      // Security check: ensure the path is within the home directory
      const resolved = resolve(path);
      if (!resolved.startsWith(home + '/')) {
        continue;
      }
      
      // Check for protected paths
      if (isProtectedPath(resolved)) {
        continue;
      }

      if (path.includes('*')) {
        const dir = path.substring(0, path.lastIndexOf('/'));
        const pattern = path.substring(path.lastIndexOf('/') + 1);

        if (await exists(dir)) {
          try {
            const entries = await readdir(dir);
            for (const entry of entries) {
              if (matchPattern(entry, pattern)) {
                const fullPath = join(dir, entry);
                // Additional security check for matched paths
                if (!isProtectedPath(fullPath) && !paths.includes(fullPath)) {
                  paths.push(fullPath);
                }
              }
            }
          } catch (error) {
            debugError(`findRelatedPaths(${dir})`, error);
            continue;
          }
        }
      } else if (await exists(path)) {
        if (!paths.includes(path)) {
          paths.push(path);
        }
      }
    }
  }

  // On a case-insensitive volume, name variants can point to the same file.
  // Keep symlinks distinct from their targets; removal must only unlink the link.
  const uniquePaths: string[] = [];
  const identities = new Set<string>();
  for (const path of paths) {
    let identity = path;
    try {
      const stats = await lstat(path);
      identity = stats.isSymbolicLink()
        ? `link:${stats.dev}:${stats.ino}`
        : await physicalFs.realpath(path);
    } catch {
      // Keep inaccessible/disappearing paths so removal can report their outcome.
    }
    if (!identities.has(identity)) {
      identities.add(identity);
      uniquePaths.push(path);
    }
  }
  return uniquePaths;
}

/**
 * Matches a string against a glob-like pattern.
 * Security: Uses proper regex escaping to prevent regex injection.
 */
function matchPattern(str: string, pattern: string): boolean {
  // Escape all regex metacharacters first, then convert * to .*
  const escaped = escapeRegex(pattern);
  const regexPattern = escaped.replace(/\\\*/g, '.*');
  
  try {
    return new RegExp(`^${regexPattern}$`, 'i').test(str);
  } catch {
    // If regex construction fails, return false for safety
    return false;
  }
}


