import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { SystemProcess } from '../shared/system-monitor.js';

export interface ProcessRecord extends Omit<SystemProcess, 'terminationBlockedReason' | 'cpuPercent'> {
  cpuTimeMs: number | null;
  parentPid: number;
  uid: number;
  startedAt: string;
  command: string;
  state: string;
}
export interface ProcessPolicy { selfPid: number; currentUid: number }
export const localProcessPolicy = (): ProcessPolicy => ({ selfPid: process.pid, currentUid: process.getuid?.() ?? -1 });
const CRITICAL = new Set(['kernel_task', 'launchd', 'loginwindow', 'windowserver', 'watchdogd', 'securityd', 'authd']);

export function parseProcessRecords(text: string): ProcessRecord[] {
  const rows = text.split('\n').flatMap((line): ProcessRecord[] => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)\s+(.+?)\s*$/);
    if (!match) return [];
    const pid = Number(match[1]), parentPid = Number(match[2]), uid = Number(match[3]);
    const time = match[5].match(/^(\d+):([0-5]\d)\.(\d{2})$/);
    const elapsed = time ? Number(time[1]) * 60_000 + Number(time[2]) * 1000 + Number(time[3]) * 10 : NaN;
    const cpuTimeMs = Number.isSafeInteger(elapsed) ? elapsed : null;
    const memoryBytes = Number(match[6]) * 1024;
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(parentPid) || !Number.isSafeInteger(uid) || !Number.isFinite(memoryBytes)) return [];
    const startedAt = match[7].replace(/\s+/g, ' '), command = match[9];
    const identity = createHash('sha256').update(JSON.stringify([pid, uid, startedAt, command])).digest('hex');
    return [{ pid, parentPid, uid, user: match[4], cpuTimeMs, memoryBytes, startedAt, command, state: match[8], identity, name: basename(command) }];
  });
  if (!rows.length) throw new Error('Não foi possível identificar os processos nesta leitura.');
  return rows;
}

/** Read executable paths, not command arguments, to avoid collecting secrets in argv. */
export function readProcessRecords(): Promise<ProcessRecord[]> {
  return new Promise((resolve, reject) => {
    execFile('/bin/ps', ['-axww', '-o', 'pid=,ppid=,uid=,user=,time=,rss=,lstart=,state=,comm='], {
      encoding: 'utf8', timeout: 1800, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    }, (error, stdout) => {
      if (error) { reject(error); return; }
      try { resolve(parseProcessRecords(stdout)); } catch (error) { reject(error); }
    });
  });
}

export function processGuard(records: ProcessRecord[], policy = localProcessPolicy()): (record: ProcessRecord) => string | null {
  const byPid = new Map(records.map((record) => [record.pid, record]));
  const self = byPid.get(policy.selfPid);
  const bundleEnd = self?.command.indexOf('.app/Contents/') ?? -1;
  const bundle = bundleEnd >= 0 ? self!.command.slice(0, bundleEnd + 4) : null;
  const ancestors = new Set<number>([policy.selfPid]);
  let ancestor = self?.parentPid;
  while (ancestor && !ancestors.has(ancestor)) { ancestors.add(ancestor); ancestor = byPid.get(ancestor)?.parentPid; }
  return (record) => {
    if (record.pid <= 1 || CRITICAL.has(record.name.toLowerCase())) return 'Este componente é essencial para a sessão do macOS.';
    if (ancestors.has(record.pid) || (bundle && record.command.startsWith(bundle + '/'))) return 'Este processo mantém o Disk Mac em execução.';
    const seen = new Set<number>();
    let parent = record.parentPid;
    while (parent && !seen.has(parent)) {
      if (parent === policy.selfPid) return 'Este processo faz parte do Disk Mac ou de uma tarefa em andamento.';
      seen.add(parent); parent = byPid.get(parent)?.parentPid ?? 0;
    }
    if (record.uid === 0 || record.uid !== policy.currentUid || policy.currentUid < 0) return 'O Disk Mac só finaliza processos do seu usuário. Este processo pertence ao sistema ou a outra sessão.';
    if (record.state.startsWith('Z') || record.state.startsWith('X')) return 'Este processo já está encerrado e aguarda remoção da lista pelo macOS.';
    return null;
  };
}

export function visibleProcess(record: ProcessRecord, blockedReason: string | null, cpuPercent: number | null = null): SystemProcess {
  return { pid: record.pid, identity: record.identity, name: record.name, user: record.user, cpuPercent, memoryBytes: record.memoryBytes, ...(blockedReason ? { terminationBlockedReason: blockedReason } : {}) };
}

export interface ProcessSample {
  at: number;
  cpuTimes: ReadonlyMap<string, number | null>;
}

export function processSnapshot(records: ProcessRecord[], policy = localProcessPolicy(), interval?: { previous: ProcessSample; at: number }): SystemProcess[] {
  const guard = processGuard(records, policy);
  const elapsed = interval ? interval.at - interval.previous.at : 0;
  return records.map((record) => {
    const previous = interval?.previous.cpuTimes.get(record.identity);
    const current = record.cpuTimeMs;
    const usage = elapsed > 0 && previous != null && current != null && current >= previous
      ? (current - previous) / elapsed * 100 : null;
    return visibleProcess(record, guard(record), usage);
  });
}
