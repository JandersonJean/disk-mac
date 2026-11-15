import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cp, link, mkdir, mkdtemp, readFile, readlink, rename, rm, symlink, utimes, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import * as backup from './backup.js';

const { fixtureHome } = await vi.hoisted(async () => {
  const { mkdtempSync, realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return { fixtureHome: mkdtempSync(join(realpathSync(tmpdir()), 'disk-mac-backup-home-')) };
});

vi.mock('os', async (importOriginal) => ({
  ...await importOriginal<typeof import('os')>(),
  homedir: () => fixtureHome,
}));

vi.mock('fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('fs/promises')>();
  return { ...fs, rename: vi.fn(fs.rename), cp: vi.fn(fs.cp), link: vi.fn(fs.link) };
});

beforeEach(async () => {
  await mkdir(fixtureHome, { recursive: true });
});

afterEach(async () => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
  await rm(fixtureHome, { recursive: true, force: true });
});

describe('backup utilities', () => {
  describe('ensureBackupDir', () => {
    it('should create backup directory', async () => {
      const dir = await backup.ensureBackupDir();
      expect(dir).toBeDefined();
      expect(dir).toContain('mac-cleaner');
      await rm(dir, { recursive: true, force: true });
    });
  });

  describe('getBackupDir', () => {
    it('should return backup directory path', () => {
      const dir = backup.getBackupDir();
      expect(dir).toContain('.mac-cleaner-cli');
      expect(dir).toContain('backup');
    });
  });

  describe('listBackups', () => {
    it('lists sessions newest first and counts files in subdirectories', async () => {
      const older = await backup.ensureBackupDir();
      const newer = await backup.ensureBackupDir();
      const nested = join(older, 'HOME', 'Documents');
      await mkdir(nested, { recursive: true });
      await writeFile(join(nested, 'notes.txt'), 'notes');
      await symlink('notes.txt', join(nested, 'alias'));
      await writeFile(join(newer, 'report.txt'), 'report');
      await writeFile(join(backup.getBackupDir(), 'not-a-session'), 'ignore');
      const oldDate = new Date('2025-01-01T00:00:00Z');
      const newDate = new Date('2025-01-02T00:00:00Z');
      await utimes(older, oldDate, oldDate);
      await utimes(newer, newDate, newDate);

      expect(await backup.listBackups()).toEqual([
        { path: newer, date: newDate, size: 6 },
        { path: older, date: oldDate, size: 5 },
      ]);
    });

    it('returns an empty list before the first backup', async () => {
      expect(await backup.listBackups()).toEqual([]);
    });
  });

  describe('cleanOldBackups', () => {
    it('cleans expired sessions and preserves recent sessions and stray files', async () => {
      const expired = await backup.ensureBackupDir();
      const recent = await backup.ensureBackupDir();
      const stray = join(backup.getBackupDir(), 'stray.txt');
      await writeFile(stray, 'keep');
      const oldDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      await utimes(expired, oldDate, oldDate);
      await utimes(stray, oldDate, oldDate);

      expect(await backup.cleanOldBackups(2)).toBe(1);
      expect(existsSync(expired)).toBe(false);
      expect(existsSync(recent)).toBe(true);
      expect(await readFile(stray, 'utf-8')).toBe('keep');
    });

    it('has nothing to clean before the first backup', async () => {
      expect(await backup.cleanOldBackups()).toBe(0);
    });
  });

  describe('backupItem / backupItems (round-trip real)', () => {
    // These move REAL files and check the content afterwards. The previous
    // version only asserted `expect(typeof result).toBe('boolean')`, which
    // passed even with the backup failing 100% of the time — which was exactly
    // the state of this module: no callers, never exercised.
    let sourceDir: string;

    beforeEach(async () => {
      // Must be INSIDE home: backupItem refuses anything else, because
      // restoreBackup only knows how to restore what sits under the HOME/ prefix.
      sourceDir = join(homedir(), '.mac-cleaner-cli-test-src');
      await mkdir(sourceDir, { recursive: true });
    });

    afterEach(async () => {
      await rm(sourceDir, { recursive: true, force: true });
    });

    it('should MOVE the file into the backup, not copy it', async () => {
      const testFile = join(sourceDir, 'moved.txt');
      await writeFile(testFile, 'conteudo original');

      const dir = await backup.ensureBackupDir();
      const ok = await backup.backupItem(
        { path: testFile, size: 17, name: 'moved.txt', isDirectory: false },
        dir
      );

      expect(ok).toBe(true);
      expect(existsSync(testFile)).toBe(false);

      const backedUpPath = backup.backupPathFor(testFile, dir);
      expect(backedUpPath).not.toBeNull();
      expect(await readFile(backedUpPath as string, 'utf-8')).toBe('conteudo original');

      await rm(dir, { recursive: true, force: true });
    });

    it('should refuse paths outside the home directory', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const outsideDir = await mkdtemp(join(tmpdir(), 'outside-home-'));
      const outside = join(outsideDir, 'outside-home.txt');
      await writeFile(outside, 'x');

      const dir = await backup.ensureBackupDir();
      const ok = await backup.backupItem(
        { path: outside, size: 1, name: 'outside-home.txt', isDirectory: false },
        dir
      );

      // Refuses, rather than creating a backup restoreBackup could not undo.
      expect(ok).toBe(false);
      expect(existsSync(outside)).toBe(true);

      await rm(outsideDir, { recursive: true, force: true });
      await rm(dir, { recursive: true, force: true });
      consoleSpy.mockRestore();
    });

    it('should refuse protected system paths', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const dir = await backup.ensureBackupDir();

      const ok = await backup.backupItem(
        { path: '/var/log/system.log', size: 1, name: 'system.log', isDirectory: false },
        dir
      );

      expect(ok).toBe(false);
      await rm(dir, { recursive: true, force: true });
      consoleSpy.mockRestore();
    });

    it('should not touch the disk in dry run but still report the item', async () => {
      const testFile = join(sourceDir, 'dry.txt');
      await writeFile(testFile, 'intacto');

      const dir = await backup.ensureBackupDir();
      const result = await backup.backupItems(
        [{ path: testFile, size: 7, name: 'dry.txt', isDirectory: false }],
        dir,
        true
      );

      expect(result.success).toBe(1);
      expect(result.backedUpSize).toBe(7);
      expect(await readFile(testFile, 'utf-8')).toBe('intacto');

      await rm(dir, { recursive: true, force: true });
    });

    it('should report backedUpSize separately from freed space', async () => {
      const testFile = join(sourceDir, 'sized.txt');
      await writeFile(testFile, 'abcdefghij');

      const dir = await backup.ensureBackupDir();
      const result = await backup.backupItems(
        [{ path: testFile, size: 10, name: 'sized.txt', isDirectory: false }],
        dir
      );

      expect(result.success).toBe(1);
      expect(result.backedUpSize).toBe(10);

      await rm(dir, { recursive: true, force: true });
    });

    it('should count failures without deleting the failed item', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const good = join(sourceDir, 'good.txt');
      await writeFile(good, 'ok');

      const dir = await backup.ensureBackupDir();
      const result = await backup.backupItems(
        [
          { path: good, size: 2, name: 'good.txt', isDirectory: false },
          { path: join(sourceDir, 'ghost.txt'), size: 0, name: 'ghost.txt', isDirectory: false },
        ],
        dir
      );

      expect(result.success).toBe(1);
      expect(result.failed).toBe(1);

      await rm(dir, { recursive: true, force: true });
      consoleSpy.mockRestore();
    });

    it('should call the progress callback', async () => {
      const testFile = join(sourceDir, 'progress.txt');
      await writeFile(testFile, 'p');
      const progressFn = vi.fn();

      const dir = await backup.ensureBackupDir();
      await backup.backupItems(
        [{ path: testFile, size: 1, name: 'progress.txt', isDirectory: false }],
        dir,
        false,
        progressFn
      );

      expect(progressFn).toHaveBeenCalled();
      await rm(dir, { recursive: true, force: true });
    });

    it('should survive a full backup -> restore round trip with identical content', async () => {
      const testFile = join(sourceDir, 'roundtrip.txt');
      const content = 'este conteudo precisa voltar identico';
      await writeFile(testFile, content);

      const dir = await backup.ensureBackupDir();
      expect(
        await backup.backupItem(
          { path: testFile, size: content.length, name: 'roundtrip.txt', isDirectory: false },
          dir
        )
      ).toBe(true);
      expect(existsSync(testFile)).toBe(false);

      const restored = await backup.restoreBackup(dir);

      expect(restored.failed).toBe(0);
      expect(restored.success).toBe(1);
      expect(await readFile(testFile, 'utf-8')).toBe(content);

      await rm(dir, { recursive: true, force: true });
    });
  });

  describe('restoreBackup', () => {
    it('should handle empty backup directory', async () => {
      // Create a backup directory within the valid backup location
      const backupDir = backup.getBackupDir();
      const emptyDir = join(backupDir, 'empty-restore-test-' + Date.now());
      await mkdir(emptyDir, { recursive: true });

      const result = await backup.restoreBackup(emptyDir);

      expect(result.success).toBe(0);
      expect(result.failed).toBe(0);
      
      await rm(emptyDir, { recursive: true, force: true });
    });

    it('should reject restore from invalid backup directory', async () => {
      // Try to restore from a directory outside the backup location
      const invalidDir = await mkdtemp(join(tmpdir(), 'invalid-backup-'));
      await writeFile(join(invalidDir, 'file.txt'), 'malicious content');

      const result = await backup.restoreBackup(invalidDir);

      expect(result.success).toBe(0);
      expect(result.failed).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('Invalid backup directory');

      await rm(invalidDir, { recursive: true, force: true });
    });

    it('restores unaffected files and preserves both versions on conflict', async () => {
      const dir = await backup.ensureBackupDir();
      const documents = join(fixtureHome, 'Documents');
      const saved = join(dir, 'HOME', 'Documents');
      await mkdir(documents);
      await mkdir(saved, { recursive: true });
      await writeFile(join(documents, 'report.txt'), 'current');
      await writeFile(join(saved, 'report.txt'), 'original');
      await writeFile(join(saved, 'notes.txt'), 'notes');

      const result = await backup.restoreBackup(dir);

      expect(result).toMatchObject({ success: 1, failed: 1, errors: [expect.stringContaining('Arquivo existente preservado')] });
      expect(await readFile(join(documents, 'report.txt'), 'utf-8')).toBe('current');
      expect(await readFile(join(saved, 'report.txt'), 'utf-8')).toBe('original');
      expect(await readFile(join(documents, 'notes.txt'), 'utf-8')).toBe('notes');
      expect(existsSync(join(saved, 'notes.txt'))).toBe(false);

      await rm(join(documents, 'report.txt'));
      expect(await backup.restoreBackup(dir)).toEqual({ success: 1, failed: 0, errors: [] });
      expect(await readFile(join(documents, 'report.txt'), 'utf-8')).toBe('original');
      expect(existsSync(dir)).toBe(false);
    });

    it('refuses to use a symlink as a backup session', async () => {
      const dir = await backup.ensureBackupDir();
      const data = join(dir, 'HOME');
      await mkdir(data);
      await writeFile(join(data, 'notes.txt'), 'still backed up');
      const alias = join(backup.getBackupDir(), 'redirected-session');
      await symlink(dir, alias);

      expect(await backup.restoreBackup(alias)).toMatchObject({ success: 0, failed: 1 });
      expect(existsSync(join(fixtureHome, 'notes.txt'))).toBe(false);
      expect(await readFile(join(data, 'notes.txt'), 'utf-8')).toBe('still backed up');
    });

    it('does not redirect restoration through a symlink to a directory outside the home', async () => {
      const outside = await mkdtemp(join(tmpdir(), 'disk-mac-restore-outside-'));
      try {
        const dir = await backup.ensureBackupDir();
        const saved = join(dir, 'HOME', 'redirect', 'subdir');
        await mkdir(saved, { recursive: true });
        await writeFile(join(saved, 'notes.txt'), 'retained');
        await symlink(outside, join(fixtureHome, 'redirect'));

        const result = await backup.restoreBackup(dir);

        expect(result).toMatchObject({ success: 0, failed: 1, errors: [expect.stringContaining('outside home')] });
        expect(existsSync(join(outside, 'subdir'))).toBe(false);
        expect(await readFile(join(saved, 'notes.txt'), 'utf-8')).toBe('retained');
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });

    it('restores symlinks as links and copies regular files when hard links cross volumes', async () => {
      const dir = await backup.ensureBackupDir();
      const saved = join(dir, 'HOME', 'Documents');
      await mkdir(saved, { recursive: true });
      await writeFile(join(saved, 'original.txt'), 'example');
      await symlink('original.txt', join(saved, 'alias'));
      vi.mocked(link).mockRejectedValueOnce(Object.assign(new Error('Cross-device link'), { code: 'EXDEV' }));

      expect(await backup.restoreBackup(dir)).toEqual({ success: 2, failed: 0, errors: [] });
      expect(await readlink(join(fixtureHome, 'Documents', 'alias'))).toBe('original.txt');
      expect(await readFile(join(fixtureHome, 'Documents', 'alias'), 'utf-8')).toBe('example');
      expect(existsSync(dir)).toBe(false);
    });

    it('leaves content outside the HOME structure in the backup', async () => {
      const dir = await backup.ensureBackupDir();
      const strayFile = join(dir, 'stray.txt');
      await writeFile(strayFile, 'unexpected');

      expect(await backup.restoreBackup(dir)).toMatchObject({
        success: 0, failed: 1, errors: [expect.stringContaining('outside HOME structure')],
      });
      expect(await readFile(strayFile, 'utf-8')).toBe('unexpected');
      expect(existsSync(join(fixtureHome, 'stray.txt'))).toBe(false);
    });
  });

  describe('backupItem across volumes', () => {
    it('keeps the source when the cross-volume backup copy fails', async () => {
      const dir = await backup.ensureBackupDir();
      const file = join(fixtureHome, 'original.txt');
      await writeFile(file, 'original');
      vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('Cross-device rename'), { code: 'EXDEV' }));
      vi.mocked(cp).mockRejectedValueOnce(Object.assign(new Error('No space left'), { code: 'ENOSPC' }));

      expect(await backup.backupItem({ path: file, name: 'original.txt', size: 8, isDirectory: false }, dir)).toBe(false);
      expect(await readFile(file, 'utf-8')).toBe('original');
      expect(existsSync(join(dir, 'HOME', 'original.txt'))).toBe(false);
    });

    it('completes a cross-volume backup by copying before removing the source', async () => {
      const dir = await backup.ensureBackupDir();
      const file = join(fixtureHome, 'original.txt');
      await writeFile(file, 'original');
      vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('Cross-device rename'), { code: 'EXDEV' }));

      expect(await backup.backupItem({ path: file, name: 'original.txt', size: 8, isDirectory: false }, dir)).toBe(true);
      expect(await readFile(join(dir, 'HOME', 'original.txt'), 'utf-8')).toBe('original');
      expect(existsSync(file)).toBe(false);
    });
  });
});

describe('ensureBackupDir uniqueness', () => {
  // Regression guard: the name was just the ISO timestamp (millisecond
  // resolution) and `mkdir` with `recursive: true` accepts an existing directory
  // silently. Two sessions in the same millisecond would share the folder and
  // one would overwrite the other. This surfaced as suite flakiness (vitest runs
  // files in parallel) before it could surface as a production bug.
  it('never hands out the same directory twice', async () => {
    const dirs = await Promise.all(
      Array.from({ length: 25 }, () => backup.ensureBackupDir())
    );

    expect(new Set(dirs).size).toBe(dirs.length);

    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  });
});
