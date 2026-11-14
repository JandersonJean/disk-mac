import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, mkdir, writeFile, link, symlink, rm, lstat, rename } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { analyzeDisk } from './disk-analysis.js';
import { trashAnalyzedItems, trashRestriction } from './disk-explorer.js';

let root: string;
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'disk-analysis-test-'))); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function fixture() {
  await mkdir(join(root, 'folder'));
  await writeFile(join(root, 'folder', 'large.bin'), Buffer.alloc(80_000, 65));
  await writeFile(join(root, 'small.bin'), Buffer.alloc(8_000, 66));
  return analyzeDisk(root);
}
describe('disk measurements', () => {
  it('aggregates allocated space and lists the largest nested files', async () => {
    const progress = vi.fn();
    await fixture();
    const report = await analyzeDisk(root, { onProgress: progress });
    expect(report.status).toBe('complete');
    expect(report.files).toBe(2);
    expect(report.largestFiles.map((entry) => entry.name)).toEqual(['large.bin', 'small.bin']);
    expect(report.bytes).toBe(report.entries.reduce((sum, entry) => sum + entry.bytes, 0));
    const large = await lstat(join(root, 'folder', 'large.bin'));
    expect(report.largestFiles[0].bytes).toBe(large.blocks * 512);
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ files: 2, bytes: report.bytes }));
  });
  it('does not traverse symlinks or count hard-linked file data twice', async () => {
    await fixture();
    await link(join(root, 'small.bin'), join(root, 'alias.bin'));
    await symlink(root, join(root, 'folder', 'loop'));
    const report = await analyzeDisk(root);
    expect(report.status).toBe('complete');
    expect(report.largestFiles).toHaveLength(2);
    expect(report.files).toBe(3); // two unique regular files, one symlink
  });
  it('reports entry and traversal limits as partial instead of empty/complete', async () => {
    await fixture();
    const entries = await analyzeDisk(root, { maxEntries: 1 });
    expect(entries.entries).toHaveLength(1);
    expect(entries.status).toBe('partial');
    const files = await analyzeDisk(root, { maxFiles: 1 });
    expect(files.status).toBe('partial');
    expect(files.warnings.length).toBeGreaterThan(0);
  });
  it('rejects invalid paths and regular-file roots', async () => {
    await fixture();
    await expect(analyzeDisk('relative')).rejects.toThrow('pasta válida');
    await expect(analyzeDisk(join(root, 'small.bin'))).rejects.toThrow('não é uma pasta');
  });
});
describe('reviewed move to Trash', () => {
  it('accepts only files in the current, fresh analysis', async () => {
    const report = await fixture();
    const trash = vi.fn();
    await expect(trashAnalyzedItems(report, [join(root, 'unknown')], trash)).rejects.toThrow('não pertence');
    await expect(trashAnalyzedItems({ ...report, scannedAt: new Date(0).toISOString() }, [report.entries[0].path], trash)).rejects.toThrow('expirou');
    expect(trash).not.toHaveBeenCalled();
  });
  it('refuses items replaced or modified after measurement', async () => {
    const report = await fixture();
    const path = join(root, 'small.bin');
    await rename(path, join(root, 'old.bin'));
    await writeFile(path, 'replacement');
    const trash = vi.fn();
    const result = await trashAnalyzedItems(report, [path], trash);
    expect(result.moved).toEqual([]);
    expect(result.errors[0]).toContain('mudou');
    expect(trash).not.toHaveBeenCalled();
  });
  it('deduplicates selected descendants and sends the reviewed parent to the Trash API', async () => {
    const report = await fixture();
    const trash = vi.fn(async () => {});
    const parent = join(root, 'folder');
    const result = await trashAnalyzedItems(report, [parent, join(parent, 'large.bin')], trash);
    expect(result.moved).toEqual([parent]);
    expect(trash).toHaveBeenCalledExactlyOnceWith(parent);
  });
  it('protects applications, system directories, home folders and app state', async () => {
    const report = await fixture();
    const entry = report.entries[0];
    for (const path of ['/System/Library', '/Applications/Example.app', '/Applications/Example.app/Contents/data', homedir(), join(homedir(), 'Documents'), join(homedir(), '.Trash', 'file')]) {
      expect(trashRestriction({ ...entry, path }, '/')).not.toBeNull();
    }
    expect(trashRestriction({ ...entry, path: join(root, 'state', 'data') }, root, [join(root, 'state')])).not.toBeNull();
    expect(trashRestriction({ ...entry, status: 'partial' }, root)).not.toBeNull();
    expect(trashRestriction({ ...entry, owner: -1 }, root)).not.toBeNull();
  });
  it('moves a symlink itself without touching its target', async () => {
    await fixture();
    const path = join(root, 'shortcut');
    await symlink(join(root, 'small.bin'), path);
    const report = await analyzeDisk(root);
    const result = await trashAnalyzedItems(report, [path], async (item) => { await rename(item, join(root, 'trashed-link')); });
    expect(result.moved).toEqual([path]);
    expect((await lstat(join(root, 'small.bin'))).isFile()).toBe(true);
    expect((await lstat(join(root, 'trashed-link'))).isSymbolicLink()).toBe(true);
  });
});
