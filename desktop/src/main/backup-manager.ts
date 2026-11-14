import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { physicalFs as fs } from '../../../src/utils/physical-fs.js';
import { getBackupDir } from '../../../src/utils/backup.js';
import { isBackupExpired, type BackupOverview, type BackupPreview, type BackupSession, type BackupTrashResult } from '../shared/backups.js';

type Identity = { dev: number; ino: number; mtimeMs: number };
type ListedSession = BackupSession & Identity & { fingerprint: string };
type MeasuredBackup = BackupPreview & { fingerprint: string };
const inside = (root: string, path: string) => path.startsWith(root + '/');

/** Desktop backup inventory, previews and reviewed Trash requests. No permanent deletion. */
export class BackupManager {
  private inventory: { token: string; createdAt: number; sessions: ListedSession[] } | null = null;
  constructor(private readonly root = getBackupDir(), private readonly home = homedir()) {}

  async assertSession(input: unknown): Promise<string> {
    if (typeof input !== 'string' || input.includes('\0') || dirname(resolve(input)) !== resolve(this.root)) throw new Error('Selecione um backup da lista atual.');
    const path = resolve(input);
    const [root, session] = await Promise.all([fs.lstat(this.root), fs.lstat(path)]);
    if (!root.isDirectory() || !session.isDirectory() || root.isSymbolicLink() || session.isSymbolicLink()) throw new Error('O backup não é uma pasta válida. Atualize a lista.');
    const canonical = await fs.realpath(path);
    if (canonical !== join(await fs.realpath(this.root), basename(path))) throw new Error('O local do backup mudou. Atualize a lista.');
    return path;
  }

  private async measure(path: string, includeItems: boolean): Promise<MeasuredBackup> {
    const preview: MeasuredBackup = { path, files: 0, size: 0, conflicts: 0, partial: false, items: [], warnings: [], fingerprint: '' };
    const identities: string[] = [];
    const started = Date.now();
    let visited = 0;
    const warn = (message: string) => { preview.partial = true; if (!preview.warnings.includes(message)) preview.warnings.push(message); };
    const canonicalHome = includeItems ? await fs.realpath(this.home) : '';
    async function targetConflict(target: string): Promise<boolean> {
      try { await fs.lstat(target); return true; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return true;
      }
      let parent = dirname(target);
      for (;;) {
        try {
          const real = await fs.realpath(parent);
          return real !== canonicalHome && !inside(canonicalHome, real);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === dirname(parent)) return true;
          parent = dirname(parent);
        }
      }
    }
    const walk = async (directory: string, depth: number): Promise<void> => {
      if (depth > 128 || visited >= 100_000 || Date.now() - started > 15_000) { warn('A leitura foi limitada. Confira o conteúdo no Finder antes de continuar.'); return; }
      try {
        const entries = await fs.opendir(directory);
        for await (const entry of entries) {
          if (++visited > 100_000 || Date.now() - started > 15_000) { warn('A leitura foi limitada. Confira o conteúdo no Finder antes de continuar.'); break; }
          const itemPath = join(directory, entry.name);
          try {
            const stats = await fs.lstat(itemPath);
            identities.push(`${relative(path, itemPath)}\0${stats.dev}:${stats.ino}:${stats.mtimeMs}:${stats.size}:${stats.mode}`);
            if (stats.isDirectory() && !stats.isSymbolicLink()) await walk(itemPath, depth + 1);
            else if (stats.isFile() || stats.isSymbolicLink()) {
              preview.files++; preview.size += stats.size;
              if (includeItems) {
                const rel = relative(path, itemPath);
                if (!rel.startsWith('HOME/')) { warn('Há itens fora da estrutura de restauração do Disk Mac.'); continue; }
                const originalPath = join(this.home, rel.slice(5));
                const conflict = await targetConflict(originalPath);
                if (conflict) preview.conflicts++;
                if (preview.items.length < 200) preview.items.push({ originalPath, size: stats.size, conflict });
              }
            }
          } catch { warn('Alguns arquivos não puderam ser lidos. A medição está incompleta.'); }
        }
      } catch { warn('Algumas pastas não puderam ser lidas. Verifique as permissões do backup.'); }
    };
    await walk(path, 0);
    preview.fingerprint = createHash('sha256').update(identities.sort().join('\n')).digest('hex');
    return preview;
  }

  async overview(): Promise<BackupOverview> {
    const sessions: ListedSession[] = [];
    const warnings: string[] = [];
    const token = randomUUID();
    const started = Date.now();
    this.inventory = null;
    try {
      const stats = await fs.lstat(this.root);
      if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('A pasta de backups não é um diretório válido.');
      const entries = await fs.readdir(this.root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        if (Date.now() - started > 30_000) { warnings.push('A leitura atingiu o limite de tempo. Exibindo os backups já medidos.'); break; }
        if (sessions.length >= 500) { warnings.push('Exibindo os primeiros 500 backups. Confira os demais no Finder.'); break; }
        try {
          const path = await this.assertSession(join(this.root, entry.name));
          const stats = await fs.lstat(path);
          const measured = await this.measure(path, false);
          sessions.push({ path, date: stats.mtime.toISOString(), size: measured.size, files: measured.files, partial: measured.partial, dev: stats.dev, ino: stats.ino, mtimeMs: stats.mtimeMs, fingerprint: measured.fingerprint });
        } catch { warnings.push(`Não foi possível ler o backup ${entry.name}.`); }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    sessions.sort((a, b) => b.date.localeCompare(a.date));
    this.inventory = { token, createdAt: Date.now(), sessions };
    return { token, rootPath: this.root, sessions: sessions.map(({ dev: _dev, ino: _ino, mtimeMs: _mtimeMs, fingerprint: _fingerprint, ...session }) => session), warnings };
  }

  async preview(path: unknown): Promise<BackupPreview> {
    return this.measure(await this.assertSession(path), true);
  }

  async trashExpired(token: unknown, input: unknown, retentionDays: number, trashItem: (path: string) => Promise<void>): Promise<BackupTrashResult> {
    const inventory = this.inventory;
    if (!inventory || token !== inventory.token || Date.now() - inventory.createdAt > 15 * 60_000) throw new Error('A lista expirou. Atualize os backups antes de continuar.');
    if (!Array.isArray(input) || input.length === 0 || input.length > 100 || !input.every((path) => typeof path === 'string')) throw new Error('Selecione de 1 a 100 backups vencidos.');
    const paths = [...new Set(input as string[])];
    const known = new Map(inventory.sessions.map((session) => [session.path, session]));
    if (paths.some((path) => !known.has(path) || known.get(path)!.partial || !isBackupExpired(known.get(path)!.date, retentionDays))) throw new Error('A seleção contém um backup recente ou incompleto. Atualize a lista.');
    const result: BackupTrashResult = { moved: [], errors: [] };
    for (const path of paths) {
      try {
        await this.assertSession(path);
        const stats = await fs.lstat(path);
        const listed = known.get(path)!;
        if (listed.dev !== stats.dev || listed.ino !== stats.ino || listed.mtimeMs !== stats.mtimeMs) throw new Error('O backup mudou desde a revisão. Atualize a lista.');
        const current = await this.measure(path, false);
        if (current.partial || current.fingerprint !== listed.fingerprint) throw new Error('Os arquivos do backup mudaram desde a revisão. Atualize a lista.');
        await trashItem(path);
        result.moved.push(path);
      } catch (error) { result.errors.push(`${basename(path)}: ${error instanceof Error ? error.message : 'Não foi possível mover à Lixeira.'}`); }
    }
    if (result.moved.length) this.inventory = null;
    return result;
  }
}
