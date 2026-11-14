import { randomUUID } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import { physicalFs as fs } from '../../../src/utils/physical-fs.js';
import type { DiskAnalysisProgress, DiskAnalysisReport, DiskEntry } from '../shared/disk-tools.js';

export interface AnalysisOptions { maxEntries?: number; maxFiles?: number; maxDurationMs?: number; onProgress?: (progress: DiskAnalysisProgress) => void }
const allocatedBytes = (stats: Awaited<ReturnType<typeof fs.lstat>>) => Math.max(0, Number.isFinite(stats.blocks) ? Number(stats.blocks) * 512 : Number(stats.size));

/** Metadata-only scan. No file contents, symlink targets, or other mounted volumes are traversed. */
export async function analyzeDisk(input: string, options: AnalysisOptions = {}): Promise<DiskAnalysisReport> {
  if (typeof input !== 'string' || !input.startsWith('/') || input.includes('\0')) throw new Error('Selecione uma pasta válida para analisar.');
  const root = await fs.realpath(resolve(input));
  const rootStats = await fs.lstat(root);
  if (!rootStats.isDirectory()) throw new Error('O local selecionado não é uma pasta.');
  const started = Date.now();
  let lastProgress = 0, measuredBytes = 0, measuredFiles = 0, visited = 0;
  let limited = false;
  const warnings = new Set<string>();
  const seenFiles = new Set<string>();
  const entries: DiskEntry[] = [];
  const largestFiles: DiskEntry[] = [];
  const maxFiles = options.maxFiles ?? 1_000_000;
  const maxDuration = options.maxDurationMs ?? 120_000;
  const warn = (message: string) => { if (warnings.size < 12) warnings.add(message); };
  const exhausted = () => {
    if (visited >= maxFiles || Date.now() - started >= maxDuration) {
      limited = true;
      warn('A análise atingiu o limite de tempo ou de itens. Os tamanhos são parciais; abra uma subpasta para detalhar.');
      return true;
    }
    return false;
  };
  const progress = (currentPath: string, force = false) => {
    if (force || Date.now() - lastProgress >= 350) {
      lastProgress = Date.now();
      options.onProgress?.({ path: root, currentPath, files: measuredFiles, bytes: measuredBytes, elapsedMs: Date.now() - started });
    }
  };

  async function walk(path: string, aggregate: DiskEntry, depth: number): Promise<void> {
    if (exhausted() || depth > 128) {
      if (depth > 128) warn('Há pastas com muitos níveis. Abra uma subpasta para continuar a análise.');
      aggregate.status = 'partial'; return;
    }
    visited++;
    let stats;
    try { stats = await fs.lstat(path); }
    catch {
      aggregate.status = depth === 0 ? 'unavailable' : 'partial';
      warn('Alguns itens não puderam ser lidos ou mudaram durante a análise.');
      return;
    }
    if (depth === 0) Object.assign(aggregate, {
      kind: stats.isSymbolicLink() ? 'symlink' : stats.isDirectory() ? path.endsWith('.app') ? 'application' : 'directory' : 'file',
      device: stats.dev, inode: stats.ino, modifiedAt: stats.mtimeMs, owner: stats.uid,
    });
    if (stats.dev !== rootStats.dev) {
      aggregate.status = depth === 0 ? 'unavailable' : 'partial';
      warn('Volumes montados dentro da pasta foram ignorados. Selecione cada volume separadamente.');
      return;
    }
    if (stats.isDirectory() && !stats.isSymbolicLink()) {
      const bytes = allocatedBytes(stats);
      aggregate.bytes += bytes; measuredBytes += bytes;
      try {
        const directory = await fs.opendir(path);
        for await (const child of directory) {
          if (exhausted()) { aggregate.status = 'partial'; break; }
          await walk(join(path, child.name), aggregate, depth + 1);
        }
      } catch {
        aggregate.status = depth === 0 ? 'unavailable' : 'partial';
        warn('Há pastas sem permissão de leitura. Os totais incluem somente os itens acessíveis.');
      }
    } else if (stats.isFile() || stats.isSymbolicLink()) {
      const identity = `${stats.dev}:${stats.ino}`;
      if (!stats.isSymbolicLink() && seenFiles.has(identity)) return;
      if (!stats.isSymbolicLink()) seenFiles.add(identity);
      const bytes = allocatedBytes(stats);
      aggregate.bytes += bytes; aggregate.files++; measuredBytes += bytes; measuredFiles++;
      if (stats.isFile() && (largestFiles.length < 50 || bytes > largestFiles[largestFiles.length - 1].bytes)) {
        largestFiles.push({ path, name: basename(path), kind: 'file', bytes, files: 1, status: 'complete', device: stats.dev, inode: stats.ino, modifiedAt: stats.mtimeMs, owner: stats.uid });
        largestFiles.sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
        if (largestFiles.length > 50) largestFiles.pop();
      }
    }
    progress(path);
  }

  try {
    const directory = await fs.opendir(root);
    for await (const entry of directory) {
      if (entries.length >= (options.maxEntries ?? 5000) || exhausted()) {
        limited = true;
        warn('A lista de itens desta pasta foi limitada. Refine a análise escolhendo uma subpasta.');
        break;
      }
      entries.push({ path: join(root, entry.name), name: entry.name, kind: entry.isDirectory() ? 'directory' : 'file', bytes: 0, files: 0, status: 'complete', device: 0, inode: 0, modifiedAt: 0, owner: -1 });
    }
  } catch {
    return { id: randomUUID(), path: root, scannedAt: new Date().toISOString(), bytes: 0, files: 0, elapsedMs: Date.now() - started, status: 'unavailable', entries: [], largestFiles: [], warnings: ['O macOS não permitiu ler esta pasta. Verifique o Acesso Total ao Disco ou escolha outro local.'] };
  }
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(8, entries.length) }, async () => {
    while (cursor < entries.length) {
      const entry = entries[cursor++];
      await walk(entry.path, entry, 0);
    }
  }));
  progress(root, true);
  entries.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
  return {
    id: randomUUID(), path: root, scannedAt: new Date().toISOString(), bytes: measuredBytes, files: measuredFiles,
    elapsedMs: Date.now() - started, status: limited || entries.some((entry) => entry.status !== 'complete') ? 'partial' : 'complete',
    entries, largestFiles, warnings: [...warnings],
  };
}
