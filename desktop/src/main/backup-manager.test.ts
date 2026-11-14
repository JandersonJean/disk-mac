import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, utimes, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackupManager } from './backup-manager.js';

let fixture: string, root: string, home: string, manager: BackupManager;
beforeEach(async () => {
  fixture = await realpath(await mkdtemp(join(tmpdir(), 'disk-mac-backups-')));
  home = join(fixture, 'home'); root = join(home, 'backups');
  await mkdir(root, { recursive: true });
  manager = new BackupManager(root, home);
});
afterEach(async () => { await rm(fixture, { recursive: true, force: true }); });
async function session(name: string, ageDays = 0) {
  const path = join(root, name);
  await mkdir(join(path, 'HOME', 'Documents'), { recursive: true });
  await writeFile(join(path, 'HOME', 'Documents', 'a.txt'), 'saved content');
  await utimes(path, new Date(), new Date(Date.now() - ageDays * 86_400_000));
  return path;
}
describe('backup inventory and preview', () => {
  it('measures real sessions, sorts newest first and ignores linked directories', async () => {
    const old = await session('old', 15);
    const recent = await session('recent');
    await symlink(old, join(root, 'redirect'));
    const overview = await manager.overview();
    expect(overview.sessions.map((copy) => copy.path)).toEqual([recent, old]);
    expect(overview.sessions[0]).toMatchObject({ files: 1, size: 13, partial: false });
  });
  it('finds existing and redirected destinations without following backup symlinks', async () => {
    const path = await session('copy');
    await mkdir(join(home, 'Documents'));
    await writeFile(join(home, 'Documents/a.txt'), 'current');
    await symlink(fixture, join(path, 'HOME', 'shortcut'));
    const preview = await manager.preview(path);
    expect(preview.files).toBe(2);
    expect(preview.conflicts).toBe(1);
    expect(preview.items.find((item) => item.originalPath.endsWith('a.txt'))?.conflict).toBe(true);
  });
  it('blocks paths outside the inventory root and linked session roots', async () => {
    const path = await session('copy');
    await symlink(path, join(root, 'redirect'));
    await expect(manager.preview(fixture)).rejects.toThrow('lista');
    await expect(manager.preview(join(root, 'redirect'))).rejects.toThrow('válida');
  });
  it('returns an empty inventory when no backup folder exists', async () => {
    const empty = new BackupManager(join(home, 'missing'), home);
    expect((await empty.overview()).sessions).toEqual([]);
  });
});
describe('reviewed expired backups', () => {
  it('rejects unknown, recent and stale selections before moving anything', async () => {
    const old = await session('old', 15);
    const recent = await session('recent');
    const overview = await manager.overview();
    const trash = vi.fn(async () => {});
    await expect(manager.trashExpired(overview.token, [recent], 7, trash)).rejects.toThrow('recente');
    await expect(manager.trashExpired(overview.token, [join(root, 'unknown')], 7, trash)).rejects.toThrow('recente');
    await expect(manager.trashExpired('old-token', [old], 7, trash)).rejects.toThrow('expirou');
    expect(trash).not.toHaveBeenCalled();
  });
  it('moves only reviewed expired copies and invalidates the used inventory', async () => {
    const old = await session('old', 15);
    await session('recent');
    const overview = await manager.overview();
    const trash = vi.fn(async () => {});
    expect(await manager.trashExpired(overview.token, [old], 7, trash)).toEqual({ moved: [old], errors: [] });
    expect(trash).toHaveBeenCalledExactlyOnceWith(old);
    await expect(manager.trashExpired(overview.token, [old], 7, trash)).rejects.toThrow('expirou');
  });
  it('preserves a backup when nested contents change after review', async () => {
    const old = await session('old', 15);
    const overview = await manager.overview();
    await writeFile(join(old, 'HOME/Documents/a.txt'), 'new content inside an old directory');
    const trash = vi.fn(async () => {});
    const result = await manager.trashExpired(overview.token, [old], 7, trash);
    expect(result.moved).toEqual([]);
    expect(result.errors[0]).toContain('mudaram');
    expect(trash).not.toHaveBeenCalled();
  });
});
