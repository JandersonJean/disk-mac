import { describe, expect, it, vi } from 'vitest';
import { ProcessController } from './process-control.js';
import { parseProcessRecords, processGuard, processSnapshot, type ProcessRecord } from './process-inventory.js';

function record(overrides: Partial<ProcessRecord> = {}): ProcessRecord {
  return { ...parseProcessRecords('120 1 501 alice 0:10.50 10240 Thu Nov 12 12:00:00 2026 S /Applications/Example.app/Contents/MacOS/Example Helper')[0], ...overrides };
}
function harness() {
  let records = [record()];
  let now = 0;
  const read = vi.fn(async () => records);
  const signal = vi.fn((_pid: number, _signal: 'SIGTERM' | 'SIGKILL') => undefined);
  const policy = vi.fn(() => ({ selfPid: 900, currentUid: 501 }));
  const controller = new ProcessController({ read, signal, policy, now: () => now, wait: async () => undefined });
  return { controller, read, signal, policy, setRecords: (value: ProcessRecord[]) => { records = value; }, advance: (ms: number) => { now += ms; } };
}

describe('process inventory and protections', () => {
  it('keeps identity stable across samples but changes it for another start time, owner or executable', () => {
    const line = '120 1 501 alice 0:10.50 10240 Thu Nov 12 12:00:00 2026 S /Applications/Example.app/Contents/MacOS/Example Helper';
    const first = parseProcessRecords(line)[0];
    expect(first.name).toBe('Example Helper');
    expect(first.memoryBytes).toBe(10240 * 1024);
    expect(parseProcessRecords(line.replace('0:10.50 10240', '2:30.20 20480'))[0].identity).toBe(first.identity);
    for (const other of [line.replace('12:00:00', '12:00:01'), line.replace('501 alice', '502 bob'), line.replace('Example Helper', 'Other Helper')]) {
      expect(parseProcessRecords(other)[0].identity).not.toBe(first.identity);
    }
    expect(() => parseProcessRecords('unavailable')).toThrow();
  });

  it('protects self, ancestors, descendants, orphaned bundle helpers, other users and critical components', () => {
    const rows = [
      record(), record({ pid: 900, parentPid: 800, command: '/Applications/Disk Mac.app/Contents/MacOS/Disk Mac' }),
      record({ pid: 800 }), record({ pid: 901, parentPid: 900 }), record({ pid: 902, parentPid: 901 }),
      record({ pid: 903, command: '/Applications/Disk Mac.app/Contents/Frameworks/Helper.app/Contents/MacOS/Helper' }),
      record({ pid: 1, uid: 0 }), record({ pid: 125, uid: 0 }), record({ pid: 126, uid: 502 }),
      record({ pid: 127, name: 'WindowServer' }), record({ pid: 128, state: 'Z' }),
    ];
    const guard = processGuard(rows, { selfPid: 900, currentUid: 501 });
    expect(guard(rows[0])).toBeNull();
    for (const row of rows.slice(1)) expect(guard(row)).toBeTruthy();
    const visible = processSnapshot(rows, { selfPid: 900, currentUid: 501 });
    expect(visible[0].terminationBlockedReason).toBeUndefined();
    expect(visible[1].terminationBlockedReason).toBeTruthy();
    expect(visible[0]).not.toHaveProperty('command');
    expect(visible[0]).not.toHaveProperty('uid');
  });

  it('handles broken and cyclic parent chains without blocking unrelated user processes', () => {
    const rows = [record({ parentPid: 121 }), record({ pid: 121, parentPid: 120 })];
    expect(processGuard(rows, { selfPid: 900, currentUid: 501 })(rows[0])).toBeNull();
    expect(processGuard(rows, { selfPid: 900, currentUid: -1 })(rows[0])).toBeTruthy();
  });
});

describe('process termination', () => {
  it.each([null, {}, { pid: -120, identity: record().identity }, { pid: 0, identity: record().identity }, { pid: 1, identity: record().identity }, { pid: 2.5, identity: record().identity }, { pid: 2147483648, identity: record().identity }, { pid: 120, identity: 'invalid' }])('rejects invalid targets %j before reading or signaling', async (target) => {
    const h = harness();
    await expect(h.controller.review(target)).rejects.toThrow('válido');
    expect(h.read).not.toHaveBeenCalled();
    expect(h.signal).not.toHaveBeenCalled();
  });

  it('rejects vanished, stale and protected targets during review', async () => {
    const h = harness();
    for (const records of [[], [record({ identity: 'b'.repeat(64) })], [record({ uid: 0 })], [record({ state: 'Z' })]]) {
      h.setRecords(records);
      await expect(h.controller.review(record())).rejects.toThrow();
    }
    expect(h.signal).not.toHaveBeenCalled();
  });

  it.each(['terminate', 'force'] as const)('sends only the explicitly chosen %s signal and confirms exit', async (mode) => {
    const h = harness();
    const review = await h.controller.review(record());
    h.signal.mockImplementation(() => { h.setRecords([]); return undefined; });
    expect((await h.controller.terminate(review.token, mode)).status).toBe('exited');
    expect(h.signal.mock.calls).toEqual([[120, mode === 'force' ? 'SIGKILL' : 'SIGTERM']]);
    await expect(h.controller.terminate(review.token, mode)).rejects.toThrow('expirou');
  });

  it('does not escalate automatically when SIGTERM is ignored', async () => {
    const h = harness();
    const review = await h.controller.review(record());
    expect((await h.controller.terminate(review.token, 'terminate')).status).toBe('running');
    expect(h.signal.mock.calls).toEqual([[120, 'SIGTERM']]);
  });

  it('reports a vanished process without signaling and rejects a reused PID', async () => {
    const h = harness();
    let review = await h.controller.review(record());
    h.setRecords([]);
    expect((await h.controller.terminate(review.token, 'terminate')).status).toBe('already-exited');
    h.setRecords([record()]);
    review = await h.controller.review(record());
    h.setRecords([record({ identity: 'b'.repeat(64) })]);
    await expect(h.controller.terminate(review.token, 'force')).rejects.toThrow('outro processo');
    expect(h.signal).not.toHaveBeenCalled();
  });

  it('rechecks ownership and protections at the moment of termination', async () => {
    const h = harness();
    const review = await h.controller.review(record());
    h.policy.mockReturnValue({ selfPid: 900, currentUid: 502 });
    await expect(h.controller.terminate(review.token, 'terminate')).rejects.toThrow('seu usuário');
    expect(h.signal).not.toHaveBeenCalled();
  });

  it('requires an unexpired, matching, uncancelled confirmation and a valid mode', async () => {
    const h = harness();
    let review = await h.controller.review(record());
    await expect(h.controller.terminate('wrong', 'terminate')).rejects.toThrow('expirou');
    await expect(h.controller.terminate(review.token, 'SIGKILL')).rejects.toThrow('Escolha');
    h.advance(60_000);
    await expect(h.controller.terminate(review.token, 'terminate')).rejects.toThrow('expirou');
    review = await h.controller.review(record());
    h.controller.cancel(review.token);
    await expect(h.controller.terminate(review.token, 'force')).rejects.toThrow('expirou');
    review = await h.controller.review(record());
    h.controller.cancel();
    await expect(h.controller.terminate(review.token, 'force')).rejects.toThrow('expirou');
    expect(h.signal).not.toHaveBeenCalled();
  });

  it.each(['EPERM', 'EACCES'])('reports macOS permission denial (%s)', async (code) => {
    const h = harness();
    const review = await h.controller.review(record());
    h.signal.mockImplementation(() => { throw Object.assign(new Error('denied'), { code }); });
    await expect(h.controller.terminate(review.token, 'terminate')).rejects.toThrow('não permitiu');
  });

  it('handles exit between the fresh read and the signal', async () => {
    const h = harness();
    const review = await h.controller.review(record());
    h.signal.mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
    expect((await h.controller.terminate(review.token, 'terminate')).status).toBe('already-exited');
  });

  it('does not claim exit when verification fails', async () => {
    const h = harness();
    const review = await h.controller.review(record());
    h.read.mockResolvedValueOnce([record()]).mockRejectedValueOnce(new Error('ps unavailable'));
    expect((await h.controller.terminate(review.token, 'force')).status).toBe('unconfirmed');
    expect(h.signal).toHaveBeenCalledOnce();
  });

  it('sends no signal if the last fresh read fails', async () => {
    const h = harness();
    const review = await h.controller.review(record());
    h.read.mockRejectedValueOnce(new Error('ps unavailable'));
    await expect(h.controller.terminate(review.token, 'terminate')).rejects.toThrow();
    expect(h.signal).not.toHaveBeenCalled();
  });

  it('allows only one operation while termination is in flight', async () => {
    const h = harness();
    const review = await h.controller.review(record());
    let release!: (rows: ProcessRecord[]) => void;
    h.read.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const first = h.controller.terminate(review.token, 'terminate');
    await expect(h.controller.terminate(review.token, 'force')).rejects.toThrow('Aguarde');
    await expect(h.controller.review(record())).rejects.toThrow('Aguarde');
    release([]);
    await first;
    expect(h.signal).not.toHaveBeenCalled();
  });
});
