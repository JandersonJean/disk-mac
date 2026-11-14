import type { CategoryId, CategoryInfo, RunMode } from '../shared/types.js';
import { formatSize as formatSizeBase } from '../../../src/utils/size.js';

const CATEGORY_PT_BR: Record<CategoryId, Pick<CategoryInfo, 'name' | 'description' | 'safetyNote'>> = {
  'system-cache': { name: 'Cache do usuário', description: 'Caches de aplicativos armazenados em ~/Library/Caches', safetyNote: 'Alguns aplicativos podem precisar recriar o cache ao serem abertos' },
  'system-logs': { name: 'Logs do sistema', description: 'Logs do sistema e dos aplicativos', safetyNote: 'Os logs podem ajudar a investigar problemas' },
  'temp-files': { name: 'Arquivos temporários', description: 'Arquivos temporários em /tmp e /var/folders' },
  trash: { name: 'Lixeira', description: 'Arquivos que estão na Lixeira' },
  downloads: { name: 'Downloads antigos', description: 'Arquivos da pasta Downloads com mais de 30 dias', safetyNote: 'Pode haver arquivos importantes que você esqueceu' },
  'browser-cache': { name: 'Cache dos navegadores', description: 'Cache do Chrome, Safari, Firefox e Arc' },
  'dev-cache': { name: 'Cache de desenvolvimento', description: 'Caches do npm, yarn, pip, Xcode DerivedData e CocoaPods', safetyNote: 'Os projetos podem precisar reconstruir ou reinstalar dependências' },
  homebrew: { name: 'Cache do Homebrew', description: 'Downloads do Homebrew e versões antigas de fórmulas', safetyNote: 'Executa “brew cleanup --prune=all” e remove versões antigas das fórmulas' },
  docker: { name: 'Docker', description: 'Imagens sem uso, contêineres parados e cache de compilação', safetyNote: 'Imagens que não estão em uso precisarão ser baixadas ou compiladas novamente' },
  'ios-backups': { name: 'Backups de iPhone e iPad', description: 'Backups locais de dispositivos iPhone e iPad', safetyNote: 'Você pode perder backups importantes do dispositivo permanentemente' },
  'mail-attachments': { name: 'Anexos do Mail', description: 'Anexos baixados pelo aplicativo Mail', safetyNote: 'Os anexos podem conter documentos e arquivos importantes' },
  'language-files': { name: 'Arquivos de idioma', description: 'Localizações de idioma não utilizadas nos aplicativos', safetyNote: 'Altera a assinatura do aplicativo; o macOS pode impedir sua abertura e atualizações' },
  'large-files': { name: 'Arquivos grandes', description: 'Arquivos maiores que 500 MB para você revisar', safetyNote: 'Revise cada arquivo antes de removê-lo' },
  'node-modules': { name: 'Dependências node_modules', description: 'Pastas node_modules em projetos antigos', safetyNote: 'Será necessário executar npm install para restaurar as dependências' },
  'git-worktrees': { name: 'Worktrees do Git', description: 'Worktrees antigos ou sem vínculo com projetos ativos', safetyNote: 'Uma worktree pode conter alterações não salvas; revise o caminho antes de removê-la' },
  duplicates: { name: 'Arquivos duplicados', description: 'Arquivos com conteúdo idêntico', safetyNote: 'Revise os arquivos; por padrão, a cópia mais recente é mantida' },
  'launch-agents': { name: 'Agentes de inicialização órfãos', description: 'Agentes que apontam para aplicativos que não existem mais', safetyNote: 'A remoção impede a inicialização automática do agente' },
};

const MODE_PT_BR: Record<RunMode, string> = { auto: 'Automática', quick: 'Manual', deep: 'Completa' };

export function categoryName(id: CategoryId, fallback: string): string { return CATEGORY_PT_BR[id]?.name ?? fallback; }
export function categoryDescription(id: CategoryId, fallback: string): string { return CATEGORY_PT_BR[id]?.description ?? fallback; }
export function categorySafetyNote(id: CategoryId, fallback?: string): string | undefined { return CATEGORY_PT_BR[id]?.safetyNote ?? fallback; }
export function safetyLabel(level: CategoryInfo['safetyLevel']): string { return { safe: 'Seguro', moderate: 'Atenção', risky: 'Arriscado' }[level]; }
export function modeLabel(mode: RunMode): string { return MODE_PT_BR[mode]; }
export function itemCount(count: number): string { return `${count} ${count === 1 ? 'item' : 'itens'}`; }
export function formatSize(size: number): string { return formatSizeBase(size).replace('.', ','); }

export function formatWhen(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const time = date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(date) - startOfDay(now)) / 86400000);
  if (dayDiff === 0) return `Hoje, ${time}`;
  if (dayDiff === -1) return `Ontem, ${time}`;
  if (dayDiff === 1) return `Amanhã, ${time}`;
  return `${date.toLocaleDateString('pt-BR', { day: 'numeric', month: 'short' })} às ${time}`;
}

export function translateError(message: string): string {
  const categoryNames: Partial<Record<CategoryId, string>> = {
    'system-cache': 'User Cache Files',
    'system-logs': 'System Log Files',
    'temp-files': 'Temporary Files',
    trash: 'Trash',
    downloads: 'Old Downloads',
    'browser-cache': 'Browser Cache',
    'dev-cache': 'Development Cache',
    homebrew: 'Homebrew Cache',
    docker: 'Docker',
    'ios-backups': 'iOS Backups',
    'mail-attachments': 'Mail Attachments',
    'language-files': 'Language Files',
    'large-files': 'Large Files',
    'node-modules': 'Node Modules',
    'git-worktrees': 'Git Worktrees',
    duplicates: 'Duplicate Files',
    'launch-agents': 'Orphaned Launch Agents',
  };
  for (const [id, source] of Object.entries(categoryNames)) {
    if (source && message.startsWith(`${source}:`)) {
      message = `${categoryName(id as CategoryId, source)}${message.slice(source.length)}`;
      break;
    }
  }
  const known: Array<[string, string]> = [
    ['A scan or clean is already running', 'Já existe uma análise ou limpeza em andamento.'],
    ['The scan is out of date. Scan again to review what will be deleted.', 'Esta análise expirou. Faça uma nova análise para revisar os itens antes de removê-los.'],
    ['Unauthorized IPC sender', 'A solicitação foi bloqueada por segurança.'],
    ['Another task is already running. Wait for it to finish before starting a new one.', 'Outra tarefa está em andamento. Aguarde a conclusão antes de iniciar uma nova.'],
    ['Application was not found in the installed application list. Scan again before uninstalling.', 'O aplicativo não foi encontrado na lista atual. Atualize a busca antes de desinstalar.'],
    ['The snapshot list changed. Scan snapshots again before removing them.', 'A lista de snapshots mudou. Atualize a busca antes de removê-los.'],
    ['Invalid application path', 'O caminho do aplicativo é inválido.'],
    ['Invalid Time Machine snapshot selection', 'A seleção de snapshots do Time Machine é inválida.'],
    ['tmutil not available or Time Machine is not configured on this Mac', 'O Time Machine não está configurado ou o utilitário do macOS está indisponível.'],
    ['Invalid backup path', 'O caminho do backup é inválido.'],
    ['Backup was not found in the current backup list. Refresh before restoring.', 'O backup não está na lista atual. Atualize antes de restaurar.'],
    ['Invalid backup directory: must be within a valid backup folder', 'A pasta de backup está fora do local permitido.'],
    ['Could not parse tmutil output', 'Não foi possível interpretar a lista de snapshots do Time Machine.'],
  ];
  for (const [source, translated] of known) if (message.includes(source)) return message.replace(source, translated);
  return message
    .replace(/Scan failed:/gi, 'Falha na análise:')
    .replace(/permission denied/gi, 'permissão negada')
    .replace(/operation not permitted/gi, 'operação não permitida pelo macOS')
    .replace(/no such file or directory/gi, 'arquivo ou pasta não existe mais');
}
