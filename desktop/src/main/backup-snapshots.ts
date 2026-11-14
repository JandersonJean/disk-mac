import { listTimeMachineSnapshotDates } from '../../../src/maintenance/timemachine.js';
import type { MaintenanceResult, SnapshotList } from '../shared/types.js';
import { runAdministratorCommands } from './optimizer.js';

export interface SnapshotDependencies {
  list(): Promise<SnapshotList>;
  administrator: typeof runAdministratorCommands;
}
const defaults: SnapshotDependencies = { list: listTimeMachineSnapshotDates, administrator: runAdministratorCommands };

export async function removeReviewedSnapshots(input: unknown, deps = defaults): Promise<MaintenanceResult> {
  if (!Array.isArray(input) || !input.length || input.length > 100 || !input.every((date) => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}-\d{6}$/.test(date)) || new Set(input).size !== input.length) throw new Error('Selecione de 1 a 100 snapshots válidos da lista.');
  const dates = input as string[];
  const before = await deps.list();
  if (before.error) throw new Error('Não foi possível conferir os snapshots atuais. Atualize a lista.');
  if (dates.some((date) => !before.dates.includes(date))) throw new Error('A lista de snapshots mudou. Atualize antes de remover.');
  let commandError: string | undefined;
  try {
    await deps.administrator(dates.map((date) => ({ file: '/usr/bin/tmutil', args: ['deletelocalsnapshots', date] })));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    commandError = /cancel|\(-128\)/i.test(message) ? 'A autorização do macOS foi cancelada.' : 'O macOS interrompeu a remoção. Os snapshots restantes foram preservados.';
  }
  const after = await deps.list();
  if (after.error) return { success: false, message: 'Não foi possível confirmar o resultado. Atualize a lista de snapshots.', error: commandError };
  const deleted = dates.filter((date) => !after.dates.includes(date)).length;
  return {
    success: deleted === dates.length,
    message: `${deleted} de ${dates.length} ${dates.length === 1 ? 'snapshot removido' : 'snapshots removidos'}.`,
    error: commandError ?? (deleted < dates.length ? 'Alguns snapshots continuam disponíveis no Mac.' : undefined),
  };
}
