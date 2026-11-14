import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { userInfo } from 'node:os';
import type { OptimizationId, OptimizationOutcome, OptimizationReport, OptimizationTask } from '../shared/disk-tools.js';

interface Command { file: string; args: string[]; timeoutMs?: number }
interface Task extends Omit<OptimizationTask, 'available'> { commands: Command[] }
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
const TASKS: Task[] = [
  { id: 'quicklook', title: 'Pré-visualizações do Finder', description: 'Renova as miniaturas e recarrega os geradores do QuickLook.', impact: 'As miniaturas serão recriadas ao abrir as pastas.', administrator: false, recommended: true,
    commands: [{ file: '/usr/bin/qlmanage', args: ['-r', 'cache'] }, { file: '/usr/bin/qlmanage', args: ['-r'] }] },
  { id: 'icons', title: 'Serviço de ícones', description: 'Reinicia o serviço de ícones da sua sessão para corrigir ícones desatualizados.', impact: 'Os ícones podem desaparecer brevemente enquanto o macOS os recarrega.', administrator: false, recommended: false,
    commands: [{ file: '/usr/bin/killall', args: ['-u', userInfo().username, 'iconservicesagent'] }] },
  { id: 'file-cache', title: 'Cache de arquivos na memória', description: 'Descarta o cache de leitura de arquivos mantido pelo sistema na memória.', impact: 'Uso avançado. Exige administrador e pode deixar as próximas leituras mais lentas. Não libera armazenamento em disco.', administrator: true, recommended: false,
    commands: [{ file: '/usr/sbin/purge', args: [], timeoutMs: 60_000 }] },
  { id: 'dns', title: 'Cache de rede e DNS', description: 'Atualiza o cache de nomes de domínio e o serviço de resolução do macOS.', impact: 'O macOS solicitará autorização de administrador.', administrator: true, recommended: false,
    commands: [{ file: '/usr/bin/dscacheutil', args: ['-flushcache'] }, { file: '/usr/bin/killall', args: ['-HUP', 'mDNSResponder'] }] },
  { id: 'applications', title: 'Associações de aplicativos', description: 'Atualiza os aplicativos registrados e compacta a base usada pelo menu “Abrir com”.', impact: 'Pode levar alguns minutos em Macs com muitos aplicativos.', administrator: false, recommended: true,
    commands: [{ file: LSREGISTER, args: ['-gc', '-r', '-apps', 'user,local,system'], timeoutMs: 120_000 }] },
  { id: 'spotlight', title: 'Índice do Spotlight', description: 'Solicita ao macOS a reconstrução do índice de busca do disco principal.', impact: 'Exige administrador. A reindexação continua em segundo plano e pode aumentar o uso de CPU e bateria.', administrator: true, recommended: false,
    commands: [{ file: '/usr/bin/mdutil', args: ['-E', '/'], timeoutMs: 30_000 }] },
  { id: 'periodic', title: 'Rotinas periódicas do macOS', description: 'Executa as rotinas diária, semanal e mensal nas versões que ainda as oferecem.', impact: 'Exige administrador; indisponível em versões recentes do macOS.', administrator: true, recommended: false,
    commands: [{ file: '/usr/sbin/periodic', args: ['daily', 'weekly', 'monthly'], timeoutMs: 120_000 }] },
  { id: 'disk-check', title: 'Verificar o sistema de arquivos', description: 'Verifica a integridade do volume principal e apresenta o resultado.', impact: 'É uma verificação, sem reparo automático. Pode levar alguns minutos.', administrator: false, recommended: false,
    commands: [{ file: '/usr/sbin/diskutil', args: ['verifyVolume', '/'], timeoutMs: 180_000 }] },
];

export interface OptimizerDependencies {
  available(file: string): Promise<boolean>;
  execute(command: Command): Promise<string>;
  administrator(commands: Command[]): Promise<string>;
}
function execute(command: Command): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command.file, command.args, { timeout: command.timeoutMs ?? 20_000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { details: stderr.trim() }));
      else resolve(stdout.trim());
    });
  });
}
// Only fixed, internal command definitions reach the administrator prompt.
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export async function runAdministratorCommands(commands: Command[]): Promise<string> {
    const script = commands.map((command) => [command.file, ...command.args].map(shellQuote).join(' ')).join(' && ');
    const appleScriptString = script.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
    return execute({ file: '/usr/bin/osascript', args: ['-e', `do shell script "${appleScriptString}" with administrator privileges`], timeoutMs: 240_000 });
}
const defaults: OptimizerDependencies = {
  available: async (file) => { try { await access(file, constants.X_OK); return true; } catch { return false; } },
  execute,
  administrator: runAdministratorCommands,
};

export async function optimizationTasks(deps = defaults): Promise<OptimizationTask[]> {
  return Promise.all(TASKS.map(async ({ commands, ...task }) => ({ ...task, available: (await Promise.all(commands.map((command) => deps.available(command.file)))).every(Boolean) })));
}

export async function optimizeSystem(input: unknown, progress?: (completed: number, total: number, current: string) => void, deps = defaults): Promise<OptimizationReport> {
  if (!Array.isArray(input) || input.length === 0 || input.length > TASKS.length || new Set(input).size !== input.length || input.some((id) => !TASKS.some((task) => task.id === id))) {
    throw new Error('Selecione apenas as rotinas de otimização disponíveis na lista.');
  }
  const selected = TASKS.filter((task) => input.includes(task.id));
  const results: OptimizationOutcome[] = [];
  for (const task of selected) {
    const started = Date.now();
    progress?.(results.length, selected.length, task.title);
    let status: OptimizationOutcome['status'] = 'applied';
    let message = task.id === 'spotlight' ? 'Reindexação solicitada. O macOS continuará o trabalho em segundo plano.' : 'Rotina concluída.';
    try {
      if (!(await Promise.all(task.commands.map((command) => deps.available(command.file)))).every(Boolean)) {
        status = 'skipped'; message = 'Este utilitário não está disponível nesta versão do macOS.';
      } else if (task.administrator) {
        const output = await deps.administrator(task.commands);
        if (task.id === 'spotlight' && /indexing disabled|error|failed/i.test(output)) throw new Error(output);
      } else {
        for (const command of task.commands) await deps.execute(command);
        if (task.id === 'disk-check') message = 'A verificação do volume terminou sem relatar falhas.';
      }
    } catch (error) {
      const details = error instanceof Error ? `${error.message} ${(error as Error & { details?: string }).details ?? ''}` : String(error);
      if (/User canceled|cancelled|canceled|\(-128\)/i.test(details)) { status = 'cancelled'; message = 'Autorização cancelada. Nenhuma outra rotina será iniciada.'; }
      else if (task.id === 'icons' && /No matching processes/i.test(details)) { status = 'skipped'; message = 'O serviço de ícones não estava em execução na sua sessão.'; }
      else { status = 'failed'; message = /timed out|ETIMEDOUT|SIGTERM/i.test(details) ? 'A rotina excedeu o tempo limite. A conclusão não foi confirmada.' : `O macOS não concluiu esta rotina: ${details.slice(0, 500)}`; }
    }
    results.push({ id: task.id, title: task.title, status, message, durationMs: Date.now() - started });
    progress?.(results.length, selected.length, task.title);
    if (status === 'cancelled') break;
  }
  return { finishedAt: new Date().toISOString(), results };
}

export type { OptimizationId };
