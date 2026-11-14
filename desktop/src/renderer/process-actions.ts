import type { CleanerApi } from '../shared/types.js';
import type { ProcessTerminationMode, ProcessTerminationReview, ProcessTerminationResult, SystemProcess, SystemSnapshot } from '../shared/system-monitor.js';
import { h } from './dom.js';
import { formatSize } from './locale.js';

export class ProcessActions {
  private selected: SystemProcess | null = null;
  private review: ProcessTerminationReview | null = null;
  private preparing = false;
  private submitting = false;
  private forceReview = false;
  private generation = 0;
  private error: string | null = null;
  private result: ProcessTerminationResult | null = null;
  constructor(private readonly api: CleanerApi, private readonly refresh: () => void) {}
  get selectedIdentity(): string | undefined { return this.selected?.identity; }
  get locked(): boolean { return this.preparing || this.submitting || Boolean(this.review); }
  select(process: SystemProcess): void {
    if (this.locked) return;
    this.selected = process; this.error = null; this.result = null; this.refresh();
  }
  leave(): void { this.cancel(); }
  private cancel(): void {
    this.generation++;
    if (this.review) void this.api.cancelProcessTermination(this.review.token).catch(() => undefined);
    this.review = null; this.preparing = false; this.forceReview = false; this.refresh();
  }
  private setError(error: unknown): void {
    this.error = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error);
  }
  private async prepare(): Promise<void> {
    if (!this.selected || this.locked) return;
    const generation = ++this.generation;
    this.preparing = true; this.error = null; this.result = null; this.refresh();
    try {
      const review = await this.api.reviewProcessTermination({ pid: this.selected.pid, identity: this.selected.identity });
      if (generation !== this.generation) { void this.api.cancelProcessTermination(review.token).catch(() => undefined); return; }
      this.review = review;
    } catch (error) { if (generation === this.generation) this.setError(error); }
    finally {
      if (generation === this.generation) {
        this.preparing = false; this.refresh();
        document.getElementById('process-confirm-cancel')?.focus({ preventScroll: true });
      }
    }
  }
  private async terminate(mode: ProcessTerminationMode): Promise<void> {
    if (!this.review || this.submitting) return;
    const token = this.review.token;
    this.submitting = true; this.error = null; this.result = null; this.refresh();
    try { this.result = await this.api.terminateSystemProcess(token, mode); }
    catch (error) { this.setError(error); }
    finally { this.submitting = false; this.review = null; this.forceReview = false; this.refresh(); }
  }
  render(snapshot: SystemSnapshot | null): HTMLElement {
    const latest = snapshot?.processes.find((process) => process.identity === this.selected?.identity);
    const unavailable = !snapshot || snapshot.errors.some((error) => /^Processos:/.test(error));
    const selected = latest ?? this.selected;
    const blocked = latest?.terminationBlockedReason;
    const target = this.review?.process;
    const noLongerRunning = Boolean(this.selected && !latest && !unavailable);
    return h('div', { class: 'system-process-actions' },
      h('div', { class: 'process-selection-bar' },
        h('div', { class: 'grow' },
          h('strong', {}, selected ? selected.name : 'Selecione um processo'),
          h('div', { class: 'small muted' }, selected
            ? `PID ${selected.pid} · ${selected.user}${latest ? ` · ${latest.cpuPercent == null ? '—' : latest.cpuPercent.toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '%'} CPU · ${formatSize(latest.memoryBytes)}` : ''}`
            : 'Clique em uma linha para consultar e finalizar o processo.')),
        h('button', { id: 'process-review-open', class: 'btn danger', disabled: this.locked || !latest || Boolean(blocked) || unavailable, onclick: () => void this.prepare() }, this.preparing ? 'Conferindo processo…' : this.submitting ? 'Finalizando…' : 'Finalizar processo…')),
      blocked && h('div', { class: 'small muted process-restriction' }, blocked),
      noLongerRunning && !this.result && h('div', { class: 'small muted' }, 'Este processo já não aparece na lista. Selecione outro processo para continuar.'),
      this.error && h('div', { class: 'banner', role: 'alert' }, this.error),
      this.result && h('div', { class: ['exited', 'already-exited'].includes(this.result.status) ? 'banner success-banner' : 'banner', role: 'status' },
        h('strong', {}, `${this.result.name} · PID ${this.result.pid}`), h('p', { class: 'small' }, this.result.message)),
      target && h('section', { class: 'banner process-confirm', 'aria-label': 'Confirmar encerramento do processo' },
        h('strong', {}, this.forceReview ? `Forçar encerramento de ${target.name}?` : `Finalizar ${target.name}?`),
        h('div', { class: 'process-confirm-identity small' }, `PID ${target.pid} · usuário ${target.user}`),
        h('p', { class: 'small' }, this.forceReview
          ? 'O processo será interrompido imediatamente, sem oportunidade de salvar ou concluir tarefas. Dados não salvos podem ser perdidos.'
          : 'O processo receberá uma solicitação para terminar. Dados não salvos podem ser perdidos. Use o encerramento forçado apenas se ele não responder.'),
        h('div', { class: 'process-confirm-buttons' },
          h('button', { id: 'process-confirm-cancel', class: 'btn', disabled: this.submitting, onclick: () => this.cancel() }, 'Cancelar'),
          !this.forceReview && h('button', { id: 'process-confirm-force', class: 'btn', disabled: this.submitting, onclick: () => { this.forceReview = true; this.refresh(); document.getElementById('process-confirm-cancel')?.focus({ preventScroll: true }); } }, 'Forçar encerramento…'),
          h('button', { id: 'process-confirm-send', class: 'btn danger', disabled: this.submitting, onclick: () => void this.terminate(this.forceReview ? 'force' : 'terminate') }, this.submitting ? 'Aguardando resultado…' : this.forceReview ? 'Forçar encerramento agora' : 'Finalizar')))
    );
  }
}
