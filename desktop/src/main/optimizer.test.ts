import { describe, expect, it, vi } from 'vitest';
import { optimizationTasks, optimizeSystem, type OptimizerDependencies } from './optimizer.js';

function dependencies(): OptimizerDependencies {
  return { available: vi.fn(async () => true), execute: vi.fn(async () => ''), administrator: vi.fn(async () => '') };
}
describe('system optimization', () => {
  it.each([[], ['unknown'], ['dns', 'dns'], ['; rm -rf /'], null, 'quicklook'])(
    'rejects invalid selections before executing any command (%j)', async (selection) => {
      const deps = dependencies();
      await expect(optimizeSystem(selection, undefined, deps)).rejects.toThrow('Selecione');
      expect(deps.execute).not.toHaveBeenCalled();
      expect(deps.administrator).not.toHaveBeenCalled();
    });
  it('runs only the selected fixed commands, without requesting privileges for user tasks', async () => {
    const deps = dependencies();
    const report = await optimizeSystem(['quicklook'], undefined, deps);
    expect(deps.execute).toHaveBeenNthCalledWith(1, { file: '/usr/bin/qlmanage', args: ['-r', 'cache'] });
    expect(deps.execute).toHaveBeenNthCalledWith(2, { file: '/usr/bin/qlmanage', args: ['-r'] });
    expect(deps.administrator).not.toHaveBeenCalled();
    expect(report.results).toMatchObject([{ id: 'quicklook', status: 'applied' }]);
  });
  it('detects and skips unavailable macOS utilities', async () => {
    const deps = dependencies();
    deps.available = vi.fn(async (file) => file !== '/usr/sbin/periodic');
    expect((await optimizationTasks(deps)).find((task) => task.id === 'periodic')?.available).toBe(false);
    const report = await optimizeSystem(['periodic'], undefined, deps);
    expect(report.results[0].status).toBe('skipped');
    expect(deps.administrator).not.toHaveBeenCalled();
  });
  it('keeps file-cache purging opt-in, correctly described and behind macOS authorization', async () => {
    const deps = dependencies();
    const catalog = await optimizationTasks(deps);
    expect(catalog.filter((task) => task.id === 'dns')).toHaveLength(1);
    expect(catalog.find((task) => task.id === 'file-cache')).toMatchObject({ recommended: false, administrator: true, impact: expect.stringContaining('Não libera armazenamento em disco') });
    await optimizeSystem(['file-cache'], undefined, deps);
    expect(deps.administrator).toHaveBeenCalledExactlyOnceWith([{ file: '/usr/sbin/purge', args: [], timeoutMs: 60_000 }]);
  });
  it('requests administrator authorization only for the selected administrator routine', async () => {
    const deps = dependencies();
    await optimizeSystem(['dns'], undefined, deps);
    expect(deps.execute).not.toHaveBeenCalled();
    expect(deps.administrator).toHaveBeenCalledExactlyOnceWith([
      { file: '/usr/bin/dscacheutil', args: ['-flushcache'] },
      { file: '/usr/bin/killall', args: ['-HUP', 'mDNSResponder'] },
    ]);
  });
  it('stops the remaining queue when authorization is cancelled', async () => {
    const deps = dependencies();
    deps.administrator = vi.fn().mockRejectedValue(new Error('User canceled. (-128)'));
    const report = await optimizeSystem(['dns', 'applications'], undefined, deps);
    expect(report.results).toMatchObject([{ id: 'dns', status: 'cancelled' }]);
    expect(deps.execute).not.toHaveBeenCalled();
  });
  it('reports failures instead of claiming an unavailable Spotlight index was rebuilt', async () => {
    const deps = dependencies();
    deps.administrator = vi.fn(async () => '/: Indexing disabled.');
    expect((await optimizeSystem(['spotlight'], undefined, deps)).results[0].status).toBe('failed');
  });
  it('reports per-task failure and still handles subsequent tasks', async () => {
    const deps = dependencies();
    deps.execute = vi.fn().mockRejectedValueOnce(new Error('ETIMEDOUT')).mockResolvedValue('');
    const progress = vi.fn();
    const report = await optimizeSystem(['quicklook', 'applications'], progress, deps);
    expect(report.results.map((result) => result.status)).toEqual(['failed', 'applied']);
    expect(progress).toHaveBeenLastCalledWith(2, 2, 'Associações de aplicativos');
  });
});
