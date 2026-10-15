# Análise técnica do My-Code-Agent

Data: 14/10/2026. Escopo: fotografia do workspace local, incluindo alterações
que já existiam antes desta análise.

## Parecer

O projeto já tem a estrutura de um agente de programação funcional: interface
de terminal, execução de ferramentas em múltiplos passos, providers intercambiáveis,
sessões persistidas e separação PLAN/BUILD. A divisão em quatro pacotes é adequada
ao MVP e permite crescer sem reescrever a aplicação inteira.

O principal gargalo é confiabilidade do ciclo de execução. Hoje, interrupções,
histórico de ferramentas, limites de processos e fronteiras de arquivos ainda
têm inconsistências que afetam diretamente a experiência de programar com o
agente. Adicionar muitas features sobre esses pontos aumenta o custo de correção.

No código examinado, a aplicação se apresenta como implementação própria com
características inspiradas em OpenCode e Claude Code. Não identifiquei integração
direta com seus motores nos manifests e no fluxo principal. Esta análise não é
uma auditoria de origem, licenças ou equivalência funcional com esses produtos.

## O que foi verificado

- Estrutura dos quatro workspaces, scripts, dependências e configuração TypeScript.
- Rotas de sessões, chat e modelos; serviços de geração, mensagens e limites.
- Registro de modelos, adapters de providers, prompts e configuração local.
- Ferramentas de arquivos, busca, shell, Git, rede, tipos e tarefas.
- Consumo SSE, criação/reabertura de sessões, mensagens e componentes centrais da CUI.
- Schema, migration inicial e inicialização do Prisma; CI e testes existentes.
- `bun test`: **3 testes passaram, 0 falharam**, em um arquivo, com Bun 1.3.13.
- TypeScript local da CUI, com `--noEmit -p` para cada pacote: servidor, shared e
  database falharam com **TS2688**, sem encontrar tipos `bun`; CUI falhou com
  **15 diagnósticos** em `server/src/services/chat-service.ts`, relacionados a
  `sessionId` inferido como `string | undefined`.

Não iniciei a interface interativa, não apliquei migrations, não executei comandos
destrutivos nem fiz requisições a providers ou banco. Os achados de comportamento
abaixo são derivados do código, salvo os resultados de testes/typecheck indicados.
Não medi latência, consumo real de tokens ou qualidade de respostas dos modelos.

## Arquitetura e pontos positivos

| Camada | Responsabilidade atual | Avaliação |
| --- | --- | --- |
| `cui` | React/OpenTUI, navegação, diálogos, entrada e SSE | Boa separação do backend; entrada e streaming merecem decomposição gradual |
| `server` | Hono, AI SDK, ferramentas, prompts e providers | Base simples para MVP; faltam política de execução e ciclo de geração explícito |
| `shared` | Modelos, schemas Zod e eventos | Contratos validados em runtime são uma boa decisão |
| `database` | Prisma/PostgreSQL, sessões e mensagens | Persistência útil já existe; execução ainda não é uma entidade durável |

O fluxo é CUI → API → chat-service → stream-service → AI SDK/tools → SSE,
com mensagens persistidas no PostgreSQL. Não vejo justificativa, neste estágio,
para separar isso em microserviços ou trocar toda a stack.

Pontos que vale preservar:

- Ferramentas separadas por arquivo e schemas de entrada com Zod.
- PLAN/BUILD controlam as ferramentas disponíveis no servidor.
- Partes estruturadas para texto, reasoning, chamadas e resultados já são salvas.
- CUI valida eventos SSE, não apenas o tipo TypeScript.
- Limites de chamadas/repetições, timeout global e bloqueio de sessão já existem.
- Escrita com arquivo temporário e rename em `write-file.ts` e `edit-file.ts`.
- `execFile` com argumentos nas ferramentas Git reduz problemas de shell quoting.
- Logs estruturados, IDs de requisição e CI com lockfile congelado.
- Camadas de teclado e providers de tema/diálogo ajudam a organizar a interface.

## Achados prioritários

Prioridades: **P0** = corrigir antes de ampliar acesso ou executar em projetos
não confiáveis; **P1** = estabilizar o uso cotidiano do MVP; **P2** = evolução
de manutenção, custo e experiência. Severidade considera o efeito possível;
probabilidade depende de onde e como a aplicação será executada.

### 1. P0 — O shell não está isolado e a API não exige autenticação

Evidências: `server/src/tools/bash.ts`, `server/src/index.ts`,
`server/src/routes/sessions.ts` e `server/src/routes/models.ts`.

O executor roda `/bin/sh` com o ambiente herdado. A denylist de comandos não
impede acesso fora de `cwd`, execução por interpretadores, scripts de pacotes,
redirecionamento ou acesso de rede por outros executáveis. Não há camada de
aprovação de tools. As rotas não autenticam e sessões usam `mock-user`; inclusive
a configuração de chaves e criação de sessões com `cwd` vêm da API.

O export do servidor também não define `hostname`. A exposição efetiva deve ser
verificada no ambiente, sem presumir que o processo só aceita loopback.

Melhoria: explicitar bind em loopback no modo local, autenticar cliente-servidor
com token local e restringir workspaces autorizados. Introduzir uma política
central de ações: permitir, solicitar aprovação ou negar. Para projetos não
confiáveis, executar comandos com isolamento real de filesystem/rede e ambiente
reduzido. Só adicionar autenticação multiusuário se esse for o produto desejado;
para o MVP local, identidade de nuvem não é pré-requisito.

Aceite: cliente sem token não lê sessões nem executa tools; ações fora do workspace
e ações sensíveis obedecem à política, inclusive quando chamadas por scripts.

### 2. P0 — Validação de caminhos ainda permite saídas do workspace

Evidência: `server/src/utils/path.ts`, especialmente `isInside` e a validação
do diretório-pai; consumidores em `write-file.ts` e `move-file.ts`.

Se o arquivo e seu pai não existem, a função não sobe até o ancestral existente.
Uma estrutura `workspace/link/nova/pasta/arquivo`, com `link` apontando para fora,
pode passar e depois ser criada por `mkdir({ recursive: true })` fora da raiz.
No Windows, `relative` entre volumes retorna caminho absoluto; `isInside` não
rejeita esse resultado. Em sentido oposto, `startsWith("..")` também rejeita
nomes internos válidos iniciados com dois pontos.

Melhoria: rejeitar relativos absolutos, comparar segmentos corretamente, resolver
todos os ancestrais existentes e falhar de forma fechada diante de erros que não
sejam ausência de arquivo. Considerar trocas de symlink entre checagem e escrita.
Isso melhora a validação, mas não substitui isolamento do processo de shell.

Aceite: testes para traversal, outro volume, junction/symlink externo com dois
ou mais níveis ainda inexistentes e diretórios internos com prefixo `..`.

### 3. P0 — Busca pode ler symlinks externos e arquivos de credenciais

Evidência: `server/src/tools/grep.ts`. O diretório inicial é validado, mas os
arquivos coletados são lidos com `stat`/`readFile` sem validar cada destino real.
Um symlink de arquivo pode ser seguido para fora da raiz. A lista de exclusões
também não protege `.env`, `.aws`, `.myagent` ou outros arquivos sensíveis.

Melhoria: aplicar a política de acesso a cada arquivo, definir exclusões de
segredos, respeitar ignores com exceções explícitas e exigir acesso autorizado
para arquivos sensíveis. Extender a política a `read_file` e às demais tools.
Conteúdo lido pode acabar enviado ao provider: o risco não se limita ao disco.

Aceite: buscas não seguem links externos nem retornam fixtures de segredos;
leituras diretas e shell não contornam a mesma política.

### 4. P1 — Comandos longos são mortos após cinco segundos

Evidência: `server/src/tools/bash.ts:159`. `forceKillTimer` é iniciado na criação
do processo, com cinco segundos, antes de qualquer timeout ou cancelamento.
Em sistemas POSIX, o código pode encerrar builds/testes legítimos que deveriam
ter até 30–120 segundos, sem marcar corretamente `timedOut`.

Melhoria: iniciar o período de tolerância para SIGKILL somente depois de SIGTERM,
por timeout/cancelamento. Tratar sinal já abortado antes do spawn. Não descartar
a causa de erro no evento `error` do processo.

Aceite: processo que dura mais de cinco segundos e menos que seu timeout conclui;
timeout/cancelamento encerram a árvore e liberam timers/listeners.

### 5. P1 — Retomar não continua respostas parciais persistidas

Evidências: `message-service.ts:getResumableUserMessage`,
`stream-service.ts:persistInterruptedMessage` e `cui/src/hooks/use-chat.ts`.

A retomada só aceita uma sessão cuja última mensagem é USER. Depois que uma
resposta parcial é salva como ASSISTANT/INTERRUPTED, esse critério deixa de valer.
Após erro persistido como ERROR, a mesma solicitação também não é retomável por
esse endpoint. O comportamento implementado atende sobretudo à mensagem inicial
pendente, não à retomada geral descrita no README.

Melhoria: representar geração/turno e seu estado explicitamente, identificando a
mensagem de usuário associada. Continuar a partir das partes e resultados salvos,
sem reaplicar efeitos colaterais. Diferenciar retry, continuação e nova mensagem.

Aceite: interromper após uma ferramenta de escrita, reabrir a sessão e continuar
sem duplicar a escrita nem perder o resultado já obtido.

### 6. P1 — O histórico entregue ao modelo perde chamadas e resultados

Evidência: `message-service.ts:buildConversationHistory`. A função converte
mensagens para `{ role, content }`, ignorando `parts` e sem usar `status`.

As ferramentas podem funcionar dentro da geração atual pelo AI SDK, mas seus
resultados estruturados não são reconstruídos nos turnos seguintes. O modelo
depende do que foi narrado no texto final, podendo repetir leitura ou ações.

Melhoria: construir histórico compatível com o SDK, preservando pares de chamada
e resultado e tratando chamadas incompletas. Não reenviar reasoning interno
indiscriminadamente; respeitar os formatos e metadados suportados por cada adapter.

Aceite: um segundo turno consegue usar um resultado anterior, inclusive após
recarregar a sessão, sem depender apenas do resumo textual do assistente.

### 7. P1 — Interrupções e falhas podem desaparecer visualmente

Evidências: `stream-service.ts` e `cui/src/hooks/use-chat.ts`.

Timeout global e detecção de loop abortam sem evento final que explique a causa.
A CUI encerra o estado de streaming quando chega ao fim do corpo, mesmo sem
`done`, e pode descartar partes. No erro de provider, o backend grava ERROR, mas
não preserva as partes anteriores como resposta parcial. Enviar `done` depois da
gravação também pode falhar e entrar no tratamento genérico de erro.

Melhoria: estados finais explícitos com motivo, preservação de parciais em erros,
tratamento de EOF sem conclusão e reconciliação com o servidor ao reconectar.
Separar falha da geração de falha de transporte depois de persistir o resultado.

Aceite: erro após texto parcial, timeout, loop e desconexão mostram causa e
mantêm conteúdo coerente entre tela atual e sessão recarregada.

### 8. P1 — Proteção de tools e cancelamento precisam atuar na execução

Evidências: `stream-service.ts` registra limites ao consumir eventos `tool-call`;
`type-check.ts`, `web-fetch.ts` e `web-search.ts` não propagam o sinal da geração
ao trabalho subjacente. Busca web nem define timeout próprio.

Não há validação central dentro de cada `execute` garantindo que uma chamada
rejeitada pelo contador ainda não iniciou seus efeitos. A ordem exata depende
do SDK e não foi verificada executando providers nesta análise.

Melhoria: envolver `execute` com validação de orçamento/permissão antes da ação,
propagar sinais e registrar resultado/erro de cada execução. Testar o limite
com ferramentas concorrentes e efeitos observáveis em diretório temporário.

### 9. P1 — Typecheck e CI não demonstram integridade do workspace

Evidências: `tsconfig.base.json`, manifests, `chat-service.ts` e `ci.yml`.
`types: ["bun"]` é herdado por todos, mas `@types/bun` só está declarado na CUI.
Os handlers recebem `Context` genérico e não garantem que `sessionId` exista.
O CI roda apenas os três testes de `ToolCallGuard`, sem geração Prisma/typecheck.
O reexport de tools pelo módulo do guard também amplia o grafo importado no teste.

Melhoria: declarar dependências de desenvolvimento de forma coerente, adicionar
scripts de typecheck, validar parâmetros ou recebê-los já validados e verificar
todos os pacotes no CI. Fixar uma versão de Bun conhecida. Isolar o guard de suas
dependências de execução. Medir uma instalação limpa em vez de depender do
cliente Prisma já presente na máquina.

Aceite: checkout limpo → instalação congelada → geração Prisma → typecheck →
testes, sem necessidade de chave de IA ou acesso ao banco para testes unitários.

### 10. P1 — Compatibilidade Windows ainda está incompleta

Evidência: `bash.ts` depende de `/bin/sh`, `ulimit` e sinais de grupo POSIX. A
aplicação é desenvolvida aqui em Windows, mas isso não fornece executor nativo.

Melhoria: escolher e documentar suporte inicial: WSL/Linux explicitamente ou
adapters de processo POSIX/Windows. Não mudar apenas o nome do shell: timeout,
quoting, cancelamento e árvore de processos também variam.

## Melhorias complementares

| Prioridade | Evidência e problema | Melhoria |
| --- | --- | --- |
| P1 | `web-fetch.ts` valida DNS e depois `fetch` resolve novamente | Vincular a conexão ao destino validado; testar rebinding e endereços IPv6/mapeados; validação a cada redirect sozinha não resolve rebinding |
| P1 | `web-fetch.ts` chama `arrayBuffer()` antes de verificar 5 MB | Limitar bytes durante a leitura e cancelar o body ao ultrapassar |
| P1 | `git-commit.ts` usa `git add -A` sem lista e commita todo o index | Exigir escopo explícito e preservar staged do usuário; mostrar diff antes de aprovar |
| P1 | Forms de API key usam `textarea` comum | Mascarar entrada, tratar erros sem segredos e considerar armazenamento no cofre do sistema |
| P2 | `model-registry.ts` lê JSON sem schema e faz escrita síncrona | Validar config, escrever atomicamente e sinalizar corrupção; evitar perder modelos silenciosamente |
| P2 | Configs dependem de `process.cwd()`, tema usa home | Definir diretório de configuração estável e separado do workspace-alvo |
| P2 | Nome normalizado de modelo gera variável de chave | Detectar colisões de IDs que normalizam para a mesma variável; considerar chave por provider com override |
| P2 | Listas e histórico são carregados por inteiro | Paginação, índice composto conforme consultas e ordem estável com desempate |
| P2 | Preços existem no catálogo, mas usage não é persistido | Registrar tokens de entrada/saída/cache, latência e custo estimado por geração |
| P2 | `Set` de gerações e `Map` de todos são voláteis | Estado durável para recuperação; lock compartilhado apenas quando houver múltiplos processos |
| P2 | `touchSession` ignora toda falha, apesar do comentário mencionar log | Registrar falha com contexto; decidir onde mensagem/atividade precisam de transação |
| P2 | Timer global começa antes de `resolveChatModel`, fora de `try` | Colocar inicialização e cleanup sob o mesmo ciclo de tratamento de falhas |
| P2 | `prompts/index.ts` usa `join("")`, sobrou `add more` e nomes antigos de tools | Separadores claros, instruções completas e nomes iguais aos registrados |
| P2 | Há `system-prompt.ts` antigo e aliases com erros de digitação | Remover código morto após verificar referências; consolidar fonte de verdade |
| P2 | `glob.ts` converte `**/` sem preservar bem o limite de diretório | Usar matcher consolidado ou corrigir com casos de zero/múltiplos níveis |
| P2 | `grep.ts` coleta tudo antes de buscar e aceita regex livre | Busca incremental, orçamento de tempo/arquivos e proteção contra regex custosa |
| P2 | `input-bar.tsx` concentra parser, busca, teclado e renderização | Extrair parser/hook de menções; evitar varreduras completas a cada edição |
| P2 | `BotMessage` recebe resultados, mas renderiza essencialmente chamada/args | Exibir resultado recolhível, status de erro/cancelamento e diffs legíveis |
| P2 | `/agents` alterna PLAN/BUILD | Nomear como modos até existirem agentes com responsabilidades distintas |
| P2 | CUI importa enums diretamente de arquivos gerados | Usar export público de enums; reduzir dependência do cliente/banco |
| P2 | README não inclui aplicação de migrations no fluxo de instalação | Documentar banco vazio, geração vs. migration, sistemas suportados e limites reais |

Há ainda operações concorrentes de escrita que usam checagem seguida de ação
(por exemplo, `overwrite=false` e backup). Para garantir ausência de sobrescrita,
é necessário tratar concorrência no acesso ao arquivo, não apenas checar antes.

## Evolução recomendada do motor

Começaria por uma entidade `Generation` associada à sessão e à mensagem de usuário,
com status, motivo de término, modelo, timestamps e uso de tokens. Depois,
registraria `ToolExecution` com ID da chamada, estado, argumentos filtrados e
resultado. Aprovações devem apontar para uma ação concreta dessa execução.

Isso organiza retomada, auditoria, idempotência e visualização. Não é necessário
implementar event sourcing completo ou uma fila distribuída agora. Um fluxo
durável simples no banco atual já resolve problemas importantes.

Separaria gradualmente quatro responsabilidades dentro do servidor:

1. Preparação de contexto: histórico, instruções do projeto e orçamento de tokens.
2. Execução: política, aprovação, limites, cancelamento e ferramentas.
3. Ciclo da geração: estados, persistência e recuperação.
4. Transporte: transformar eventos internos em SSE para a CUI.

## Features com potencial de diferenciação

As sugestões abaixo são hipóteses de produto baseadas nas lacunas e capacidades
do projeto, não um levantamento atual de concorrentes.

| Ordem | Feature | Valor para o usuário | Dependência |
| --- | --- | --- | --- |
| 1 | Carregamento de `AGENTS.md` e instruções por diretório | Agente respeita o projeto sem repetir instruções | Loader com precedência, limites e tratamento como conteúdo não confiável |
| 2 | Diff por ação, aprovação e desfazer com checkpoint | Usuário entende e controla o que mudou | Política de tools e preservação do estado preexistente |
| 3 | Retomada confiável após fechar terminal/reiniciar | Tarefas longas sobrevivem a interrupções | Gerações duráveis e histórico estruturado |
| 4 | Contexto visível: arquivos, origem, tokens e compactação | Controle de relevância e custo | Usage, orçamento de contexto e menções estruturadas |
| 5 | Execução em worktree isolada por tarefa | Reduz conflito com trabalho em andamento | Gestão de workspace, aprovação de merge e cleanup seguro |
| 6 | Plano aprovado convertido em passos verificáveis | Conecta planejamento à implementação e testes | Estado de tarefa e critérios de aceite |
| 7 | Diagnóstico local de ambiente/provider | Usuário resolve configuração sem tentativa e erro | Healthchecks sem expor segredos nem consumir chamadas por padrão |
| 8 | Roteamento de modelos por etapa e orçamento | Escolha de custo/qualidade com controle | Métricas reais e fallback explícito, sem repetição de ações |
| 9 | Extensões/MCP e agentes especializados | Integrações e execução paralela de tarefas delimitadas | Política, isolamento, contratos e observabilidade estabilizados |

O `AGENTS.md` criado nesta revisão orienta agentes que trabalham no repositório.
O aplicativo ainda não possui carregamento automático desse arquivo no prompt;
adicionar o arquivo não implementa essa feature no My-Code-Agent.

## Sequência de trabalho sugerida

**Etapa 1 — Fechar falhas concretas:** timeout de cinco segundos, paths/symlinks,
segredos em buscas, bind/autenticação local, tipos e CI. Cada correção deve ter
regressão focada. Saída: limites verificáveis e base compilando em checkout limpo.

**Etapa 2 — Tornar execução recuperável:** geração durável, histórico de tools,
motivos de término, cancelamento propagado e reconciliação CUI/backend.
Saída: interromper/reabrir/continuar funciona sem repetir efeitos colaterais.

**Etapa 3 — Dar controle ao usuário:** aprovação de ações, diff/checkpoint,
instruções de projeto, resultados de tools e custo/contexto visíveis.
Saída: usuário sabe o que será feito, o que foi feito e como desfazer.

**Etapa 4 — Validar diferenciais:** testar um fluxo de trabalho com usuários,
medir taxa de tarefa concluída, intervenções, tempo e custo. Só depois ampliar
MCP, múltiplos agentes, roteamento avançado ou uso remoto.

## Testes que mais reduzem risco

- Caminhos: traversal, volumes, symlinks/junctions, ancestrais inexistentes,
  arquivos sensíveis, raiz protegida e links encontrados por busca.
- Processos: execução acima de cinco segundos, timeout real, aborto prévio,
  cancelamento durante execução e limpeza de subprocessos.
- Gerações: submit/resume concorrentes, persistência parcial, erro de provider,
  falha de banco, desconexão antes/depois da gravação final e reinício.
- Contratos: eventos SSE fragmentados, inválidos, resultado sem chamada e EOF
  sem conclusão; mensagens recarregadas equivalentes às exibidas ao vivo.
- Recuperação: ação com efeito colateral já concluída não é repetida por retry.
- API: autenticação, limites de corpo, diretórios autorizados e validação de role
  inicial — atualmente a criação aceita também ASSISTANT e ERROR enviados pelo cliente.
- CUI: camadas de teclado, menções, Enter/Esc/Ctrl+C, erro de envio e troca de sessão.

As correções de segurança devem usar diretórios temporários e fixtures locais.
Os testes do motor devem simular providers; testes reais de integração ficam
separados e explicitamente configurados.

## Alterações desta entrega

Criados `AGENTS.md` e este relatório. Código de execução, dependências, banco e
configurações locais não foram alterados pela análise. As alterações preexistentes
em `.env.example`, `bun.lock`, arquivos do pacote database e referências de skills
foram preservadas. Os problemas descritos permanecem como trabalho recomendado.
