export interface BackupSession {
  path: string;
  date: string;
  size: number;
  files: number;
  partial: boolean;
}
export interface BackupOverview {
  token: string;
  rootPath: string;
  sessions: BackupSession[];
  warnings: string[];
}
export interface BackupPreviewItem { originalPath: string; size: number; conflict: boolean }
export interface BackupPreview {
  path: string;
  files: number;
  size: number;
  conflicts: number;
  partial: boolean;
  items: BackupPreviewItem[];
  warnings: string[];
}
export interface BackupTrashResult { moved: string[]; errors: string[] }

export function isBackupExpired(date: string, retentionDays: number, now = Date.now()): boolean {
  return now - new Date(date).getTime() > retentionDays * 86_400_000;
}
