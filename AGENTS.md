# Disk Mac — orientações e status do projeto

Última atualização: **14/11/2026**.

Este arquivo registra o estado do Disk Mac, as verificações feitas nesta máquina e a análise de continuidade do projeto. Confira o código e o estado do Git antes de retomar o trabalho. Atualize este documento quando uma entrega mudar o comportamento, a instalação local ou as evidências de validação.

## Objetivo e contexto

- **Disk Mac** é um fork de [mac-cleaner-cli](https://github.com/guhcostan/mac-cleaner-cli). O repositório do projeto é [JandersonJean/disk-mac](https://github.com/JandersonJean/disk-mac).
- Objetivo: disponibilizar na interface gráfica as funcionalidades úteis da CLI, ampliando limpeza, desinstalação, otimização, análise de disco, backups e monitoramento do sistema.
- Interface em **pt-BR**, com linguagem clara e resultados que descrevam o que realmente aconteceu.
- Tema escolhido: **Modern Minimalist**, grafite e cinza, próximo ao macOS, com suporte aos modos claro e escuro.
- Referências de produto: Monitor de Atividade do macOS e Mole (`https://github.com/tw93/Mole`). As rotinas inspiradas no Mole foram implementadas em TypeScript; o app não inclui nem exige a instalação do Mole.
- A identidade visual e o ícone já foram adaptados para Disk Mac. A referência visual local está em `desktop/design/ordem-silenciosa.md` e no PNG correspondente.

## Estado da entrega local

| Item | Situação em 14/11/2026 |
| --- | --- |
| Branch de publicação | `main` |
| Base do fork | `725f5e7` do projeto original |
| Versão nos manifests | `1.4.0` na raiz e em `desktop/` |
| Pacote desktop | `disk-mac-desktop` |
| Bundle identifier | `io.github.guhcostan.diskmac` |
| Electron usado na compilação local | `44.10.2` |
| Ambiente validado localmente | Apple Silicon (`arm64`), macOS 27.2 (26B123) |
| App de desenvolvimento instalado | `~/Applications/Disk Mac.app` |
| Última atualização instalada | Indicadores do monitor com leituras a cada 500 ms |
| Assinatura | Ad-hoc, verificada com `codesign --verify --deep --strict` |

O `app.asar` instalado e o gerado em `desktop/release/mac-arm64/Disk Mac.app` foram conferidos e têm o mesmo SHA-256:

```text
831f899a6828a954f2990fc828ca4e92c5c29314d34d61db906f07ee6be02eec
```

O hash confirma a igualdade entre o build local do monitor de 500 ms e a instalação usada nessa validação. A publicação do código inclui ajustes de documentação, CI e origem dos instaladores. Para instalar a partir do GitHub Releases, é preciso publicar um release com os arquivos correspondentes.

## Funcionalidades implementadas

### Navegação e limpeza

- Menu atual: **Início, Monitor do sistema, Limpeza completa, Analisar disco, Otimizar, Desinstalar apps, Backups, Histórico e Ajustes**.
- Visão geral do armazenamento, limpeza manual, limpeza automática agendada, histórico e configurações.
- Reutilização dos scanners e das rotinas da CLI na interface gráfica.
- A limpeza completa exige uma prévia recente e seleção dos itens. Categorias arriscadas não entram nas execuções automáticas.
- Backup opcional para itens compatíveis. Arquivos movidos para backup continuam ocupando armazenamento.

### Monitor do sistema e barra de menus

- Indicadores reais de CPU, memória, swap, rede, espaço em disco e bateria.
- Uso e histórico da GPU no monitor completo e no painel compacto, quando o driver expõe o contador. Se houver várias GPUs, o indicador mostra a mais ativa. A coleta da GPU ocorre somente com o monitor visível.
- Os gráficos mantêm os mesmos elementos na tela e deslizam ao receber novas leituras. O eixo usa os horários reais em uma janela de dois minutos. Intervalos sem amostras ficam em branco, e a preferência por movimento reduzido desativa o deslizamento.
- Tabela de processos com busca por nome, usuário ou PID e ordenação por CPU, memória, nome ou PID.
- A CPU de cada processo é calculada pela diferença no tempo acumulado de CPU entre amostras da mesma identidade. Cerca de 100% equivale a um núcleo. A primeira amostra e contadores indisponíveis aparecem como `—`. A tabela começa com 100 linhas, pode carregar mais e pesquisa o inventário completo.
- A janela principal é liberada ao fechar. O Disk Mac permanece na barra de menus e volta ao Dock quando a janela principal reabre. **Encerrar Disk Mac** ou `⌘Q` encerram o app.
- A rotina usa intervalos diferentes para equilibrar resposta e custo:

  | Leitura | Intervalo alvo | Quando ocorre |
  | --- | --- | --- |
  | CPU total, GPU, memória e rede | 500 ms | Monitor ou painel compacto visível |
  | Inventário e CPU por processo | 2 s | Monitor ou painel compacto visível, em coleta independente |
  | Espaço em disco, bateria e swap | 10 s | Monitor ou painel compacto visível, com resultados em cache |
  | Métrica selecionada ao lado do ícone | 5 s | Monitor e painel fechados. **Oculto** pausa a coleta. |

- O processo principal compartilha uma coleta entre as janelas. Cada leitura rápida atualiza os cartões e gráficos existentes. A tabela só é redesenhada com um novo inventário ou interação. As sondagens rápidas por comando têm limite individual de 350 ms e o histórico preserva aproximadamente dois minutos de amostras.
- O ícone do monitor é uma linha fixa em estilo de gráfico.
- **Valor ao lado do gráfico** pode ser escolhido em Ajustes ou no menu de contexto do ícone. O texto mostra CPU, memória, download ou upload e pode ficar oculto.
- Clique no ícone abre um painel compacto, com indicadores, processos de maior consumo e acesso ao monitor completo. O painel é liberado ao dispensá-lo e recriado no próximo acesso.
- O contorno de foco indesejado no painel foi ajustado, preservando a indicação de foco para navegação por teclado.

### Encerramento de processos

- Selecionar uma linha no monitor completo habilita **Finalizar processo…**, quando permitido.
- A confirmação identifica nome, PID e usuário do processo selecionado.
- **Finalizar** envia `SIGTERM`. **Forçar encerramento…** abre uma confirmação adicional antes de enviar `SIGKILL`.
- A identidade reúne PID, UID, início da execução e executável. A leitura é refeita antes de sinalizar, para detectar processos que saíram ou PIDs reaproveitados entre seleção e confirmação. Essa verificação não torna a leitura e o sinal uma operação atômica do sistema.
- Confirmações expiram em 60 segundos, são de uso único e podem ser canceladas.
- Somente processos do usuário atual são elegíveis. Componentes essenciais do macOS, processos de outras sessões/root e a própria árvore/bundle do Disk Mac ficam protegidos.
- O app verifica a saída e distingue encerramento confirmado, processo já encerrado, processo ainda ativo e verificação indisponível.
- Não existe escalonamento automático para encerramento forçado nem pedido de administrador para esta ação.
- A seleção permanece ligada à identidade do processo durante as atualizações e reordenações. O painel da barra de menus continua somente para consulta.

### Otimizar

- **Manutenção foi incorporada a Otimizar**; não restaurar o menu duplicado nem duplicar a ação de DNS.
- Uma única tela reúne caches/serviços e opções avançadas de diagnóstico.
- Rotinas: QuickLook, serviço de ícones, DNS, associações de aplicativos, Spotlight, manutenção periódica quando disponível, verificação do volume sem reparo automático e limpeza opcional do cache de arquivos em memória.
- Cada rotina mostra disponibilidade, impacto, necessidade de administrador e resultado individual.
- A ação `purge` é apresentada como **Cache de arquivos na memória**. Ela não promete liberar armazenamento em disco e não vem selecionada por padrão.

### Analisar disco

- Escolha de pasta/volume, mapa proporcional de espaço, navegação por subpastas, filtro e lista dos 50 maiores arquivos.
- Análise em worker cancelável, sem ler o conteúdo dos arquivos, seguir links simbólicos ou atravessar outros volumes montados.
- Dados de hard links são contados uma vez. Limites de execução e falhas de permissão geram resultados explicitamente parciais.
- Resultados parciais são destacados antes do mapa. Itens que a leitura não alcançou aparecem como **Não medido**. A revisão antes do envio à Lixeira explica a diferença entre o espaço medido e o que pode ser recuperado no APFS.
- Itens revisados podem ser movidos para a Lixeira após confirmação, com nova verificação de identidade e proteção de locais sensíveis.

### Desinstalação

- Inventário de bundles `.app` e pacotes Homebrew, com exibição dos caminhos associados e confirmação antes da remoção. Após uma nova consulta ao inventário, a ação remove os caminhos associados encontrados para o alvo como um conjunto.
- Remoção de casks e fórmulas pelo Homebrew. O resultado informa falhas parciais de remoção.
- Correção da remoção de apps com arquivos ASAR no Electron: `physical-fs.ts` usa `original-fs` para operar no sistema de arquivos físico, evitando tratar ASAR como diretório virtual. Inclui tratamento de falhas como `ENOTEMPTY` e `EBUSY`.
- O objetivo de remover qualquer instalação do Mac ainda não está integralmente atendido; não apresentar suporte universal a instaladores `.pkg` ou a desinstaladores específicos de fabricantes.

### Backups

- Área independente, com abas **Disk Mac** e **Time Machine**.
- Cópias do Disk Mac: quantidade, tamanho, retenção, busca, prévia de conteúdo/caminhos originais e identificação de conflitos antes de restaurar.
- Restauração sem sobrescrever arquivos existentes; cópias conflitantes permanecem no backup. Links são tratados como links e destinos com pais apontando para fora da pasta pessoal são recusados.
- Cópias expiradas vão para a Lixeira somente após revisão e revalidação da sessão e do conteúdo.
- Snapshots locais do Time Machine começam desmarcados; remoção exige revisão específica e autorização nativa do macOS. O resultado é conferido pela listagem restante.

## Arquitetura e arquivos principais

O desktop é **Electron + TypeScript + HTML/CSS**, sem framework de interface. O esbuild empacota o código da CLI junto com o processo principal.

| Local | Responsabilidade |
| --- | --- |
| `src/commands/`, `src/scanners/`, `src/utils/` | CLI e rotinas reutilizadas pelo desktop |
| `src/utils/backup.ts`, `src/utils/physical-fs.ts` | Backups compartilhados e acesso físico a arquivos no Electron |
| `desktop/src/main/main.ts` | Ciclo de vida, janelas, tray, IPC e integração das operações |
| `desktop/src/main/controller.ts`, `engine.ts` | Orquestração de limpeza, execução e controle de atividade |
| `desktop/src/main/settings.ts`, `store.ts`, `schedule.ts` | Configurações, persistência e agendamento |
| `desktop/src/main/system-monitor.ts`, `tray-chart.ts` | Coleta de métricas e gráfico do ícone |
| `desktop/src/main/process-inventory.ts`, `process-control.ts` | Inventário, identidade, proteções e encerramento de processos |
| `desktop/src/main/optimizer.ts` | Catálogo e execução das otimizações |
| `desktop/src/main/disk-analysis.ts`, `disk-analysis-worker.ts`, `disk-explorer.ts` | Análise de disco e operações sobre resultados revisados |
| `desktop/src/main/backup-manager.ts`, `backup-snapshots.ts` | Gestão de backups e snapshots |
| `desktop/src/preload/preload.ts`, `desktop/src/shared/` | API `window.cleaner`, contratos e tipos de IPC |
| `desktop/src/renderer/app.ts`, `index.html`, `styles.css` | Navegação, composição das telas e estilos |
| `desktop/src/renderer/system-dashboard.ts`, `process-actions.ts`, `monitor.ts` | Monitor completo, ações de processos e painel compacto |
| `desktop/src/renderer/disk-tools-view.ts`, `backups-view.ts` | Interfaces de otimização/análise e backups |
| `desktop/scripts/`, `desktop/electron-builder.config.cjs` | Build, testes de integração e empacotamento |

## Persistência e compatibilidade de nomes

- Estado/configurações/histórico: `~/Library/Application Support/Disk Mac/state.json`.
- Na primeira execução, o app pode copiar estado de instalações antigas (`Mac Cleaner Fork Test` ou `Mac Cleaner`) se o novo arquivo ainda não existir.
- O armazenamento compartilhado de backups continua em **`~/.mac-cleaner-cli/backup`**, definido em `src/utils/backup.ts`. O nome antigo neste caminho é compatibilidade de dados; uma mudança exige migração deliberada, preservando cópias existentes e acesso pela CLI.
- A CLI mantém o comando `mac-cleaner-cli` e a compatibilidade com seus caminhos existentes. O fork busca arquivos de instalação no GitHub Releases de `JandersonJean/disk-mac`. Os créditos e links de histórico identificam o projeto original.
- Nome exibido do produto: **Disk Mac**. Não criar um novo bundle identifier para uma atualização comum.

## Como desenvolver e validar

Usar as dependências locais existentes. Se necessário, instalar as dependências tanto da raiz quanto de `desktop/`. O CI instala Bun e Node. Alguns testes de versão da CLI executam `bun src/index.ts --version` diretamente.

```bash
# Na raiz do repositório
npm run typecheck
npm run lint

# Desktop
cd desktop
npm run typecheck
npm test
npm run build
npm start
```

A suíte da CLI usa `npm test` na raiz. Para validar a suíte completa com cobertura, use `bun run test:coverage`, um perfil descartável com caminho curto, como uma pasta criada com `mktemp -d /tmp/dm.XXXXXX`, e um ambiente que permita sockets Unix. Alguns testes usam `os.homedir()` e as verificações de formatação dependem de um caminho que caiba sem truncamento. Os testes de backup também isolam a própria pasta pessoal.

Os testes de integração abaixo precisam de macOS. Alguns iniciam o Electron ou consultam processos do sistema. Use os dados e processos temporários criados pelos próprios testes.

```bash
cd desktop
npm run test:process-control
npm run test:uninstall-asar
npm run test:disk-analysis
npm run test:backups
```

### Conferido na revisão de 14/11/2026

| Verificação | Resultado |
| --- | --- |
| TypeScript da CLI e do desktop | Passou nos dois projetos |
| ESLint da raiz (`src` e `desktop/src`) | Passou |
| Suíte do desktop | **120 de 120** testes em 14 arquivos |
| Suíte da CLI | **452 de 475** testes passaram. Houve 18 falhas por gravações na pasta pessoal bloqueadas pelo sandbox, 3 por sockets Unix bloqueados e 2 pela falta de Bun no PATH. A execução completa em ambiente isolado segue pendente. |
| Instalação local | Bundle `arm64` com assinatura ad-hoc válida e `app.asar` igual ao artefato local |

### Evidências das entregas anteriores

- **Cobertura da CLI.** Os 493 testes passaram com Node 22 e 24 e as dependências do lockfile. O menor resultado entre as duas versões foi 92,86% de linhas, 92,04% de funções, 92,13% de instruções e 85,80% de ramificações. Os testes novos exercitam inventário e remoção via Homebrew e restauração com conflitos, links e cópias entre volumes.
- **Cadência do monitor.** O Electron recebeu dez leituras reais do painel compacto, com mediana de **502 ms** entre amostras e duas novas listas de processos. Fechar o painel com o valor oculto pausou a coleta. A medição foi uma amostra curta neste Mac.
- **CPU, GPU e processos.** Um processo temporário marcou 100,1% ao ocupar um núcleo e 0% em repouso. O painel recebeu leituras reais da GPU. Processos temporários confirmaram `SIGTERM` e `SIGKILL` solicitado explicitamente após um processo ignorar `SIGTERM`.
- **Interface.** A janela principal e o painel compacto foram verificados com o renderer compilado e amostras simuladas. A verificação de seleção, cancelamento e bloqueio de ações de processo incluiu o tamanho mínimo de 860 × 620. A automação da interface nativa permanece sem uma validação abrangente.
- **Barra de menus.** O teste do Electron confirmou que o ícone fica fixo ao alternar CPU, memória, download, upload e oculto, que a escolha persiste e que fechar a janela preserva o acesso pelo ícone.
- **Arquivos.** As fixtures do Electron confirmaram remoção de bundle com ASAR físico, análise em worker com cancelamento e nova leitura, e restauração de backup com preservação de conflitos. Essas verificações antecedem a revisão documental atual.

## Compilar e atualizar o bundle local

Comandos utilizados para gerar somente o bundle Apple Silicon, aproveitando a distribuição local do Electron:

```bash
cd desktop
npm run build
./node_modules/.bin/electron-builder --mac --arm64 --dir \
  --config electron-builder.config.cjs \
  --config.electronDist=node_modules/electron/dist \
  --publish never
```

- Saída: `desktop/release/mac-arm64/Disk Mac.app`.
- `npm run dist` é o fluxo de distribuição definido no projeto para DMG/ZIP; não confundir com o bundle local acima.
- Ao atualizar uma instalação autorizada, preparar e validar o novo bundle antes de substituir o antigo. Preservar uma cópia recuperável e os dados/configurações do usuário.
- Identificar novamente o PID e o executável do app instalado antes de encerrá-lo. Não reutilizar PIDs de conversas ou testes anteriores e não usar encerramentos genéricos por nome.
- Conferir assinatura, igualdade do `app.asar` e inicialização após a troca. Não publicar ou afirmar que uma release remota foi criada apenas porque o build local passou.

## Cuidados para as próximas alterações

- Ler `git status` e os trechos relevantes antes de editar. Há trabalho local acumulado; não executar reset/checkout/clean que o descarte.
- Manter privilégios no processo principal: renderer isolado, CSP restritiva, sem Node.js direto e API explícita pelo preload. Validar origem e argumentos no IPC.
- Preservar proteções no backend, mesmo quando o botão correspondente estiver desabilitado na interface.
- Em operações destrutivas, preservar seleção, revisão, cancelamento e confirmação de resultado. Não transformar o envio de um comando em mensagem de sucesso sem verificação.
- Não executar limpeza, otimização, exclusão de snapshots ou encerramento de processos reais do usuário apenas para validar código. Usar fixtures temporárias e limitar sinais aos PIDs criados pelo teste.
- Manter a confirmação de perda de dados no encerramento de processos; não sinalizar grupos de processos nem introduzir encerramento forçado automático.
- Em mudanças do monitor compartilhado, verificar também o painel da barra de menus. Preservar navegação por teclado e estabilidade de foco/seleção durante atualizações.
- Executar verificações proporcionais à mudança; documentação isolada não exige executar operações do sistema ou repetir todos os testes.

## Limitações e continuidade

- Não há desinstalação universal de `.pkg` nem cobertura garantida de todos os resíduos de qualquer aplicativo.
- A leitura da GPU depende do contador exposto pelo driver. Temperatura, ventoinhas, impacto energético e disco/rede por processo ainda não são medidos.
- A análise de disco não garante espaço recuperável em APFS, pois clones podem compartilhar blocos; resultados parciais precisam continuar identificados.
- O catálogo de otimização é uma implementação própria e parcial das ideias do Mole, não uma reprodução completa do projeto.
- Distribuição pública com assinatura Developer ID, notarização e atualizações automáticas permanece fora da entrega local validada.
- O histórico de validação acima cobre a máquina Apple Silicon atual; compatibilidade Intel e outras versões de macOS requer validação própria.

## Análise geral e prioridades

O Disk Mac já reúne os fluxos principais de manutenção e monitoramento em um aplicativo utilizável neste Mac. O desktop reutiliza scanners e rotinas da CLI. As operações com maior impacto, como mover resultados da análise para a Lixeira e encerrar processos, têm confirmação e verificações no processo principal. A instalação local foi verificada no Apple Silicon. A confiança em outros ambientes depende de reproduzir o build e repetir os testes.

| Prioridade | Evidência no estado atual | Próximo passo proposto |
| --- | --- | --- |
| 1. Isolar a suíte da CLI | Testes de backup usam `os.homedir()` e chamam a rotina de retenção. Outros dependem de Bun e sockets Unix. | Usar diretórios temporários também nos testes que hoje acessam a pasta pessoal. Rodar a suíte completa com Bun e sockets disponíveis, em perfil isolado. |
| 2. Tornar a entrega reproduzível | O bundle instalado passou na verificação local. A primeira publicação traz o código, os scripts e os recursos ao mesmo repositório. | Confirmar o build e as fixtures a partir de um checkout limpo da branch principal. Acompanhar o resultado dos testes, das fixtures e do empacotamento no CI. |
| 3. Reforçar a revisão da desinstalação | A tela exibe caminhos relacionados, mas o processo principal redescobre a lista e remove o conjunto encontrado no momento da execução. | Permitir selecionar os dados associados e vincular a confirmação aos caminhos revisados. Se o conjunto mudar, apresentar a diferença para nova revisão. Investigar inventário de recibos `.pkg` como etapa separada. |
| 4. Medir o monitor sob carga | Os 502 ms vieram de dez amostras neste Mac. Cada ciclo rápido ainda executa `vm_stat`, `netstat` e `ioreg`, e envia histórico e inventário em cada atualização. | Medir latência, CPU e memória em sessões mais longas, com as duas janelas, operações de disco e retomada após suspensão. Se o custo aparecer nas medições, enviar o inventário só quando ele mudar e avaliar cadências próprias para sondagens mais caras. |
| 5. Validar a distribuição | O empacotamento tem alvos `arm64` e `x64`, e a entrega verificada é ad-hoc em Apple Silicon. | Testar instalação, atualização e abertura em versões de macOS e arquiteturas que o projeto pretende atender. Para uma entrega pública assinada, validar Developer ID e notarização no CI. |

Enquanto a entrega é validada, mantenha visíveis a origem e os limites de cada leitura. A GPU depende do driver. A memória residente por processo e os blocos medidos em APFS respondem a perguntas diferentes de uso exclusivo de memória ou de espaço recuperável. Novas métricas e formas de desinstalação merecem uma fonte identificável e fixtures que cubram disponibilidade, dados parciais e falhas.

As prioridades acima são propostas para as próximas decisões do projeto.
