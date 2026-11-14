import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, writeFile, readFile, rm, symlink, lstat, readlink } from 'node:fs/promises';
import { join } from 'node:path';

const fixture = vi.hoisted(() => ({ home: `/private/tmp/disk-mac-restore-${process.pid}-${Math.random().toString(36).slice(2)}` }));
vi.mock('os', async (original) => ({ ...await original<typeof import('os')>(), homedir: () => fixture.home }));
import { ensureBackupDir, getBackupDir, restoreBackup } from '../../../src/utils/backup.js';

beforeAll(async () => { await mkdir(fixture.home, { recursive: true }); });
afterAll(async () => { await rm(fixture.home, { recursive: true, force: true }); });
async function stored(name: string, content = 'backup content') {
  const backup = await ensureBackupDir();
  await mkdir(join(backup, 'HOME', 'Documents'), { recursive: true });
  const source = join(backup, 'HOME', 'Documents', name);
  await writeFile(source, content);
  return { backup, source, target: join(fixture.home, 'Documents', name) };
}
describe('non-overwriting backup restoration', () => {
  it('restores files to their original locations and removes the emptied session', async () => {
    const { backup, target } = await stored('restored.txt');
    expect(await restoreBackup(backup)).toMatchObject({ success: 1, failed: 0 });
    expect(await readFile(target, 'utf8')).toBe('backup content');
    await expect(lstat(backup)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('preserves both a newer destination and the original backup on a conflict', async () => {
    const { backup, source, target } = await stored('conflict.txt');
    await mkdir(join(fixture.home, 'Documents'), { recursive: true });
    await writeFile(target, 'newer document');
    const result = await restoreBackup(backup);
    expect(result).toMatchObject({ success: 0, failed: 1 });
    expect(result.errors[0]).toContain('preservado');
    expect(await readFile(target, 'utf8')).toBe('newer document');
    expect(await readFile(source, 'utf8')).toBe('backup content');
  });
  it('does not replace dangling destination symlinks', async () => {
    const { backup, source, target } = await stored('dangling.txt');
    await mkdir(join(fixture.home, 'Documents'), { recursive: true });
    await symlink(join(fixture.home, 'missing'), target);
    expect((await restoreBackup(backup)).failed).toBe(1);
    expect((await lstat(target)).isSymbolicLink()).toBe(true);
    expect(await readFile(source, 'utf8')).toBe('backup content');
  });
  it('restores a symbolic link itself without opening or changing its target', async () => {
    const backup = await ensureBackupDir();
    await mkdir(join(backup, 'HOME'));
    await symlink('/never-follow-this-target', join(backup, 'HOME', 'shortcut'));
    expect((await restoreBackup(backup)).success).toBe(1);
    expect(await readlink(join(fixture.home, 'shortcut'))).toBe('/never-follow-this-target');
  });
  it('rejects linked session roots and destination parents outside home', async () => {
    const { backup } = await stored('outside.txt');
    await symlink(backup, join(getBackupDir(), 'redirect'));
    expect((await restoreBackup(join(getBackupDir(), 'redirect'))).failed).toBe(1);
    const escaped = await ensureBackupDir();
    await mkdir(join(escaped, 'HOME', 'escape', 'new-folder'), { recursive: true });
    await writeFile(join(escaped, 'HOME', 'escape', 'new-folder', 'file'), 'backup');
    await symlink('/private/tmp', join(fixture.home, 'escape'));
    const result = await restoreBackup(escaped);
    expect(result).toMatchObject({ success: 0, failed: 1 });
    expect(result.errors[0]).toContain('outside home');
    expect(await readFile(join(escaped, 'HOME', 'escape', 'new-folder', 'file'), 'utf8')).toBe('backup');
  });
});
