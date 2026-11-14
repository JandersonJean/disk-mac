export type OptimizationId = 'quicklook' | 'icons' | 'dns' | 'applications' | 'spotlight' | 'periodic' | 'disk-check' | 'file-cache';
export interface OptimizationTask {
  id: OptimizationId;
  title: string;
  description: string;
  impact: string;
  administrator: boolean;
  recommended: boolean;
  available: boolean;
}
export interface OptimizationOutcome {
  id: OptimizationId;
  title: string;
  status: 'applied' | 'skipped' | 'failed' | 'cancelled';
  message: string;
  durationMs: number;
}
export interface OptimizationReport { finishedAt: string; results: OptimizationOutcome[] }

export type AnalysisStatus = 'complete' | 'partial' | 'unavailable';
export interface DiskEntry {
  path: string;
  name: string;
  kind: 'directory' | 'file' | 'symlink' | 'application';
  bytes: number;
  files: number;
  status: AnalysisStatus;
  device: number;
  inode: number;
  modifiedAt: number;
  owner: number;
  trashReason?: string;
}
export interface DiskAnalysisProgress { path: string; currentPath: string; files: number; bytes: number; elapsedMs: number }
export interface DiskAnalysisReport {
  id: string;
  path: string;
  scannedAt: string;
  bytes: number;
  files: number;
  elapsedMs: number;
  status: AnalysisStatus;
  entries: DiskEntry[];
  largestFiles: DiskEntry[];
  warnings: string[];
}
export interface DiskLocation { name: string; path: string }
export interface DiskTrashResult { moved: string[]; errors: string[] }
