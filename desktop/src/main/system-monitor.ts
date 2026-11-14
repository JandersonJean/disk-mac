import { execFile } from 'node:child_process';
import { statfs } from 'node:fs/promises';
import { cpus, loadavg, totalmem } from 'node:os';
import { processSnapshot, readProcessRecords, type ProcessSample } from './process-inventory.js';
import { LIVE_METRIC_INTERVAL_MS, METRIC_HISTORY_MS, PROCESS_INTERVAL_MS, type MetricPoint, type SystemMetric, type SystemSnapshot } from '../shared/system-monitor.js';

const HISTORY_LIMIT = Math.ceil(METRIC_HISTORY_MS / LIVE_METRIC_INTERVAL_MS) + 2;
const SLOW_PROBE_MS = 10_000;
type Memory = SystemSnapshot['memory'];
type Counter = { received: number; sent: number };
type CpuCounter = { total: number; idle: number; cores: number };
type Probe<T> = { value: T | null; error: string | null };

function run(command: string, args: string[], timeout = 1800): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      timeout,
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

async function probe<T>(label: string, fn: () => Promise<T>): Promise<Probe<T>> {
  try {
    return { value: await fn(), error: null };
  } catch {
    return { value: null, error: `${label}: o macOS não disponibilizou a leitura nesta atualização.` };
  }
}

/** Uses physical compressor pages, never the logical uncompressed pages stored inside it.
 * Apple definitions: https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/mach/vm_statistics.h
 * Anonymous and file-backed pages classify the active/inactive queues; adding those queues again
 * would count the same physical pages twice. These counters approximate Activity Monitor usage.
 */
export function parseVmStat(text: string, totalBytes: number): Omit<Memory, 'swapUsedBytes'> {
  const pageSize = Number(text.match(/page size of (\d+) bytes/)?.[1]);
  if (!Number.isFinite(pageSize) || pageSize <= 0) throw new Error('Missing VM page size');
  const values = new Map<string, number>();
  for (const line of text.split('\n')) {
    const match = line.match(/^([^:]+):\s*(\d+)\.?\s*$/);
    if (match) values.set(match[1].trim(), Number(match[2]));
  }
  const pages = (name: string): number => {
    const value = values.get(name);
    if (value === undefined || !Number.isFinite(value)) throw new Error(`Missing ${name}`);
    return value;
  };
  const anonymous = pages('Anonymous pages');
  const wired = pages('Pages wired down');
  const compressed = pages('Pages occupied by compressor');
  const purgeable = pages('Pages purgeable');
  const usedBytes = Math.min(totalBytes, Math.max(0, anonymous + wired + compressed - purgeable) * pageSize);
  return {
    totalBytes,
    usedBytes,
    freeBytes: pages('Pages free') * pageSize,
    wiredBytes: wired * pageSize,
    compressedBytes: compressed * pageSize,
    cachedBytes: (pages('File-backed pages') + purgeable) * pageSize,
    usagePercent: totalBytes > 0 ? (usedBytes / totalBytes) * 100 : null,
  };
}

export function parseSwapUsage(text: string): number {
  const match = text.match(/used\s*=\s*([\d.]+)([KMGT]?)\b/i);
  if (!match) throw new Error('Invalid swap sample');
  const value = Number(match[1]);
  if (!Number.isFinite(value)) throw new Error('Invalid swap amount');
  return value * 1024 ** ({ '': 0, K: 1, M: 2, G: 3, T: 4 }[match[2].toUpperCase()] ?? 0);
}

/** netstat repeats interface counters for link, IPv4 and IPv6 addresses. Keep only the link row
 * for each physical en* interface, excluding loopback, bridges and tunnels to avoid double counting.
 */
export function parseNetworkCounters(text: string): Map<string, Counter> {
  const lines = text.trim().split('\n');
  const headerIndex = lines.findIndex((line) => /\bName\b/.test(line) && /\bIbytes\b/.test(line));
  if (headerIndex < 0) throw new Error('Missing network header');
  const header = lines[headerIndex].trim().split(/\s+/);
  const receivedColumn = header.indexOf('Ibytes');
  const sentColumn = header.indexOf('Obytes');
  const counters = new Map<string, Counter>();
  for (const line of lines.slice(headerIndex + 1)) {
    const columns = line.trim().split(/\s+/);
    const name = columns[0]?.replace(/\*$/, '');
    if (columns.length < header.length || !/^en\d+$/.test(name) || !columns[2]?.startsWith('<Link#')) continue;
    const received = Number(columns[receivedColumn]);
    const sent = Number(columns[sentColumn]);
    if (!Number.isFinite(received) || !Number.isFinite(sent) || received < 0 || sent < 0) continue;
    counters.set(name, { received, sent });
  }
  return counters;
}

export function networkRates(
  current: Map<string, Counter>, previous: Map<string, Counter> | null, elapsedSeconds: number
): Pick<SystemSnapshot['network'], 'receivedBytesPerSecond' | 'sentBytesPerSecond'> {
  if (!previous || elapsedSeconds <= 0) return { receivedBytesPerSecond: null, sentBytesPerSecond: null };
  let received = 0;
  let sent = 0;
  let valid = 0;
  for (const [name, counter] of current) {
    const old = previous.get(name);
    if (!old || counter.received < old.received || counter.sent < old.sent) continue;
    received += counter.received - old.received;
    sent += counter.sent - old.sent;
    valid++;
  }
  return {
    receivedBytesPerSecond: valid ? received / elapsedSeconds : null,
    sentBytesPerSecond: valid ? sent / elapsedSeconds : null,
  };
}

export function parseBattery(text: string): SystemSnapshot['battery'] {
  const batteryLine = text.split('\n').find((line) => /InternalBattery/.test(line));
  if (!batteryLine) return null;
  const percent = Number(batteryLine.match(/(\d+)%;/)?.[1]);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw new Error('Invalid battery reading');
  return {
    percent,
    charging: /;\s*charging;/.test(batteryLine),
    powerSource: /'AC Power'/.test(text) ? 'Tomada' : /'Battery Power'/.test(text) ? 'Bateria' : 'Não informado',
  };
}

/** Drivers may omit this counter. For multiple GPUs, use the highest reported utilization. */
export function parseGpuUsage(text: string): number | null {
  let highest: number | null = null;
  for (const [, statistics] of text.matchAll(/"PerformanceStatistics"\s*=\s*\{([^}\r\n]*)\}/g)) {
    const value = statistics.match(/(?:^|,)\s*"Device Utilization %"\s*=\s*(\d+(?:\.\d+)?)\s*(?=,|$)/);
    if (!value) continue;
    const percent = Number(value[1]);
    if (percent <= 100) highest = highest === null ? percent : Math.max(highest, percent);
  }
  return highest;
}

function cpuCounters(): CpuCounter {
  const logicalCpus = cpus();
  return logicalCpus.reduce((result, cpu) => {
    result.total += Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
    result.idle += cpu.times.idle;
    return result;
  }, { total: 0, idle: 0, cores: logicalCpus.length });
}

type MonitoringMode = 'off' | 'full' | SystemMetric;

const BACKGROUND_INTERVAL_MS = 5000;
const LIVE_PROBE_TIMEOUT_MS = 350;

export class SystemMonitor {
  private snapshot: SystemSnapshot | null = null;
  private history: MetricPoint[] = [];
  private mode: MonitoringMode = 'off';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private inFlight: { generation: number; result: Promise<void> } | null = null;
  private previousCpu: CpuCounter | null = null;
  private previousNetwork: { counters: Map<string, Counter>; at: number } | null = null;
  private previousProcesses: ProcessSample | null = null;
  private processReading: Probe<SystemSnapshot['processes']> = { value: null, error: null };
  private processSampledAt: string | null = null;
  private processStartedAt = -Infinity;
  private processPending = false;
  private slowAt = -Infinity;
  private slowPending = false;
  private disk: Probe<SystemSnapshot['disk']> = { value: null, error: null };
  private battery: Probe<SystemSnapshot['battery']> = { value: null, error: null };
  private swap: Probe<number> = { value: null, error: null };

  constructor(private readonly onSample?: (snapshot: SystemSnapshot | null) => void) {}

  getSnapshot(): SystemSnapshot | null { return this.snapshot; }
  getHistory(): readonly MetricPoint[] { return this.history; }

  setMode(mode: MonitoringMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (mode !== 'full') {
      this.snapshot = null;
      this.previousProcesses = null;
      this.processReading = { value: null, error: null };
      this.processSampledAt = null;
      this.processStartedAt = -Infinity;
    }
    if (mode !== 'full' && mode !== 'network') this.previousNetwork = null;
    if (mode !== 'full' && mode !== 'cpu') this.previousCpu = null;
    if (mode !== 'off') void this.poll(this.generation);
  }

  private async poll(generation: number): Promise<void> {
    const started = performance.now();
    try { await this.sample(); } catch { /* A probe failure must never terminate the desktop app. */ }
    if (generation !== this.generation || this.mode === 'off') return;
    const interval = this.mode === 'full' ? LIVE_METRIC_INTERVAL_MS : BACKGROUND_INTERVAL_MS;
    this.timer = setTimeout(() => void this.poll(generation), Math.max(100, Math.ceil(interval - (performance.now() - started))));
    this.timer.unref();
  }

  async sample(): Promise<void> {
    const generation = this.generation;
    if (this.mode === 'off') return;
    // A window or setting can change while a command is running. Let it settle
    // before starting the new mode and discard readings for the old mode.
    while (this.inFlight) {
      const flight = this.inFlight;
      if (flight.generation === generation) return flight.result;
      await flight.result.catch(() => undefined);
      if (generation !== this.generation) return;
    }
    const result = this.collect(this.mode, generation).finally(() => { this.inFlight = null; });
    this.inFlight = { generation, result };
    return result;
  }

  private appendPoint(point: MetricPoint): void {
    this.history = [...this.history, point].slice(-HISTORY_LIMIT);
  }

  private readCpu(): SystemSnapshot['cpu'] {
    const current = cpuCounters();
    const old = this.previousCpu;
    this.previousCpu = current;
    const totalDelta = old ? current.total - old.total : 0;
    const usagePercent = old && old.cores === current.cores && totalDelta > 0
      ? Math.max(0, Math.min(100, 100 * (1 - (current.idle - old.idle) / totalDelta))) : null;
    return { usagePercent, logicalCores: current.cores, loadAverage: loadavg() };
  }

  private readMemory(totalBytes: number, timeout?: number) {
    return probe('Memória', async () => parseVmStat(await run('/usr/bin/vm_stat', [], timeout), totalBytes));
  }

  private readNetwork(timeout?: number) {
    return probe('Rede', async () => {
      const output = await run('/usr/sbin/netstat', ['-ibn'], timeout);
      return { counters: parseNetworkCounters(output), at: performance.now() };
    });
  }

  private measureNetwork(reading: { counters: Map<string, Counter>; at: number } | null): SystemSnapshot['network'] {
    if (!reading) {
      this.previousNetwork = null;
      return { receivedBytesPerSecond: null, sentBytesPerSecond: null, interfaces: [] };
    }
    const { at, counters } = reading;
    const previous = this.previousNetwork;
    this.previousNetwork = { counters, at };
    return {
      ...networkRates(counters, previous?.counters ?? null, previous ? (at - previous.at) / 1000 : 0),
      interfaces: [...counters.keys()],
    };
  }

  async refreshProcesses(force = false): Promise<void> {
    const started = performance.now();
    if (this.mode !== 'full' || this.processPending || (!force && started - this.processStartedAt < PROCESS_INTERVAL_MS)) return;
    const generation = this.generation;
    this.processPending = true;
    this.processStartedAt = started;
    try {
      const result = await probe('Processos', async () => {
        const records = await readProcessRecords();
        return { records, at: performance.now() };
      });
      if (generation !== this.generation) return;
      const reading = result.value;
      const previous = this.previousProcesses;
      this.processReading = {
        value: reading ? processSnapshot(reading.records, undefined, previous ? { previous, at: reading.at } : undefined) : null,
        error: result.error,
      };
      this.previousProcesses = reading
        ? { at: reading.at, cpuTimes: new Map(reading.records.map((record) => [record.identity, record.cpuTimeMs])) }
        : null;
      this.processSampledAt = new Date().toISOString();
    } finally {
      this.processPending = false;
    }
  }

  private refreshSlowMetrics(): void {
    const now = performance.now();
    if (this.slowPending || now - this.slowAt < SLOW_PROBE_MS) return;
    this.slowPending = true;
    this.slowAt = now;
    // These readings have their own cadence and never hold up the live snapshot.
    void Promise.all([
      probe('Disco', async () => {
        const disk = await statfs('/');
        const total = disk.blocks * disk.bsize;
        const free = disk.bavail * disk.bsize;
        return { totalBytes: total, freeBytes: free, usedBytes: Math.max(0, total - free) };
      }).then((disk) => { this.disk = disk; }),
      probe('Bateria', async () => parseBattery(await run('/usr/bin/pmset', ['-g', 'batt']))).then((battery) => { this.battery = battery; }),
      probe('Swap', async () => parseSwapUsage(await run('/usr/sbin/sysctl', ['-n', 'vm.swapusage']))).then((swap) => { this.swap = swap; }),
    ]).finally(() => { this.slowPending = false; });
  }

  private async collect(mode: Exclude<MonitoringMode, 'off'>, generation: number): Promise<void> {
    const now = Date.now();
    const sampledAt = new Date(now).toISOString();
    if (mode !== 'full') {
      const cpuPercent = mode === 'cpu' ? this.readCpu().usagePercent : null;
      const memory = mode === 'memory' ? await this.readMemory(totalmem()) : null;
      const networkProbe = mode === 'network' ? await this.readNetwork() : null;
      if (generation !== this.generation) return;
      const network = this.measureNetwork(networkProbe?.value ?? null);
      this.appendPoint({
        at: sampledAt,
        cpuPercent,
        gpuPercent: null,
        memoryPercent: memory?.value?.usagePercent ?? null,
        networkDown: network.receivedBytesPerSecond,
        networkUp: network.sentBytesPerSecond,
      });
      this.onSample?.(null);
      return;
    }

    const totalBytes = totalmem();
    const cpu = this.readCpu();
    this.refreshSlowMetrics();
    void this.refreshProcesses();

    const [memoryProbe, networkProbe, gpuProbe] = await Promise.all([
      this.readMemory(totalBytes, LIVE_PROBE_TIMEOUT_MS),
      this.readNetwork(LIVE_PROBE_TIMEOUT_MS),
      probe('GPU', async () => parseGpuUsage(await run('/usr/sbin/ioreg', ['-r', '-c', 'IOAccelerator', '-d', '1', '-l', '-w', '0'], LIVE_PROBE_TIMEOUT_MS))),
    ]);
    if (generation !== this.generation) return;
    const memory: Memory = memoryProbe.value
      ? { ...memoryProbe.value, swapUsedBytes: this.swap.value }
      : { totalBytes, usedBytes: null, freeBytes: null, wiredBytes: null, compressedBytes: null, cachedBytes: null, usagePercent: null, swapUsedBytes: this.swap.value };
    const network = this.measureNetwork(networkProbe.value);
    this.appendPoint({ at: sampledAt, cpuPercent: cpu.usagePercent, gpuPercent: gpuProbe.value, memoryPercent: memory.usagePercent, networkDown: network.receivedBytesPerSecond, networkUp: network.sentBytesPerSecond });
    this.snapshot = {
      sampledAt,
      cpu,
      gpuPercent: gpuProbe.value,
      memory,
      disk: this.disk.value,
      network,
      battery: this.battery.value,
      processes: this.processReading.value ?? [],
      processesSampledAt: this.processSampledAt,
      history: this.history,
      errors: [memoryProbe.error, this.swap.error, this.processReading.error, networkProbe.error, gpuProbe.error, this.disk.error, this.battery.error].filter((error): error is string => error !== null),
    };
    this.onSample?.(this.snapshot);
  }
}
