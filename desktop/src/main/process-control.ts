import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { ProcessTerminationReview, ProcessTerminationResult, ProcessTerminationTarget } from '../shared/system-monitor.js';
import { localProcessPolicy, processGuard, readProcessRecords, visibleProcess, type ProcessPolicy, type ProcessRecord } from './process-inventory.js';

export interface ProcessControlDependencies {
  read(): Promise<ProcessRecord[]>;
  signal(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void;
  policy(): ProcessPolicy;
  now(): number;
  wait(ms: number): Promise<unknown>;
}
const defaults: ProcessControlDependencies = {
  read: readProcessRecords, signal: (pid, signal) => { process.kill(pid, signal); },
  policy: localProcessPolicy, now: Date.now, wait: delay,
};
const exited = (record: ProcessRecord) => /^[ZX]/.test(record.state);
function targetFrom(input: unknown): ProcessTerminationTarget {
  const value = input as Partial<ProcessTerminationTarget> | null;
  if (!value || typeof value !== 'object' || !Number.isSafeInteger(value.pid) || value.pid! <= 1 || value.pid! > 2_147_483_647 || typeof value.identity !== 'string' || !/^[a-f0-9]{64}$/.test(value.identity)) throw new Error('Selecione um processo válido na lista do monitor.');
  return value as ProcessTerminationTarget;
}

/** Each confirmation is short-lived and bound to a process identity, never just a PID. */
export class ProcessController {
  private pending: ProcessTerminationReview | null = null;
  private running = false;
  constructor(private readonly deps = defaults) {}
  cancel(token?: unknown): void { if (token === undefined || this.pending?.token === token) this.pending = null; }
  async review(input: unknown): Promise<ProcessTerminationReview> {
    if (this.running) throw new Error('Aguarde o resultado do encerramento em andamento.');
    const target = targetFrom(input);
    const records = await this.deps.read();
    const record = records.find((record) => record.pid === target.pid);
    if (!record || record.identity !== target.identity || exited(record)) throw new Error('O processo saiu ou mudou desde a seleção. Atualize a seleção na lista.');
    const blocked = processGuard(records, this.deps.policy())(record);
    if (blocked) throw new Error(blocked);
    this.pending = { token: randomUUID(), expiresAt: new Date(this.deps.now() + 60_000).toISOString(), process: visibleProcess(record, null) };
    return this.pending;
  }

  async terminate(token: unknown, mode: unknown): Promise<ProcessTerminationResult> {
    if (this.running) throw new Error('Aguarde o resultado do encerramento em andamento.');
    if (mode !== 'terminate' && mode !== 'force') throw new Error('Escolha Finalizar ou Forçar encerramento.');
    const review = this.pending;
    if (!review || typeof token !== 'string' || token !== review.token || this.deps.now() >= new Date(review.expiresAt).getTime()) throw new Error('A confirmação expirou. Revise o processo novamente.');
    this.pending = null;
    this.running = true;
    const target = review.process;
    const result = (status: ProcessTerminationResult['status'], message: string): ProcessTerminationResult => ({ pid: target.pid, name: target.name, status, message });
    try {
      const records = await this.deps.read();
      const current = records.find((record) => record.pid === target.pid);
      if (!current || exited(current)) return result('already-exited', 'Este processo já foi encerrado. Nenhum sinal foi enviado.');
      if (current.identity !== target.identity) throw new Error('O PID agora pertence a outro processo. Selecione o processo desejado novamente.');
      const blocked = processGuard(records, this.deps.policy())(current);
      if (blocked) throw new Error(blocked);
      try { this.deps.signal(current.pid, mode === 'force' ? 'SIGKILL' : 'SIGTERM'); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ESRCH') return result('already-exited', 'O processo terminou antes do envio da solicitação.');
        if (code === 'EPERM' || code === 'EACCES') throw new Error('O macOS não permitiu finalizar este processo.', { cause: error });
        throw new Error('Não foi possível enviar a solicitação de encerramento.', { cause: error });
      }
      // A successful signal is not proof that a process has stopped.
      for (const wait of [150, 350, 700]) {
        await this.deps.wait(wait);
        let records: ProcessRecord[];
        try { records = await this.deps.read(); }
        catch { return result('unconfirmed', 'A solicitação foi enviada, mas não foi possível confirmar a saída. Confira a próxima atualização do monitor.'); }
        const remaining = records.find((record) => record.pid === target.pid);
        if (!remaining || remaining.identity !== target.identity || exited(remaining)) return result('exited', mode === 'force' ? 'Encerramento forçado confirmado.' : 'Encerramento confirmado.');
      }
      return result('running', mode === 'force'
        ? 'O sinal de encerramento forçado foi enviado, mas o processo ainda aparece na lista. Aguarde a próxima atualização.'
        : 'A solicitação foi enviada, mas o processo continua ativo. Se necessário, revise novamente e use Forçar encerramento.');
    } finally { this.running = false; }
  }
}
