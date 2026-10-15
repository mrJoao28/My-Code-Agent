# Relatório da funcionalidade `/agents`

Data: 15/10/2026. Escopo: implementação presente no workspace nesta revisão.

## Diagnóstico

O comando `/agents` abre um seletor de **modos de operação**, com duas opções fixas: BUILD e PLAN. Não existe, neste fluxo, um cadastro de agentes, perfis independentes ou delegação de tarefas. A implementação já conecta a escolha de modo ao prompt, às ferramentas do backend e ao registro das mensagens, mas deixa lacunas de estado, interação e clareza para o usuário.

As prioridades são impedir trocas acidentais, definir como o modo acompanha cada sessão e distinguir o modo da geração em andamento da escolha para a próxima mensagem. Criar agentes configuráveis pode vir depois dessas correções.

## Método e limites

- Leitura do comando, diálogo, lista de busca, input, providers de configuração e teclado, telas de sessão, hook de chat, rotas, serviços, prompts, política de ferramentas e schema Prisma.
- Execução dos testes existentes de permissões e streaming com providers simulados: **14 passaram, 0 falharam, 57 asserções**.
- Os achados de interface abaixo foram identificados por inspeção do código. Não foi realizada uma sessão manual interativa do terminal nem um teste automatizado específico de `/agents` nesta revisão. Os roteiros apresentados são passos de reprodução e critérios para os testes futuros.
- Não houve chamada real a modelos, consumo de plano, migração, alteração de credenciais ou correção do código de execução. Esta entrega altera somente este documento.
- Não foi executada novamente a suíte completa nem o typecheck, pois a mudança é exclusivamente documental. O resultado dos testes focados não certifica o restante da aplicação.

## Fluxo implementado

```text
/agents
  → COMMANDS abre AgentsDialogContent
  → DialogSearchList apresenta BUILD e PLAN
  → onSelectMode atualiza PromptConfigProvider em memória
  → próxima mensagem inclui mode no POST /chat/:sessionId
  → streamAIResponse monta prompt e ferramentas para esse modo
  → mensagens persistidas recebem mode
```

Uma nova sessão recebe o modo na mensagem inicial. Ao retomar uma mensagem pendente, o backend usa o modo persistido naquela mensagem. Não existe rota HTTP `/agents`; o nome é um comando da CUI.

### O que funciona e deve ser preservado

- O backend monta as ferramentas por modo; PLAN não depende apenas de uma instrução textual para impedir escrita.
- PLAN exclui `write_file`, `edit_file`, `delete_file`, `move_file`, `apply_patch`, `bash` e `git_commit`.
- BUILD continua submetido à política de aprovação. Selecionar BUILD não aprova automaticamente ações.
- Rede e `type_check` exigem aprovação; execução de processos mantém a sandbox Docker.
- Cada mensagem registra o modo usado. O stream mantém seu próprio modo, separado do estado global da interface.
- A lista possui busca, navegação por setas, seleção por Enter e mouse. O provider de diálogos trata Esc e clique externo.

Evidências: [tools/index.ts](../packages/server/src/tools/index.ts), [tool-policy.ts](../packages/server/src/security/tool-policy.ts), [permissions.ts](../packages/server/src/security/permissions.ts), [stream-service.ts](../packages/server/src/services/stream-service.ts), [schema.prisma](../packages/database/prisma/schema.prisma).

## Achados e sugestões

Prioridades: **P1** para comportamento incorreto ou ambíguo que pode mudar a intenção do usuário; **P2** para funcionalidade incompleta e manutenção; **P3** para refinamento visual. Não foi demonstrado um bypass da política de ferramentas por meio de `/agents`.

### 1. P1 — Abrir o seletor em PLAN e confirmar seleciona BUILD

**Evidência:** `AVAILABLE_MODES` começa por BUILD em [agents-dialog.tsx:6](../packages/cui/src/dialogs/agents-dialog.tsx#L6). A lista sempre inicializa `selectedIndex` com zero em [dialog-search-list.tsx:30](../packages/cui/src/components/dialog-search-list.tsx#L30). `currentMode` apenas desenha o marcador; não posiciona o destaque.

**Reprodução proposta:** selecionar PLAN, reabrir `/agents` e pressionar Enter sem mover as setas. O item confirmado será BUILD, embora PLAN tenha o marcador de modo atual.

**Impacto:** uma confirmação aparentemente neutra habilita o conjunto de ferramentas de BUILD na próxima mensagem. As aprovações do backend continuam necessárias.

**Correção sugerida:** permitir que a lista receba a chave inicial selecionada e abrir com o modo atual destacado. Ao filtrar, selecionar um resultado válido de forma previsível.

**Teste de aceite:** PLAN → abrir → Enter mantém PLAN; BUILD → abrir → Enter mantém BUILD; setas e busca continuam permitindo a troca explícita.

### 2. P1 — Teclado do input principal não respeita a camada do diálogo

**Evidência:** o handler de [input-bar.tsx:731](../packages/cui/src/components/input-bar.tsx#L731) verifica `disabled`, mas não `isTopLayer("base")`. Seu tratamento de Tab chama `toggleMode` na linha 882. O textarea usa `focused={!disabled}`. A lista do diálogo verifica a camada `dialog`, mas essa verificação não impede o callback global do input principal.

**Reprodução proposta:** abrir `/agents` com o input habilitado e pressionar Tab. O callback do input principal continua elegível para trocar o modo enquanto o diálogo está aberto. Como o diálogo é guardado como um ReactNode em sua configuração, o `currentMode` recebido na abertura também pode ficar desatualizado em relação ao estado global.

**Impacto:** troca de modo fora do controle visível e risco de disputa de foco/teclas entre o diálogo e o input de fundo. A ordem exata dos efeitos de Enter e foco precisa de validação interativa; não foi demonstrado envio duplicado nesta revisão.

**Correção sugerida:** condicionar atalhos do input à camada base e alinhar seu foco à visibilidade do diálogo. Aplicar a mesma regra ao menu de comandos. Consumir as teclas tratadas pelo diálogo conforme a API de eventos usada pelo projeto.

**Testes de aceite:** digitar, Tab, setas e Enter no diálogo não alteram o input de fundo nem enviam mensagens; Esc fecha e devolve o foco; repetir a abertura não deixa listeners ou camadas pendentes. Registrar também o comportamento esperado de Ctrl+C.

### 3. P1 — O modo não é recuperado ao entrar em outra sessão

**Evidência:** [prompt-config/index.tsx:31](../packages/cui/src/providers/prompt-config/index.tsx#L31) inicia em BUILD e guarda o estado apenas em memória. O provider envolve as telas em [root-layout.tsx](../packages/cui/src/layouts/root-layout.tsx). [SessionChat](../packages/cui/src/screens/session.tsx#L99) usa esse estado no próximo envio, sem restaurar o modo das mensagens carregadas. O schema guarda `mode` em `Message`, sem preferência equivalente em `Session`.

**Reprodução proposta:** usar PLAN na sessão A, mudar para BUILD na sessão B e voltar à A. O próximo envio de A usará BUILD. Reiniciar a CUI também volta ao padrão BUILD.

**Impacto:** a escolha da conversa anterior influencia outra conversa, e a intenção de continuar planejando pode se perder.

**Correção sugerida:** definir explicitamente o escopo da escolha. Recomenda-se modo por sessão, com valor inicial derivado da última mensagem pertinente; para a tela inicial, manter um padrão documentado. Caso seja necessário persistir a preferência sem enviar mensagem, avaliar um campo próprio em `Session`, com migration e contrato de atualização. Não é necessário criar uma tabela de agentes para resolver isso.

**Testes de aceite:** alternância A/B, abertura direta de sessão, reinício, sessão sem mensagens e último registro de erro. Tratar separadamente a preferência da sessão e o modo de uma mensagem pendente.

### 4. P1 — Trocar para PLAN não muda uma geração BUILD em andamento

**Evidência:** [session-shell.tsx](../packages/cui/src/components/session-shell.tsx) não desabilita o input apenas por estar em `loading`. A barra e o spinner leem o modo global. Em contrapartida, [use-chat.ts](../packages/cui/src/hooks/use-chat.ts) captura o modo no início do stream e [stream-service.ts:34](../packages/server/src/services/stream-service.ts#L34) monta as ferramentas a partir desse valor fixo.

**Reprodução proposta:** iniciar BUILD e, durante a geração, trocar para PLAN por Tab ou pelo comando. O indicador passa a PLAN, mas a geração existente mantém as ferramentas BUILD.

**Impacto:** o usuário pode interpretar a troca como suspensão das capacidades de escrita. Isso não revoga a geração ativa; as aprovações continuam valendo segundo o modo original.

**Correção sugerida:** exibir separadamente “Executando em BUILD” e “Próxima mensagem: PLAN”, ou bloquear a troca durante a geração com explicação visível. Se houver uma ação explícita para interromper e trocar, propagar o cancelamento e resolver aprovações pendentes antes de iniciar outra geração. Não alterar silenciosamente ferramentas no meio de uma chamada.

**Testes de aceite:** troca durante texto, ferramenta em execução e aprovação pendente; o modo mostrado para a geração deve corresponder ao aplicado pelo backend. A mera troca para a próxima mensagem não deve ser apresentada como cancelamento.

### 5. P2 — O nome `/agents` promete um recurso mais amplo que o implementado

**Evidência:** [commands.tsx:34](../packages/cui/src/components/command-menu/commands.tsx#L34) anuncia “Switch agents” e “Select agent”, mas o diálogo contém somente dois valores do enum `Mode`. O schema não possui entidade Agent. O backend não recebe um identificador de agente nesse fluxo.

**Impacto:** o usuário pode esperar criar um agente, escolher sua especialidade, modelo, instruções ou ferramentas. Nenhuma dessas configurações está disponível no seletor.

**Sugestão:** introduzir `/modes` como nome principal e preservar `/agents` como alias compatível, com descrição clara. Se agentes personalizados forem um objetivo do produto, tratá-los como evolução distinta, com identidade, instruções e seleção de modelo; o modo PLAN/BUILD continua sendo um limite de execução separado.

### 6. P2 — As opções não explicam capacidades, aprovações e requisitos

**Evidência:** [agents-dialog.tsx](../packages/cui/src/dialogs/agents-dialog.tsx) renderiza apenas “Plan”, “Build” e o marcador. Não apresenta descrição, ferramentas, workspace ou limitações. [stream-service.ts:37](../packages/server/src/services/stream-service.ts#L37) só disponibiliza ferramentas quando existe `cwd`.

**Impacto:** BUILD pode ser interpretado como execução irrestrita; PLAN como modo sem qualquer processo ou rede, embora `type_check` e busca web existam sob aprovação. Sessões sem workspace podem ficar apenas em conversa, sem que o seletor explique isso.

**Sugestão:** adicionar descrições curtas: PLAN analisa e propõe; BUILD implementa com ações sujeitas à aprovação. Mostrar o workspace e avisar quando ferramentas estiverem indisponíveis. Informar o requisito de Docker quando uma operação que usa sandbox for solicitada, com uma ação útil para configurar ou diagnosticar.

### 7. P2 — Não há uma passagem estruturada de plano para execução

**Evidência:** trocar o modo chama somente `onSelectMode`. Não existe plano selecionável nem aceite de um plano no diálogo. [message-format.ts](../packages/server/src/services/message-format.ts) reconstrói o histórico por texto, sem transmitir os pares de ferramentas das mensagens anteriores. O estado de tarefas de `todo_write` é mantido em memória.

**Impacto:** BUILD pode usar o texto anterior do plano como contexto, mas não existe garantia de executar uma versão específica aprovada. Resultados de inspeção e progresso estruturado podem se perder entre turnos ou após reinício.

**Sugestão:** começar com uma ação simples “Usar este plano em BUILD”, associada à mensagem que contém o plano. Persistir o estado necessário à retomada e restaurar histórico de ferramentas de forma compatível com o provider. Nunca repetir automaticamente ferramentas com efeitos colaterais para reconstruir contexto. A seleção do plano não substitui aprovações de execução.

**Testes de aceite:** plano → execução, plano editado, reinício, cancelamento parcial e retomada sem repetir escrita ou commit.

### 8. P2 — O prompt BUILD sugere ferramentas e operações incompatíveis com a implementação

**Evidência:** [prompts/tool-rules.ts:5](../packages/server/src/prompts/tool-rules.ts#L5) cita `writeFile` e `editFile`, enquanto as ferramentas registradas se chamam `write_file` e `edit_file`. Também sugere instalar dependências e iniciar servidor por bash, mas a sandbox de [sandbox.ts](../packages/server/src/security/sandbox.ts) usa `--network=none`, raiz somente leitura e snapshot do workspace montado como somente leitura.

**Impacto:** o modo BUILD pode tentar ações que falham por nome ou pelas restrições de execução, reforçando a percepção de recurso incompleto. Os schemas de ferramentas ajudam o modelo, mas não eliminam a contradição das instruções.

**Sugestão:** alinhar o prompt ativo aos nomes reais e às operações que a sandbox suporta. Explicar os limites de bash e orientar alterações pelas ferramentas dedicadas. Não flexibilizar rede, escrita ou execução no host para fazer o prompt parecer correto. Não editar a implementação antiga de `system-prompt.ts` como se fosse a fonte ativa.

### 9. P2 — Faltam testes específicos do fluxo `/agents`

**Evidência:** há testes de permissões e geração, além de testes de interface para modelos, mas a busca nos testes da CUI não encontrou cobertura específica do seletor de agentes/modos ou da sua integração com as sessões.

**Impacto:** a proteção do backend pode continuar correta enquanto a interface confirma o modo errado, perde preferência ou mistura atalhos entre camadas.

**Sugestão:** reutilizar o harness OpenTUI já empregado em [models-dialog.test.tsx](../packages/cui/src/dialogs/models-dialog.test.tsx). Priorizar testes de comportamento com providers reais da interface e API simulada, incluindo o `InputBar` atrás do diálogo; testar somente o seletor isolado não detecta a disputa de teclado.

### 10. P3 — Cores fixas e dependência de caminho interno

**Evidência:** [agents-dialog.tsx:35](../packages/cui/src/dialogs/agents-dialog.tsx#L35) usa preto/branco fixos em vez das cores do tema. O enum é importado diretamente de `database/generated/prisma/enums`, contrariando a convenção de usar `@myagent/database/enums`.

**Impacto:** há risco de contraste ruim em alguns temas, ainda sem validação visual nesta revisão. O caminho interno acopla a CUI à localização do código gerado.

**Sugestão:** usar tokens de texto e seleção do tema e o export público dos enums. Verificar tema claro/escuro e terminais estreitos. Adicionar descrição ou marcador textual ao modo ativo para não depender apenas do emoji.

## Plano de melhoria recomendado

| Etapa | Entrega | Critério de conclusão |
| --- | --- | --- |
| 1 | Corrigir seleção inicial e isolamento de teclado | Confirmar PLAN não seleciona BUILD; diálogo não dispara input de fundo |
| 2 | Definir modo por sessão e comportamento durante geração | Sessões A/B preservam intenção; indicador distingue execução atual da próxima mensagem |
| 3 | Alinhar nomes, descrições e prompt BUILD | Usuário entende os modos; instruções correspondem às ferramentas e à sandbox |
| 4 | Criar passagem de plano para execução e retomada persistente | Plano escolhido é identificável; reload preserva contexto sem repetir efeitos |
| 5 | Avaliar agentes configuráveis | Escopo e valor de produto definidos antes de criar entidade, API ou novo serviço |

Para agentes configuráveis futuros, começar com perfis pequenos: identificador, nome, descrição, instruções e preferência de modelo. Qualquer lista de ferramentas deve ser intersectada com o modo, a política central e o workspace autorizado. Texto do perfil e arquivos do projeto não podem conceder permissões. Não há necessidade demonstrada de coordenação entre múltiplos agentes para corrigir os problemas atuais.

## Matriz mínima de verificação futura

| Área | Cenários |
| --- | --- |
| Seleção | Abrir em PLAN/BUILD, Enter sem movimento, setas, mouse, busca e busca sem resultados |
| Teclado e foco | Enter, Esc, Tab, Ctrl+C, clique externo e abertura repetida com input de fundo montado |
| Sessões | Criar, alternar A/B, abrir pelo histórico, reiniciar, sessão vazia e mensagem pendente |
| Streaming | Trocar antes/durante geração, cancelar, erro do provider e aprovação pendente |
| Permissões | PLAN sem mutações; BUILD exige aprovação; ausência de workspace; Docker indisponível |
| Persistência | Mensagem registra modo efetivo; preferência restaurada; plano/tarefas recarregados quando implementados |
| Apresentação | Modo atual versus próximo modo, temas, terminal estreito e contraste |

## Verificações executadas nesta revisão

```sh
bun test packages/server/src/security/permissions.test.ts packages/server/src/services/stream-service.test.ts
```

Resultado: **14 testes passaram**, sem falhas. Incluem exclusão de ferramentas mutáveis em PLAN, política de aprovação, cancelamento, persistência e falhas de geração simulada. Esses testes confirmam uma base útil, mas não cobrem os problemas de seleção, foco, restauração de modo e apresentação descritos neste relatório.
