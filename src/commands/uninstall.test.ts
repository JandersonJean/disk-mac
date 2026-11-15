import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { homedir, tmpdir } from 'os';

// Mock all external dependencies before importing
vi.mock('../utils/index.js', async () => {
  return {
    exists: vi.fn().mockResolvedValue(false),
    getSize: vi.fn().mockResolvedValue(0),
    formatSize: vi.fn((size: number) => `${size} bytes`),
    createCleanProgress: vi.fn(() => ({
      update: vi.fn(),
      finish: vi.fn(),
    })),
    isProtectedPath: vi.fn().mockReturnValue(false),
    validatePathSafety: vi.fn().mockReturnValue(null),
    sanitizeDisplayName: vi.fn((text: string) => text),
  };
});

vi.mock('@inquirer/confirm', () => ({
  default: vi.fn().mockResolvedValue(false),
}));

vi.mock('@inquirer/checkbox', () => ({
  default: vi.fn().mockResolvedValue([]),
}));

vi.mock('child_process', () => ({ spawn: vi.fn() }));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    readdir: vi.fn().mockResolvedValue([]),
    stat: vi.fn().mockResolvedValue({
      isDirectory: () => true,
      mtime: new Date(),
    }),
    rm: vi.fn().mockResolvedValue(undefined),
    lstat: vi.fn().mockResolvedValue({
      isSymbolicLink: () => false,
      isDirectory: () => true,
      mtime: new Date(),
    }),
    unlink: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue(''),
    access: vi.fn().mockRejectedValue(new Error('Not found')),
    realpath: vi.fn(async (path: string) => path),
  };
});

import { scanUninstallTargets, uninstallCommand, uninstallApplication, uninstallTarget } from './uninstall.js';
import * as utils from '../utils/index.js';
import * as inquirerConfirm from '@inquirer/confirm';
import * as inquirerCheckbox from '@inquirer/checkbox';
import * as fsPromises from 'fs/promises';

const inquirerPrompts = {
  confirm: inquirerConfirm.default,
  checkbox: inquirerCheckbox.default,
};

describe('uninstall command', () => {
  const testDir = join(tmpdir(), 'mac-cleaner-uninstall-test');

  beforeEach(async () => {
    vi.clearAllMocks();
    await mkdir(testDir, { recursive: true }).catch(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  it('should display message when no apps found', async () => {
    vi.mocked(utils.exists).mockResolvedValue(false);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await uninstallCommand({});

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('No applications found'));

    consoleSpy.mockRestore();
  });

  it('should display apps when found', async () => {
    vi.mocked(utils.exists).mockResolvedValue(true);
    vi.mocked(utils.getSize).mockResolvedValue(1000000);
    vi.mocked(fsPromises.readdir).mockResolvedValue(['TestApp.app'] as unknown as Awaited<ReturnType<typeof fsPromises.readdir>>);
    vi.mocked(fsPromises.stat).mockResolvedValue({
      isDirectory: () => true,
      mtime: new Date(),
    } as Awaited<ReturnType<typeof fsPromises.stat>>);
    vi.mocked(inquirerPrompts.checkbox).mockResolvedValue([]);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await uninstallCommand({});

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('No applications selected'));

    consoleSpy.mockRestore();
  });

  it('should handle dry run', async () => {
    vi.mocked(utils.exists).mockResolvedValue(true);
    vi.mocked(utils.getSize).mockResolvedValue(1000000);
    vi.mocked(fsPromises.readdir).mockResolvedValue(['TestApp.app'] as unknown as Awaited<ReturnType<typeof fsPromises.readdir>>);
    vi.mocked(fsPromises.stat).mockResolvedValue({
      isDirectory: () => true,
      mtime: new Date(),
    } as Awaited<ReturnType<typeof fsPromises.stat>>);
    vi.mocked(inquirerPrompts.checkbox).mockResolvedValue(['TestApp']);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await uninstallCommand({ dryRun: true });

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('DRY RUN'));
    expect(fsPromises.rm).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it('should cancel when user declines', async () => {
    vi.mocked(utils.exists).mockResolvedValue(true);
    vi.mocked(utils.getSize).mockResolvedValue(1000000);
    vi.mocked(fsPromises.readdir).mockResolvedValue(['TestApp.app'] as unknown as Awaited<ReturnType<typeof fsPromises.readdir>>);
    vi.mocked(fsPromises.stat).mockResolvedValue({
      isDirectory: () => true,
      mtime: new Date(),
    } as Awaited<ReturnType<typeof fsPromises.stat>>);
    vi.mocked(inquirerPrompts.checkbox).mockResolvedValue(['TestApp']);
    vi.mocked(inquirerPrompts.confirm).mockResolvedValue(false);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await uninstallCommand({});

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('cancelled'));

    consoleSpy.mockRestore();
  });

  it('should uninstall when confirmed', async () => {
    vi.mocked(utils.exists).mockResolvedValue(true);
    vi.mocked(utils.getSize).mockResolvedValue(1000000);
    vi.mocked(fsPromises.readdir).mockResolvedValue(['TestApp.app'] as unknown as Awaited<ReturnType<typeof fsPromises.readdir>>);
    vi.mocked(fsPromises.stat).mockResolvedValue({
      isDirectory: () => true,
      mtime: new Date(),
    } as Awaited<ReturnType<typeof fsPromises.stat>>);
    vi.mocked(inquirerPrompts.checkbox).mockResolvedValue(['TestApp']);
    vi.mocked(inquirerPrompts.confirm).mockResolvedValue(true);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await uninstallCommand({});

    expect(fsPromises.rm).toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Uninstallation Complete'));

    consoleSpy.mockRestore();
  });

  it('should uninstall with --yes flag', async () => {
    vi.mocked(utils.exists).mockResolvedValue(true);
    vi.mocked(utils.getSize).mockResolvedValue(1000000);
    vi.mocked(fsPromises.readdir).mockResolvedValue(['TestApp.app'] as unknown as Awaited<ReturnType<typeof fsPromises.readdir>>);
    vi.mocked(fsPromises.stat).mockResolvedValue({
      isDirectory: () => true,
      mtime: new Date(),
    } as Awaited<ReturnType<typeof fsPromises.stat>>);
    vi.mocked(inquirerPrompts.checkbox).mockResolvedValue(['TestApp']);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await uninstallCommand({ yes: true });

    expect(fsPromises.rm).toHaveBeenCalled();
    expect(inquirerPrompts.confirm).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it('should handle errors during uninstall', async () => {
    vi.mocked(utils.exists).mockResolvedValue(true);
    vi.mocked(utils.getSize).mockResolvedValue(1000000);
    vi.mocked(fsPromises.readdir).mockResolvedValue(['TestApp.app'] as unknown as Awaited<ReturnType<typeof fsPromises.readdir>>);
    vi.mocked(fsPromises.stat).mockResolvedValue({
      isDirectory: () => true,
      mtime: new Date(),
    } as Awaited<ReturnType<typeof fsPromises.stat>>);
    vi.mocked(inquirerPrompts.checkbox).mockResolvedValue(['TestApp']);
    vi.mocked(fsPromises.rm).mockRejectedValue(new Error('Permission denied'));

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await uninstallCommand({ yes: true });

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Errors'));

    consoleSpy.mockRestore();
  });

  it('should handle noProgress option', async () => {
    vi.mocked(utils.exists).mockResolvedValue(true);
    vi.mocked(utils.getSize).mockResolvedValue(1000000);
    vi.mocked(fsPromises.readdir).mockResolvedValue(['TestApp.app'] as unknown as Awaited<ReturnType<typeof fsPromises.readdir>>);
    vi.mocked(fsPromises.stat).mockResolvedValue({
      isDirectory: () => true,
      mtime: new Date(),
    } as Awaited<ReturnType<typeof fsPromises.stat>>);
    vi.mocked(inquirerPrompts.checkbox).mockResolvedValue(['TestApp']);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await uninstallCommand({ yes: true, noProgress: true });

    expect(utils.createCleanProgress).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it('should find apps in both Application directories', async () => {
    vi.mocked(utils.exists).mockResolvedValue(true);
    vi.mocked(utils.getSize).mockResolvedValue(500000);
    vi.mocked(fsPromises.readdir).mockResolvedValue(['App1.app', 'App2.app'] as unknown as Awaited<ReturnType<typeof fsPromises.readdir>>);
    vi.mocked(fsPromises.stat).mockResolvedValue({
      isDirectory: () => true,
      mtime: new Date(),
    } as Awaited<ReturnType<typeof fsPromises.stat>>);
    vi.mocked(inquirerPrompts.checkbox).mockResolvedValue([]);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await uninstallCommand({});

    // Should check both /Applications and ~/Applications
    expect(utils.exists).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it('should skip non-.app entries', async () => {
    vi.mocked(utils.exists).mockResolvedValue(true);
    vi.mocked(utils.getSize).mockResolvedValue(500000);
    vi.mocked(fsPromises.readdir).mockResolvedValue(['NotAnApp.txt', 'ActualApp.app'] as unknown as Awaited<ReturnType<typeof fsPromises.readdir>>);
    vi.mocked(fsPromises.stat).mockResolvedValue({
      isDirectory: () => true,
      mtime: new Date(),
    } as Awaited<ReturnType<typeof fsPromises.stat>>);
    vi.mocked(inquirerPrompts.checkbox).mockResolvedValue([]);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await uninstallCommand({});

    consoleSpy.mockRestore();
  });
});

describe('desktop uninstallation results', () => {
  const appPath = '/Applications/Fixture.app';
  const supportPath = join(homedir(), 'Library', 'Application Support', 'Fixture');

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(utils.exists).mockImplementation(async (path) => path === '/Applications' || path === supportPath);
    vi.mocked(utils.getSize).mockImplementation(async (path) => path === appPath ? 200 : 50);
    vi.mocked(utils.isProtectedPath).mockReturnValue(false);
    vi.mocked(utils.validatePathSafety).mockReturnValue(null);
    vi.mocked(fsPromises.readdir).mockResolvedValue(['Fixture.app'] as unknown as Awaited<ReturnType<typeof fsPromises.readdir>>);
    vi.mocked(fsPromises.stat).mockResolvedValue({ isDirectory: () => true } as Awaited<ReturnType<typeof fsPromises.stat>>);
    vi.mocked(fsPromises.lstat).mockResolvedValue({ isSymbolicLink: () => false } as Awaited<ReturnType<typeof fsPromises.lstat>>);
    vi.mocked(fsPromises.readFile).mockResolvedValue(Buffer.from('<key>CFBundleIdentifier</key><string>local.diskmac.fixture</string>'));
    vi.mocked(fsPromises.rm).mockResolvedValue(undefined);
  });

  it('keeps related data when the app bundle cannot be removed', async () => {
    vi.mocked(fsPromises.rm).mockRejectedValue(Object.assign(new Error('not empty'), { code: 'ENOTEMPTY' }));
    const result = await uninstallApplication(appPath);
    expect(result).toMatchObject({ success: false, removedItems: 0, freedSpace: 0 });
    expect(result.errors[0]).toContain('Não foi possível remover o aplicativo (ENOTEMPTY)');
    expect(fsPromises.rm).toHaveBeenCalledTimes(1);
    expect(fsPromises.rm).toHaveBeenCalledWith(appPath, expect.objectContaining({ recursive: true, maxRetries: 3 }));
  });

  it('reports partial removal without counting support files that remain', async () => {
    vi.mocked(fsPromises.rm).mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }));
    const result = await uninstallApplication(appPath);
    expect(result).toMatchObject({ success: false, removedItems: 1, freedSpace: 200 });
    expect(result.errors[0]).toContain('EACCES');
    expect(result.errors[0]).toContain('Verifique as permissões');
  });

  it('tolerates a related file disappearing between the inventory and removal', async () => {
    let supportReads = 0;
    vi.mocked(fsPromises.lstat).mockImplementation(async (path) => {
      if (path === supportPath && ++supportReads === 2) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      return { isSymbolicLink: () => false } as Awaited<ReturnType<typeof fsPromises.lstat>>;
    });
    expect(await uninstallApplication(appPath)).toMatchObject({ success: true, errors: [] });
    expect(fsPromises.rm).toHaveBeenCalledTimes(1);
  });

  it('still refuses a path rejected by the safety check', async () => {
    vi.mocked(utils.validatePathSafety).mockReturnValue('Protected fixture path');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await uninstallApplication(appPath)).toMatchObject({ success: false, removedItems: 0 });
    expect(fsPromises.rm).not.toHaveBeenCalled();
    log.mockRestore();
  });
});

describe('uninstall inventory and Homebrew targets', () => {
  const brewPath = '/opt/homebrew/bin/brew';
  const appPath = '/Applications/Fixture App.app';
  const protectedApp = '/Applications/Managed.app';
  const supportPath = join(homedir(), 'Library', 'Application Support', 'Fixture App');
  const supportAlias = join(homedir(), 'Library', 'Application Support', 'fixture app');
  const groupDir = join(homedir(), 'Library', 'Group Containers');
  const groupLink = join(groupDir, 'group.Fixture App');

  function childResult(output: string, error: string, code: number): ReturnType<typeof spawn> {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
    queueMicrotask(() => {
      child.stdout.end(output);
      child.stderr.end(error);
      child.emit('close', code);
    });
    return child as unknown as ReturnType<typeof spawn>;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(utils.exists).mockImplementation(async (path) => ['/Applications', appPath, supportPath, supportAlias, groupDir].includes(path));
    vi.mocked(utils.getSize).mockImplementation(async (path) => path === appPath ? 200 : 50);
    vi.mocked(utils.isProtectedPath).mockReturnValue(false);
    vi.mocked(utils.validatePathSafety).mockReturnValue(null);
    vi.mocked(fsPromises.access).mockImplementation(async (path) => {
      if (path !== brewPath) throw new Error('Brew not found');
    });
    vi.mocked(fsPromises.readdir).mockImplementation(async (path) => {
      const names = path === groupDir ? ['group.Fixture App', 'group.Other App'] : ['Fixture App.app', 'Managed.app'];
      return names as unknown as Awaited<ReturnType<typeof fsPromises.readdir>>;
    });
    vi.mocked(fsPromises.stat).mockResolvedValue({ isDirectory: () => true } as Awaited<ReturnType<typeof fsPromises.stat>>);
    vi.mocked(fsPromises.lstat).mockImplementation(async (path) => ({
      isSymbolicLink: () => path === groupLink, dev: 1, ino: 4,
    }) as Awaited<ReturnType<typeof fsPromises.lstat>>);
    vi.mocked(fsPromises.realpath).mockImplementation(async (path) => String(path === supportAlias ? supportPath : path));
    vi.mocked(fsPromises.readFile).mockImplementation(async (path) => {
      const bundleId = String(path).startsWith(protectedApp) ? 'com.apple.managed' : 'local.diskmac.fixture';
      return Buffer.from(`<key>CFBundleIdentifier</key><string>${bundleId}</string>`);
    });
    vi.mocked(fsPromises.rm).mockResolvedValue(undefined);
    vi.mocked(spawn).mockImplementation((_command, args) => {
      if (Array.isArray(args) && args[0] === 'list') {
        const packages = args[1] === '--cask' ? 'fixture-app 2.1\nstandalone-cask 1.2\n' : 'ripgrep 14.1.0\n--malicious 1\n';
        return childResult(packages, '', 0);
      }
      if (Array.isArray(args) && args[0] === 'uninstall') return childResult('', '', 0);
      throw new Error('Unexpected child process call');
    });
  });

  it('combines a matching cask and bundle, lists formulas, and filters out protected apps and invalid names', async () => {
    const result = await scanUninstallTargets();

    expect(result.warnings).toEqual([]);
    expect(result.apps.map(({ id }) => id)).toEqual(['cask:fixture-app', 'formula:ripgrep', 'cask:standalone-cask']);
    expect(result.apps[0]).toMatchObject({
      source: 'homebrew-cask', name: 'Fixture App', path: appPath, version: '2.1',
      relatedPaths: [supportPath, groupLink], totalSize: 300,
    });
    expect(result.apps[1]).toMatchObject({ source: 'homebrew-formula', name: 'ripgrep', version: '14.1.0' });
  });

  it('lists regular bundles when Homebrew is absent and omits an excluded path', async () => {
    vi.mocked(fsPromises.access).mockRejectedValue(new Error('Brew not found'));
    expect((await scanUninstallTargets()).apps.map(({ id }) => id)).toEqual([`bundle:${appPath}`]);
    expect(await scanUninstallTargets(['/Applications/./Fixture App.app'])).toEqual({ apps: [], warnings: [] });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('converts a binary plist and uses its bundle ID to locate preferences', async () => {
    const preference = join(homedir(), 'Library', 'Preferences', 'local.diskmac.binary.plist');
    vi.mocked(fsPromises.access).mockRejectedValue(new Error('Brew not found'));
    vi.mocked(utils.exists).mockImplementation(async (path) => ['/Applications', preference].includes(path));
    vi.mocked(fsPromises.readdir).mockResolvedValue(['Fixture App.app'] as unknown as Awaited<ReturnType<typeof fsPromises.readdir>>);
    vi.mocked(fsPromises.readFile).mockResolvedValue(Buffer.from('bplist00'));
    vi.mocked(spawn).mockImplementation(() => childResult('<key>CFBundleIdentifier</key><string>local.diskmac.binary</string>', '', 0));

    const result = await scanUninstallTargets();

    expect(result.apps[0].relatedPaths).toEqual([preference]);
    expect(spawn).toHaveBeenCalledWith('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', join(appPath, 'Contents', 'Info.plist')], expect.anything());
  });

  it('reports a failed cask listing and still returns formulas and regular bundles', async () => {
    vi.mocked(spawn).mockImplementationOnce(() => childResult('', 'cask query failed', 1));
    const result = await scanUninstallTargets();

    expect(result.warnings).toEqual([expect.stringContaining('Homebrew Casks')]);
    expect(result.apps.map(({ id }) => id)).toEqual([`bundle:${appPath}`, 'formula:ripgrep']);
  });

  it('reports a failed formula listing while retaining installed casks', async () => {
    const brew = vi.mocked(spawn).getMockImplementation()!;
    vi.mocked(spawn).mockImplementation((command, args, options) => {
      if (Array.isArray(args) && args[1] === '--formula') return childResult('', '', 1);
      return brew(command, args, options);
    });
    const result = await scanUninstallTargets();

    expect(result.warnings).toEqual([expect.stringContaining('Homebrew Fórmulas')]);
    expect(result.apps.map(({ id }) => id)).toEqual(['cask:fixture-app', 'cask:standalone-cask']);
  });

  it('rejects a stale package ID before running any removal', async () => {
    await expect(uninstallTarget('formula:missing')).rejects.toThrow('Scan again');
    expect(spawn).not.toHaveBeenCalledWith(brewPath, ['uninstall', '--formula', 'missing'], expect.anything());
    expect(fsPromises.rm).not.toHaveBeenCalled();
  });

  it('uses Homebrew to remove a formula without deleting filesystem paths', async () => {
    const result = await uninstallTarget('formula:ripgrep');

    expect(result).toEqual({ success: true, appName: 'ripgrep', removedItems: 1, freedSpace: 0, errors: [] });
    expect(spawn).toHaveBeenCalledWith(brewPath, ['uninstall', '--formula', 'ripgrep'], expect.anything());
    expect(fsPromises.rm).not.toHaveBeenCalled();
    expect(fsPromises.unlink).not.toHaveBeenCalled();
  });

  it('removes cask leftovers and unlinks group containers without following symlinks', async () => {
    const onProgress = vi.fn();
    const result = await uninstallTarget('cask:fixture-app', onProgress);

    expect(result).toEqual({ success: true, appName: 'Fixture App', removedItems: 4, freedSpace: 300, errors: [] });
    expect(spawn).toHaveBeenCalledWith(brewPath, ['uninstall', '--cask', 'fixture-app'], expect.anything());
    expect(vi.mocked(fsPromises.rm).mock.calls.map(([path]) => path)).toEqual([appPath, supportPath]);
    expect(fsPromises.unlink).toHaveBeenCalledExactlyOnceWith(groupLink);
    expect(onProgress).toHaveBeenCalledWith(0, 4, 'Fixture App');
    expect(onProgress).toHaveBeenLastCalledWith(4, 4, 'Fixture App');
  });

  it('reports remaining support files without counting their space when cask cleanup fails', async () => {
    vi.mocked(fsPromises.rm).mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(Object.assign(new Error('Permission denied'), { code: 'EACCES' }));

    const result = await uninstallTarget('cask:fixture-app');

    expect(result).toMatchObject({
      success: false, removedItems: 3, freedSpace: 250,
      errors: [expect.stringContaining('~/Library/Application Support/Fixture App (EACCES)')],
    });
  });

  it('keeps the bundle and support data if Homebrew refuses to remove the cask', async () => {
    const brew = vi.mocked(spawn).getMockImplementation()!;
    vi.mocked(spawn).mockImplementation((command, args, options) => {
      if (Array.isArray(args) && args[0] === 'uninstall') return childResult('', 'in use', 1);
      return brew(command, args, options);
    });

    await expect(uninstallTarget('cask:fixture-app')).rejects.toThrow('O Homebrew não conseguiu remover Fixture App');
    expect(fsPromises.rm).not.toHaveBeenCalled();
    expect(fsPromises.unlink).not.toHaveBeenCalled();
  });

  it('detects Homebrew disappearing after inventory and before uninstall', async () => {
    vi.mocked(fsPromises.access).mockReset().mockResolvedValueOnce(undefined).mockRejectedValue(new Error('Brew vanished'));

    await expect(uninstallTarget('cask:fixture-app')).rejects.toThrow('O Homebrew não está mais disponível');
    expect(fsPromises.rm).not.toHaveBeenCalled();
  });
});
