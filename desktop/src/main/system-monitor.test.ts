import { execFile } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { networkRates, parseBattery, parseGpuUsage, parseNetworkCounters, parseSwapUsage, parseVmStat, SystemMonitor } from './system-monitor.js';
import { parseProcessRecords, processSnapshot } from './process-inventory.js';
import { LIVE_METRIC_INTERVAL_MS, PROCESS_INTERVAL_MS } from '../shared/system-monitor.js';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

describe('system monitoring parsers', () => {
  it('reads GPU device utilization and distinguishes zero from unavailable', () => {
    const statistics = (value: number) => `"PerformanceStatistics" = {"Renderer Utilization %"=99,"Device Utilization %"=${value},"Tiler Utilization %"=24}`;
    expect(parseGpuUsage(statistics(0))).toBe(0);
    expect(parseGpuUsage([statistics(14), statistics(26), statistics(900)].join('\n'))).toBe(26);
    expect(parseGpuUsage('"Device Utilization %"=72\n"PerformanceStatistics" = {"Renderer Utilization %"=68}')).toBeNull();
  });

  it('counts physical memory categories once and uses physical compressor size', () => {
    const memory = parseVmStat(`Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free: 100.
Pages active: 500.
Pages inactive: 200.
Pages speculative: 30.
Pages wired down: 100.
Pages purgeable: 20.
File-backed pages: 400.
Anonymous pages: 300.
Pages stored in compressor: 1600.
Pages occupied by compressor: 80.`, 1024 * 16384);
    expect(memory.usedBytes).toBe(460 * 16384);
    expect(memory.compressedBytes).toBe(80 * 16384);
    expect(memory.cachedBytes).toBe(420 * 16384);
    expect(memory.freeBytes).toBe(100 * 16384);
  });

  it('rejects partial VM data instead of inventing memory use', () => {
    expect(() => parseVmStat('Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages free: 100.', 1e9)).toThrow();
  });

  it('parses swap units and preserves process names containing spaces', () => {
    expect(parseSwapUsage('total = 4096.00M used = 1.50G free = 2560.00M (encrypted)')).toBe(1.5 * 1024 ** 3);
    expect(parseProcessRecords(' 42 1 501 alice 2:05.50 10240 Thu Nov 12 12:00:00 2026 S /Applications/Browser.app/Contents/MacOS/Browser Helper\n 51 1 0 root 0:00.00 0 Thu Nov 12 12:00:00 2026 S kernel_task')).toMatchObject([
      { pid: 42, user: 'alice', cpuTimeMs: 125500, memoryBytes: 10240 * 1024, name: 'Browser Helper' },
      { pid: 51, user: 'root', cpuTimeMs: 0, memoryBytes: 0, name: 'kernel_task' },
    ]);
    expect(() => parseProcessRecords('permission denied')).toThrow();
  });

  it('uses CPU time deltas and ignores a reused PID or a reset counter', () => {
    const line = '42 1 501 alice 2:05.50 10240 Thu Nov 12 12:00:00 2026 S /Applications/Test';
    const [first] = parseProcessRecords(line);
    const previous = { at: 1000, cpuTimes: new Map([[first.identity, first.cpuTimeMs]]) };
    expect(processSnapshot([first])[0].cpuPercent).toBeNull();
    const active = parseProcessRecords(line.replace('2:05.50', '2:08.50'));
    expect(processSnapshot(active, undefined, { previous, at: 3000 })[0].cpuPercent).toBe(150);
    const reused = parseProcessRecords(line.replace('12:00:00', '12:00:01'));
    const reset = parseProcessRecords(line.replace('2:05.50', '0:00.00'));
    for (const reading of [reused, reset]) {
      expect(processSnapshot(reading, undefined, { previous, at: 3000 })[0].cpuPercent).toBeNull();
    }
  });

  it('deduplicates IPv4/IPv6 counters and excludes loopback/bridge/tunnel traffic', () => {
    const network = parseNetworkCounters(`Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll
en0 1500 <Link#6> aa:bb:cc:dd:ee:ff 10 0 3000 20 0 6000 0
en0 1500 192.168.1 192.168.1.2 10 - 3000 20 - 6000 -
en0 1500 fe80:: aa:bb:cc:dd:ee:ff 10 - 3000 20 - 6000 -
lo0 16384 <Link#1> loopback 50 0 9999 50 0 9999 0
bridge0 1500 <Link#2> aa:bb:cc:dd:ee:ff 10 0 3000 20 0 6000 0
utun0 1380 <Link#3> none 10 0 3000 20 0 6000 0`);
    expect([...network]).toEqual([['en0', { received: 3000, sent: 6000 }]]);
    expect(networkRates(network, new Map([['en0', { received: 1000, sent: 1000 }]]), 2)).toEqual({ receivedBytesPerSecond: 1000, sentBytesPerSecond: 2500 });
  });

  it('leaves rates unknown until a delta exists and after a counter resets', () => {
    const current = new Map([['en0', { received: 10, sent: 20 }]]);
    expect(networkRates(current, null, 2).receivedBytesPerSecond).toBeNull();
    expect(networkRates(current, new Map([['en0', { received: 100, sent: 200 }]]), 2).receivedBytesPerSecond).toBeNull();
    expect(networkRates(current, new Map([['en1', { received: 10, sent: 20 }]]), 2).receivedBytesPerSecond).toBeNull();
  });

  it('does not confuse discharging or charged with charging', () => {
    expect(parseBattery("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1) 78%; discharging; 4:00 remaining present: true")).toEqual({ percent: 78, charging: false, powerSource: 'Bateria' });
    expect(parseBattery("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1) 100%; charged; 0:00 remaining present: true")?.charging).toBe(false);
    expect(parseBattery("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1) 80%; charging; 1:00 remaining present: true")?.charging).toBe(true);
    expect(parseBattery("Now drawing from 'AC Power'")).toBeNull();
  });
});

describe('monitor sampling', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  it('publishes metrics at 500 ms without waiting for battery or process readings', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    const onSample = vi.fn();
    const monitor = new SystemMonitor(onSample);
    let finishBattery: (() => void) | undefined;
    let finishProcesses: (() => void) | undefined;
    vi.mocked(execFile).mockImplementation((file, _args, _options, callback) => {
      if (file === '/usr/bin/pmset') finishBattery = () => callback?.(null, '', '');
      else if (file === '/bin/ps') finishProcesses = () => callback?.(null, '42 1 501 alice 2:05.50 10240 Thu Nov 12 12:00:00 2026 S /Applications/Test', '');
      else callback?.(new Error('unavailable'), '', '');
      return {} as ReturnType<typeof execFile>;
    });
    try {
      monitor.setMode('full');
      await vi.advanceTimersByTimeAsync(PROCESS_INTERVAL_MS);
      expect(finishBattery).toBeDefined();
      expect(finishProcesses).toBeDefined();
      expect(onSample).toHaveBeenCalledTimes(5);
      expect(vi.mocked(execFile).mock.calls.filter(([file]) => file === '/usr/bin/pmset')).toHaveLength(1);
      expect(vi.mocked(execFile).mock.calls.filter(([file]) => file === '/bin/ps')).toHaveLength(1);
      expect(monitor.getSnapshot()?.processesSampledAt).toBeNull();
      finishProcesses?.();
      await vi.advanceTimersByTimeAsync(LIVE_METRIC_INTERVAL_MS);
      expect(monitor.getSnapshot()?.processes[0]).toMatchObject({ pid: 42, cpuPercent: null });
      expect(vi.mocked(execFile).mock.calls.filter(([file]) => file === '/bin/ps')).toHaveLength(2);
    } finally {
      monitor.setMode('off');
      finishBattery?.();
      finishProcesses?.();
    }
  });

  it('samples only the selected metric every five seconds and stops when it is disabled', async () => {
    vi.useFakeTimers();
    const onSample = vi.fn();
    const monitor = new SystemMonitor(onSample);
    vi.mocked(execFile).mockImplementation((_file, _args, _options, callback) => {
      callback?.(null, 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nAnonymous pages: 300.\nPages wired down: 100.\nPages occupied by compressor: 80.\nPages purgeable: 20.\nPages free: 100.\nFile-backed pages: 400.', '');
      return {} as ReturnType<typeof execFile>;
    });

    monitor.setMode('cpu');
    await vi.advanceTimersByTimeAsync(5000);
    expect(execFile).not.toHaveBeenCalled();
    expect(onSample).toHaveBeenCalledTimes(2);
    expect(monitor.getSnapshot()).toBeNull();

    monitor.setMode('memory');
    await vi.advanceTimersByTimeAsync(5000);
    expect(vi.mocked(execFile).mock.calls.map(([file]) => file)).toEqual(['/usr/bin/vm_stat', '/usr/bin/vm_stat']);
    expect(monitor.getHistory().at(-1)?.memoryPercent).toBeGreaterThan(0);
    expect(monitor.getSnapshot()).toBeNull();

    monitor.setMode('off');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(execFile).toHaveBeenCalledTimes(2);
    expect(onSample).toHaveBeenCalledTimes(4);
  });

  it('discards an in-flight background reading when the full monitor opens', async () => {
    vi.useFakeTimers();
    const monitor = new SystemMonitor();
    let finishMemory: (() => void) | undefined;
    vi.mocked(execFile).mockImplementation((file, _args, _options, callback) => {
      if (file === '/usr/bin/vm_stat' && !finishMemory) {
        finishMemory = () => callback?.(null, '', '');
      } else {
        callback?.(Object.assign(new Error('unavailable'), { code: 1 }), '', '');
      }
      return {} as ReturnType<typeof execFile>;
    });
    monitor.setMode('memory');
    monitor.setMode('full');
    finishMemory?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(monitor.getSnapshot()).not.toBeNull();
    expect(monitor.getHistory()).toHaveLength(1);
    expect(vi.mocked(execFile).mock.calls.map(([file]) => file)).toContain('/bin/ps');

    vi.mocked(execFile).mockClear();
    monitor.setMode('cpu');
    expect(monitor.getSnapshot()).toBeNull();
    await vi.advanceTimersByTimeAsync(5000);
    expect(execFile).not.toHaveBeenCalled();
    monitor.setMode('off');
  });

  it('collects network rates in the background with only the network probe', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    const monitor = new SystemMonitor();
    let received = 1000;
    vi.mocked(execFile).mockImplementation((file, _args, _options, callback) => {
      const counters = `Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll\nen0 1500 <Link#6> aa:bb:cc:dd:ee:ff 10 0 ${received} 20 0 6000 0`;
      callback?.(null, file === '/usr/sbin/netstat' ? counters : '', '');
      return {} as ReturnType<typeof execFile>;
    });

    monitor.setMode('network');
    await vi.advanceTimersByTimeAsync(0);
    expect(monitor.getHistory().at(-1)?.networkDown).toBeNull();
    received += 10_000;
    // Reapplying the same selection must preserve the baseline and polling timer.
    monitor.setMode('network');
    await vi.advanceTimersByTimeAsync(5000);
    expect(monitor.getHistory().at(-1)).toMatchObject({ networkDown: 2000, networkUp: 0, cpuPercent: null });
    expect(vi.mocked(execFile).mock.calls.map(([file]) => file)).toEqual([
      '/usr/sbin/netstat', '/usr/sbin/netstat',
    ]);
    expect(monitor.getSnapshot()).toBeNull();
    monitor.setMode('off');
  });
});
