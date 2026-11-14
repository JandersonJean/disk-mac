import { describe, expect, it, vi } from 'vitest';
import { removeReviewedSnapshots, type SnapshotDependencies } from './backup-snapshots.js';
const first = '2026-11-01-120000', second = '2026-11-02-120000';
describe('reviewed snapshot removal', () => {
  it('rejects injected or stale dates before requesting authorization', async () => {
    const deps: SnapshotDependencies = { list: vi.fn(async () => ({ dates: [first] })), administrator: vi.fn(async () => '') };
    await expect(removeReviewedSnapshots(['; purge'], deps)).rejects.toThrow('válidos');
    await expect(removeReviewedSnapshots([second], deps)).rejects.toThrow('mudou');
    expect(deps.administrator).not.toHaveBeenCalled();
  });
  it('uses one authorization for reviewed dates and verifies which ones disappeared', async () => {
    const deps: SnapshotDependencies = { list: vi.fn().mockResolvedValueOnce({ dates: [first, second] }).mockResolvedValueOnce({ dates: [] }), administrator: vi.fn(async () => '') };
    const result = await removeReviewedSnapshots([first, second], deps);
    expect(deps.administrator).toHaveBeenCalledExactlyOnceWith([
      { file: '/usr/bin/tmutil', args: ['deletelocalsnapshots', first] },
      { file: '/usr/bin/tmutil', args: ['deletelocalsnapshots', second] },
    ]);
    expect(result).toMatchObject({ success: true, message: '2 de 2 snapshots removidos.' });
  });
  it('reports cancelled authorization without claiming success', async () => {
    const deps: SnapshotDependencies = { list: vi.fn(async () => ({ dates: [first] })), administrator: vi.fn().mockRejectedValue(new Error('User canceled (-128)')) };
    expect(await removeReviewedSnapshots([first], deps)).toMatchObject({ success: false, error: 'A autorização do macOS foi cancelada.' });
  });
  it('reports partial results if only some snapshots were removed', async () => {
    const deps: SnapshotDependencies = { list: vi.fn().mockResolvedValueOnce({ dates: [first, second] }).mockResolvedValueOnce({ dates: [second] }), administrator: vi.fn().mockRejectedValue(new Error('Permission denied')) };
    expect(await removeReviewedSnapshots([first, second], deps)).toMatchObject({ success: false, message: '1 de 2 snapshots removidos.' });
  });
});
