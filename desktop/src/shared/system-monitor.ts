export const MENU_BAR_VALUE_OPTIONS = {
  none: 'Oculto',
  cpu: 'CPU',
  memory: 'Memória',
  'network-down': 'Rede · Download',
  'network-up': 'Rede · Upload',
} as const;
export type MenuBarValue = keyof typeof MENU_BAR_VALUE_OPTIONS;
export type SystemMetric = 'cpu' | 'memory' | 'network';
export const LIVE_METRIC_INTERVAL_MS = 500;
export const PROCESS_INTERVAL_MS = 2000;
export const METRIC_HISTORY_MS = 120_000;

export interface SystemProcess {
  pid: number;
  /** Stable across samples, changes when a PID is reused or its executable changes. */
  identity: string;
  user: string;
  name: string;
  /** CPU time used between two samples, relative to one core. */
  cpuPercent: number | null;
  memoryBytes: number;
  terminationBlockedReason?: string;
}

export type ProcessTerminationMode = 'terminate' | 'force';
export interface ProcessTerminationTarget { pid: number; identity: string }
export interface ProcessTerminationReview {
  token: string;
  expiresAt: string;
  process: SystemProcess;
}
export interface ProcessTerminationResult {
  pid: number;
  name: string;
  status: 'exited' | 'already-exited' | 'running' | 'unconfirmed';
  message: string;
}

export interface MetricPoint {
  at: string;
  cpuPercent: number | null;
  gpuPercent: number | null;
  memoryPercent: number | null;
  networkDown: number | null;
  networkUp: number | null;
}

export interface SystemSnapshot {
  sampledAt: string;
  cpu: { usagePercent: number | null; logicalCores: number; loadAverage: number[] };
  gpuPercent: number | null;
  memory: {
    totalBytes: number;
    /** Estimate from anonymous, wired and physical compressor pages (excluding purgeable pages). */
    usedBytes: number | null;
    freeBytes: number | null;
    wiredBytes: number | null;
    compressedBytes: number | null;
    cachedBytes: number | null;
    swapUsedBytes: number | null;
    usagePercent: number | null;
  };
  disk: { totalBytes: number; freeBytes: number; usedBytes: number } | null;
  network: {
    receivedBytesPerSecond: number | null;
    sentBytesPerSecond: number | null;
    /** Physical en* interfaces only, so loopback/VPN/bridge traffic is not counted twice. */
    interfaces: string[];
  };
  battery: { percent: number; charging: boolean; powerSource: string } | null;
  processes: SystemProcess[];
  processesSampledAt: string | null;
  history: MetricPoint[];
  errors: string[];
}
