import type { AppState, BackupRestoreResult, CleanerApi, MaintenanceResult, SettingsPatch, SnapshotList } from '../shared/types.js';
import { isBackupExpired, type BackupOverview, type BackupPreview, type BackupSession, type BackupTrashResult } from '../shared/backups.js';
import { h, type Child } from './dom.js';
import { formatSize, translateError } from './locale.js';

const dateLabel = (date: string) => new Date(date).toLocaleString('pt-BR', { dateStyle: 'medium', timeStyle: 'short' });
const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('pt-BR')} ${n === 1 ? one : many}`;
function snapshotDate(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(date);
  return match ? dateLabel(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`) : date;
}

export class BackupsView {
  private tab: 'local' | 'snapshots' = 'local';
  private overview: BackupOverview | null = null;
  private loading = false;
  private working = false;
  private query = '';
  private preview: BackupPreview | null = null;
  private previewLoading = false;
  private previewPath: string | null = null;
  private reviewRestore = false;
  private cleanupPaths: string[] | null = null;
  private restoreResult: BackupRestoreResult | null = null;
  private trashResult: BackupTrashResult | null = null;
  private snapshots: SnapshotList | null = null;
  private snapshotsLoading = false;
  private selectedSnapshots = new Set<string>();
  private reviewSnapshots = false;
  private snapshotResult: MaintenanceResult | null = null;
  private error: string | null = null;

  constructor(private readonly api: CleanerApi, private readonly refresh: () => void, private readonly saveSettings: (patch: SettingsPatch) => Promise<void>) {}
  enter(): void {
    if (this.working || this.loading || this.snapshotsLoading) return;
    if (this.tab === 'snapshots') void this.loadSnapshots();
    else void this.load();
  }
  private setError(error: unknown): void {
    const message = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error);
    this.error = translateError(message);
  }
  private async load(): Promise<void> {
    if (this.loading) return;
    this.loading = true; this.error = null; this.cleanupPaths = null; this.preview = null; this.previewPath = null; this.reviewRestore = false; this.refresh();
    try { this.overview = await this.api.getBackupOverview(); }
    catch (error) { this.setError(error); }
    finally { this.loading = false; this.refresh(); }
  }
  private async showPreview(path: string): Promise<void> {
    this.previewLoading = true; this.previewPath = path; this.preview = null; this.reviewRestore = false; this.error = null; this.restoreResult = null; this.refresh();
    try { this.preview = await this.api.previewBackup(path); }
    catch (error) { this.setError(error); }
    finally { this.previewLoading = false; this.refresh(); }
  }
  private async restore(): Promise<void> {
    if (!this.preview) return;
    this.working = true; this.error = null; this.reviewRestore = false; this.refresh();
    try { this.restoreResult = await this.api.restoreBackup(this.preview.path); await this.load(); }
    catch (error) { this.setError(error); }
    finally { this.working = false; this.refresh(); }
  }
  private async trashExpired(): Promise<void> {
    if (!this.overview || !this.cleanupPaths) return;
    const paths = this.cleanupPaths;
    this.working = true; this.cleanupPaths = null; this.error = null; this.refresh();
    try { this.trashResult = await this.api.trashExpiredBackups(this.overview.token, paths); await this.load(); }
    catch (error) { this.setError(error); }
    finally { this.working = false; this.refresh(); }
  }
  private async loadSnapshots(): Promise<void> {
    if (this.snapshotsLoading) return;
    this.snapshotsLoading = true; this.selectedSnapshots.clear(); this.reviewSnapshots = false; this.error = null; this.refresh();
    try { this.snapshots = await this.api.listTimeMachineSnapshots(); }
    catch (error) { this.setError(error); }
    finally { this.snapshotsLoading = false; this.refresh(); }
  }
  private async removeSnapshots(): Promise<void> {
    this.working = true; this.reviewSnapshots = false; this.error = null; this.snapshotResult = null; this.refresh();
    try { this.snapshotResult = await this.api.clearTimeMachineSnapshots([...this.selectedSnapshots]); await this.loadSnapshots(); }
    catch (error) { this.setError(error); }
    finally { this.working = false; this.refresh(); }
  }
  private async settings(patch: SettingsPatch): Promise<void> {
    this.working = true; this.cleanupPaths = null; this.refresh();
    try { await this.saveSettings(patch); }
    catch (error) { this.setError(error); }
    finally { this.working = false; this.refresh(); }
  }

  render(state: AppState): HTMLElement {
    const busy = this.working || this.loading || this.previewLoading || this.snapshotsLoading || state.status.phase !== 'idle' || Boolean(state.activity);
    return h('section', { class: 'backup-center' },
      this.error && h('div', { class: 'banner', role: 'alert' }, this.error),
      h('div', { class: 'backup-tabs', 'aria-label': 'Tipo de backup' },
        ...(['local', 'snapshots'] as const).map((tab) => h('button', {
          class: tab === this.tab ? 'is-active' : '', 'aria-pressed': String(tab === this.tab),
          onclick: () => { this.tab = tab; this.refresh(); if (tab === 'snapshots' && !this.snapshots) void this.loadSnapshots(); },
        }, tab === 'local' ? 'Backups do Disk Mac' : 'Time Machine'))),
      ...(this.tab === 'local' ? this.renderLocal(state, busy) : this.renderSnapshots(busy))
    );
  }

  private renderLocal(state: AppState, busy: boolean): Child[] {
    const sessions = this.overview?.sessions ?? [];
    const expired = sessions.filter((session) => isBackupExpired(session.date, state.settings.backupRetentionDays));
    const eligible = expired.filter((session) => !session.partial);
    const total = sessions.reduce((sum, session) => sum + session.size, 0);
    const filtered = sessions.filter((session) => `${dateLabel(session.date)} ${session.path}`.toLocaleLowerCase('pt-BR').includes(this.query.toLocaleLowerCase('pt-BR')));
    const reviewed = sessions.filter((session) => this.cleanupPaths?.includes(session.path));
    return [
      h('div', { class: 'backup-summary' },
        this.metric('Proteção antes da limpeza', state.settings.backupEnabled ? 'Ativada' : 'Desativada', 'Somente arquivos compatíveis'),
        this.metric('Armazenamento local', this.overview ? `${formatSize(total)}${sessions.some((session) => session.partial) ? '+' : ''}` : '—', this.overview ? count(sessions.length, 'backup') : 'Carregando cópias'),
        this.metric('Prazo de retenção', `${state.settings.backupRetentionDays} dias`, `${expired.length} ${expired.length === 1 ? 'backup vencido' : 'backups vencidos'}`)),
      h('section', { class: 'card backup-settings' },
        h('label', { class: 'backup-setting' }, h('div', { class: 'grow' }, h('strong', {}, 'Guardar arquivos antes de limpar'), h('p', { class: 'small muted' }, 'Ative para proteger itens compatíveis nas próximas limpezas. A cópia continua ocupando espaço no Mac.')),
          h('input', { type: 'checkbox', class: 'toggle', checked: state.settings.backupEnabled, disabled: busy, 'aria-label': 'Guardar arquivos antes de limpar', onchange: (event: Event) => void this.settings({ backupEnabled: (event.target as HTMLInputElement).checked }) })),
        h('label', { class: 'backup-setting' }, h('div', { class: 'grow' }, h('strong', {}, 'Considerar vencido após'), h('p', { class: 'small muted' }, 'A remoção nesta tela é manual e exige revisão.')),
          h('input', { id: 'backup-retention', type: 'number', min: 1, max: 365, value: String(state.settings.backupRetentionDays), disabled: busy, 'aria-label': 'Prazo de retenção em dias', onchange: (event: Event) => void this.settings({ backupRetentionDays: Number((event.target as HTMLInputElement).value) }) }), h('span', { class: 'small muted' }, 'dias'))),
      this.restoreResult && h('div', { class: this.restoreResult.failed ? 'banner' : 'banner success-banner', role: 'status' },
        h('strong', {}, `${count(this.restoreResult.success, 'arquivo restaurado', 'arquivos restaurados')}. ${this.restoreResult.failed ? `${count(this.restoreResult.failed, 'não restaurado')}; confira os detalhes.` : ''}`),
        ...this.restoreResult.errors.slice(0, 10).map((message) => h('p', { class: 'small' }, translateError(message)))),
      this.trashResult && h('div', { class: this.trashResult.errors.length ? 'banner' : 'banner success-banner', role: 'status' },
        h('strong', {}, `${count(this.trashResult.moved.length, 'backup movido', 'backups movidos')} à Lixeira.`),
        h('p', { class: 'small' }, 'O espaço será liberado quando você esvaziar a Lixeira pelo Finder.'),
        ...this.trashResult.errors.map((message) => h('p', { class: 'small' }, message))),
      ...(this.overview?.warnings.map((warning) => h('div', { class: 'banner' }, warning)) ?? []),
      h('div', { class: 'backup-toolbar' }, h('div', { class: 'grow' }, h('h2', {}, 'Suas cópias locais'), h('p', { class: 'muted small' }, 'Mais recentes primeiro. Confira o conteúdo antes de restaurar.')),
        h('button', { class: 'btn', disabled: busy, onclick: () => void this.load() }, this.loading ? 'Atualizando…' : 'Atualizar'),
        h('button', { class: 'btn', disabled: !sessions.length, onclick: () => void this.api.revealPath(this.overview!.rootPath) }, 'Abrir pasta no Finder')),
      sessions.length > 0 && h('input', { id: 'backup-search', type: 'search', class: 'search-input', 'aria-label': 'Buscar backups por data', placeholder: 'Buscar por data ou nome da cópia', value: this.query, oninput: (event: Event) => { this.query = (event.target as HTMLInputElement).value; this.refresh(); } }),
      !this.overview ? h('div', { class: 'empty' }, this.loading ? 'Lendo backups locais…' : 'Não foi possível carregar os backups. Tente atualizar.')
        : !sessions.length ? h('div', { class: 'backup-empty' }, h('span', { class: 'backup-empty-symbol', 'aria-hidden': 'true' }, '↺'), h('h2', {}, 'Pronto para proteger suas próximas limpezas'), h('p', { class: 'muted' }, state.settings.backupEnabled ? 'Quando uma limpeza guardar arquivos compatíveis, as cópias aparecerão aqui para restauração.' : 'Ative a proteção acima. Os backups de arquivos compatíveis aparecerão aqui, com a opção de restaurá-los.'))
          : !filtered.length ? h('div', { class: 'empty' }, 'Nenhum backup corresponde à busca.')
            : h('div', { class: 'backup-list' }, ...filtered.flatMap((session) => [
              this.sessionCard(session, state.settings.backupRetentionDays, busy),
              session.path === this.previewPath && this.previewLoading && h('div', { class: 'card' }, 'Conferindo arquivos e possíveis conflitos…'),
              session.path === this.previewPath && this.preview && this.previewCard(busy),
            ])),
      sessions.length > 0 && h('section', { class: 'card backup-retention' },
        h('div', { class: 'backup-toolbar' }, h('div', { class: 'grow' }, h('strong', {}, 'Revisar cópias vencidas'), h('p', { class: 'muted small' }, `${count(expired.length, 'backup')} acima de ${state.settings.backupRetentionDays} dias · ${formatSize(expired.reduce((sum, session) => sum + session.size, 0))}`)),
          h('button', { class: 'btn', disabled: busy || !eligible.length || Boolean(this.cleanupPaths), onclick: () => { this.cleanupPaths = eligible.slice(0, 100).map((session) => session.path); this.refresh(); } }, 'Revisar vencidos…')),
        this.cleanupPaths && h('div', { class: 'banner tool-confirm' }, h('strong', {}, `Mover ${count(reviewed.length, 'backup')} à Lixeira?`),
          h('p', { class: 'small' }, 'Estas cópias sairão da lista do Disk Mac. Você poderá recuperá-las pela opção “Colocar de Volta” do Finder.'),
          h('ul', { class: 'trash-review-list' }, ...reviewed.map((session) => h('li', {}, `${dateLabel(session.date)} · ${formatSize(session.size)}`))),
          eligible.length > 100 && h('p', { class: 'small' }, 'Este lote contém os primeiros 100 backups vencidos.'),
          h('div', { class: 'buttons' }, h('button', { class: 'btn', disabled: busy, onclick: () => { this.cleanupPaths = null; this.refresh(); } }, 'Cancelar'),
            h('button', { class: 'btn danger', disabled: busy, onclick: () => void this.trashExpired() }, 'Mover backups à Lixeira')))),
      h('p', { class: 'system-footnote' }, 'Os backups do Disk Mac guardam arquivos de limpezas compatíveis. Para proteger todo o Mac e manter cópias em outro disco, use o Time Machine.')
    ];
  }

  private metric(label: string, value: string, detail: string): HTMLElement {
    return h('div', { class: 'system-metric' }, h('span', { class: 'system-label' }, label), h('strong', { class: 'system-value' }, value), h('span', { class: 'system-detail' }, detail));
  }
  private sessionCard(session: BackupSession, days: number, busy: boolean): HTMLElement {
    return h('section', { class: 'card backup-session' },
      h('span', { class: 'backup-session-symbol', 'aria-hidden': 'true' }, '↺'),
      h('div', { class: 'grow' }, h('strong', {}, dateLabel(session.date)), h('p', { class: 'muted small' }, `${count(session.files, 'arquivo')} · ${formatSize(session.size)}${session.partial ? '+ · leitura parcial' : ''}`)),
      h('span', { class: `backup-age${isBackupExpired(session.date, days) ? ' expired' : ''}` }, isBackupExpired(session.date, days) ? 'Vencido' : 'No prazo'),
      h('button', { class: 'btn', disabled: busy, onclick: () => void this.showPreview(session.path) }, 'Ver arquivos'),
      h('button', { class: 'btn link', disabled: busy, 'aria-label': `Mostrar backup de ${dateLabel(session.date)} no Finder`, onclick: () => void this.api.revealPath(session.path) }, 'Finder'));
  }
  private previewCard(busy: boolean): HTMLElement {
    const preview = this.preview!;
    const available = preview.files - preview.conflicts;
    return h('section', { class: 'card backup-preview' },
      h('div', { class: 'backup-toolbar' }, h('div', { class: 'grow' }, h('h2', {}, 'Conteúdo e restauração'), h('p', { class: 'small muted' }, `${count(preview.files, 'arquivo')} · ${formatSize(preview.size)} · locais originais abaixo`)),
        h('button', { class: 'btn link', disabled: busy, onclick: () => { this.preview = null; this.previewPath = null; this.reviewRestore = false; this.refresh(); } }, 'Fechar prévia')),
      preview.conflicts > 0 && h('div', { class: 'banner' }, `${count(preview.conflicts, 'destino já existe ou está indisponível', 'destinos já existem ou estão indisponíveis')}. Esses arquivos serão preservados e suas cópias continuarão no backup.`),
      ...preview.warnings.map((warning) => h('div', { class: 'banner' }, warning)),
      h('div', { class: 'backup-preview-scroll' }, ...preview.items.map((item) => h('div', { class: 'backup-preview-row' },
        h('span', { class: 'grow backup-path', title: item.originalPath }, item.originalPath), h('span', { class: 'small muted' }, formatSize(item.size)), h('span', { class: `backup-file-status${item.conflict ? ' conflict' : ''}` }, item.conflict ? 'Preservar existente' : 'Disponível')))),
      preview.files > preview.items.length && h('p', { class: 'small muted' }, `Exibindo ${preview.items.length} de ${preview.files} caminhos. A restauração considera todos os arquivos disponíveis.`),
      this.reviewRestore ? h('div', { class: 'banner tool-confirm' }, h('strong', {}, `Restaurar até ${count(available, 'arquivo')}?`),
        h('p', { class: 'small' }, 'Os arquivos voltarão aos locais originais. Nenhum arquivo existente será sobrescrito. As cópias restauradas sairão deste backup.'),
        h('div', { class: 'buttons' }, h('button', { class: 'btn', disabled: busy, onclick: () => { this.reviewRestore = false; this.refresh(); } }, 'Cancelar'),
          h('button', { class: 'btn primary', disabled: busy, onclick: () => void this.restore() }, 'Confirmar restauração')))
        : h('div', { class: 'tool-action-bar' }, h('span', { class: 'muted small' }, 'A existência dos destinos será conferida novamente ao restaurar.'),
          h('button', { class: 'btn primary', disabled: busy || preview.partial || available === 0, onclick: () => { this.reviewRestore = true; this.refresh(); } }, 'Restaurar arquivos disponíveis…')));
  }
  private renderSnapshots(busy: boolean): Child[] {
    const dates = this.snapshots?.dates ?? [];
    return [
      h('section', { class: 'card backup-time-machine-intro' }, h('span', { class: 'tool-kicker' }, 'RECUPERAÇÃO DO MACOS'), h('h2', {}, 'Snapshots locais do Time Machine'),
        h('p', { class: 'muted' }, 'São pontos de recuperação criados pelo macOS no disco interno. Aqui você pode consultar e remover os snapshots locais; a restauração é feita pelo Time Machine.'),
        h('p', { class: 'small muted' }, 'Esta lista é independente das cópias do Disk Mac e dos backups armazenados em discos externos.')),
      h('div', { class: 'backup-toolbar' }, h('strong', { class: 'grow' }, this.snapshotsLoading ? 'Consultando snapshots…' : this.snapshots ? count(dates.length, 'snapshot local', 'snapshots locais') : 'Consultar pontos de recuperação'),
        h('button', { class: 'btn', disabled: busy, onclick: () => void this.loadSnapshots() }, 'Atualizar snapshots')),
      this.snapshotResult && h('div', { class: this.snapshotResult.success ? 'banner success-banner' : 'banner', role: 'status' }, h('strong', {}, this.snapshotResult.message), this.snapshotResult.error && h('p', { class: 'small' }, this.snapshotResult.error)),
      this.snapshots?.error && h('div', { class: 'banner' }, translateError(this.snapshots.error)),
      this.snapshots && !this.snapshots.error && !dates.length && !this.snapshotsLoading && h('div', { class: 'empty' }, 'Nenhum snapshot local encontrado neste Mac.'),
      dates.length > 0 && h('section', { class: 'card backup-snapshots' },
        h('div', { class: 'backup-toolbar' }, h('span', { class: 'muted small grow' }, `${count(this.selectedSnapshots.size, 'selecionado')}. A exclusão é permanente.`),
          h('button', { class: 'btn link', disabled: busy || this.reviewSnapshots, onclick: () => { this.selectedSnapshots = this.selectedSnapshots.size ? new Set() : new Set(dates.slice(0, 100)); this.refresh(); } }, this.selectedSnapshots.size ? 'Desmarcar todos' : dates.length > 100 ? 'Selecionar primeiros 100' : 'Selecionar todos')),
        h('div', { class: 'backup-snapshot-list' }, ...[...dates].sort().reverse().map((date) => h('label', { class: 'list-item' },
          h('input', { type: 'checkbox', checked: this.selectedSnapshots.has(date), disabled: busy || this.reviewSnapshots || (this.selectedSnapshots.size >= 100 && !this.selectedSnapshots.has(date)), 'aria-label': `Selecionar snapshot de ${snapshotDate(date)}`, onchange: (event: Event) => { if ((event.target as HTMLInputElement).checked) this.selectedSnapshots.add(date); else this.selectedSnapshots.delete(date); this.refresh(); } }),
          h('span', { class: 'grow' }, snapshotDate(date)), h('span', { class: 'small muted' }, 'Snapshot local')))),
        this.reviewSnapshots ? h('div', { class: 'banner tool-confirm' }, h('strong', {}, `Excluir permanentemente ${count(this.selectedSnapshots.size, 'snapshot')}?`),
          h('p', { class: 'small' }, 'Estes pontos de recuperação serão perdidos. A ação não vai para a Lixeira e o macOS pedirá autorização de administrador.'),
          h('ul', { class: 'trash-review-list' }, ...[...this.selectedSnapshots].map((date) => h('li', {}, snapshotDate(date)))),
          h('div', { class: 'buttons' }, h('button', { class: 'btn', disabled: busy, onclick: () => { this.reviewSnapshots = false; this.refresh(); } }, 'Cancelar'),
            h('button', { class: 'btn danger', disabled: busy, onclick: () => void this.removeSnapshots() }, 'Confirmar exclusão dos snapshots')))
          : h('button', { class: 'btn danger', disabled: busy || !this.selectedSnapshots.size, onclick: () => { this.reviewSnapshots = true; this.refresh(); } }, 'Revisar exclusão…'))
    ];
  }
}
