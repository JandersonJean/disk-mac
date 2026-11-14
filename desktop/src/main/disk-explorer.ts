import { Worker } from 'node:worker_threads';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { physicalFs as fs } from '../../../src/utils/physical-fs.js';
import { validatePathSafety } from '../../../src/utils/fs.js';
import type { DiskAnalysisProgress, DiskAnalysisReport, DiskEntry, DiskLocation, DiskTrashResult } from '../shared/disk-tools.js';

const isInside = (parent: string, path: string) => { const rel = relative(parent, path); return rel !== '' && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('/'); };

export async function diskLocations(): Promise<DiskLocation[]> {
  const home = homedir();
  const choices = [{ name: 'Pasta pessoal', path: home }, { name: 'Downloads', path: join(home, 'Downloads') }, { name: 'Documentos', path: join(home, 'Documents') }, { name: 'Aplicativos', path: '/Applications' }, { name: 'Biblioteca do usuário', path: join(home, 'Library') }];
  const found = await Promise.all(choices.map(async (choice) => (await fs.stat(choice.path).catch(() => null))?.isDirectory() ? choice : null));
  return found.filter((choice): choice is DiskLocation => choice !== null);
}

export function trashRestriction(entry: DiskEntry, root: string, protectedPaths: string[] = []): string | null {
  const path = resolve(entry.path);
  if (!isInside(root, path)) return 'O item não pertence à pasta analisada.';
  const systemError = validatePathSafety(path);
  if (systemError) return 'Este local é protegido pelo sistema.';
  if (path.startsWith('/Library/') || path === '/Library') return 'Itens da Biblioteca do sistema não podem ser removidos pelo analisador.';
  if (/\.app(?:\/|$)/i.test(path)) return 'Use “Desinstalar apps” para remover aplicativos completos.';
  const home = homedir();
  if ([join(home, '.Trash'), ...protectedPaths].some((protectedPath) => path === resolve(protectedPath) || isInside(resolve(protectedPath), path))) return 'Este item pertence à Lixeira ou aos dados do Disk Mac.';
  const protectedRoots = ['/', '/Users', '/Applications', '/Volumes', '/private', '/private/var', '/tmp', '/private/tmp', home,
    ...['Desktop', 'Documents', 'Downloads', 'Library', 'Applications', 'Pictures', 'Music', 'Movies', '.Trash'].map((name) => join(home, name)), ...protectedPaths];
  if (protectedRoots.some((protectedPath) => path === resolve(protectedPath) || isInside(path, resolve(protectedPath)))) return 'Esta pasta é necessária ao macOS ou ao Disk Mac.';
  if (entry.owner !== process.getuid?.()) return 'Este item não pertence ao seu usuário.';
  if (entry.status !== 'complete') return 'Conclua a análise deste item antes de movê-lo à Lixeira.';
  return null;
}

export async function trashAnalyzedItems(report: DiskAnalysisReport, input: unknown, trashItem: (path: string) => Promise<void>, protectedPaths: string[] = []): Promise<DiskTrashResult> {
  if (!Array.isArray(input) || !input.length || input.length > 100 || !input.every((path) => typeof path === 'string')) throw new Error('Selecione de 1 a 100 itens da análise atual.');
  const scannedAt = new Date(report.scannedAt).getTime();
  if (!Number.isFinite(scannedAt) || Date.now() - scannedAt > 15 * 60_000) throw new Error('A análise expirou. Atualize os tamanhos antes de mover itens à Lixeira.');
  const known = new Map([...report.entries, ...report.largestFiles].map((entry) => [entry.path, entry]));
  const paths = [...new Set(input as string[])];
  if (paths.some((path) => !known.has(path))) throw new Error('Um item não pertence à análise atual. Atualize a pasta.');
  // A selected parent already includes its selected descendants.
  const selected = paths.filter((path) => !paths.some((parent) => isInside(parent, path)));
  const result: DiskTrashResult = { moved: [], errors: [] };
  for (const path of selected) {
    const entry = known.get(path)!;
    try {
      const restriction = trashRestriction(entry, report.path, protectedPaths);
      if (restriction) throw new Error(restriction);
      const parent = await fs.realpath(dirname(path));
      if (parent !== report.path && !isInside(report.path, parent)) throw new Error('A pasta do item mudou desde a análise.');
      const actual = await fs.lstat(path);
      if (actual.dev !== entry.device || actual.ino !== entry.inode || actual.mtimeMs !== entry.modifiedAt) throw new Error('O item mudou desde a análise. Atualize antes de removê-lo.');
      await trashItem(path);
      result.moved.push(path);
    } catch (error) {
      result.errors.push(`${basename(path)}: ${error instanceof Error ? error.message : 'Não foi possível mover à Lixeira.'}`);
    }
  }
  return result;
}

export class DiskExplorer {
  private cancelActive: (() => void) | null = null;
  report: DiskAnalysisReport | null = null;
  constructor(private readonly workerPath: string) {}
  cancel(): void { this.cancelActive?.(); }
  scan(path: string, onProgress: (progress: DiskAnalysisProgress) => void): Promise<DiskAnalysisReport | null> {
    if (this.cancelActive) throw new Error('Já existe uma análise de disco em andamento.');
    if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\0')) throw new Error('Selecione uma pasta válida.');
    this.report = null;
    return new Promise((resolveReport, reject) => {
      const worker = new Worker(this.workerPath, { workerData: { path } });
      let done = false;
      const finish = (report: DiskAnalysisReport | null, error?: Error) => {
        if (done) return;
        done = true; clearTimeout(deadline); this.cancelActive = null;
        void worker.terminate();
        if (error) reject(error);
        else { this.report = report; resolveReport(report); }
      };
      const deadline = setTimeout(() => finish(null, new Error('A pasta demorou demais para responder. Tente analisar uma subpasta ou reconecte o volume.')), 150_000);
      this.cancelActive = () => finish(null);
      worker.on('message', (message) => {
        if (done) return;
        if (message.type === 'progress') onProgress(message.progress);
        else if (message.type === 'result') finish(message.report);
        else if (message.type === 'error') finish(null, new Error(message.message));
      });
      worker.on('error', (error) => finish(null, error instanceof Error ? error : new Error(String(error))));
      worker.on('exit', (code) => { if (!done) finish(null, new Error(`A análise foi interrompida (código ${code}).`)); });
    });
  }
}
