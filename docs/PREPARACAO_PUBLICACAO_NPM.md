# Preparação da publicação de my-code-agent 0.1.0 — 17/10/2026

Ambiente verificado: Windows, Bun 1.3.13. Nenhuma publicação, login, alteração
no index Git, commit, push ou chamada paga a modelos foi realizada.

## P0: causa reproduzida e correção

A busca estática não encontrou strings soltas nos componentes de conversa da CUI.
A reprodução controlada com o spinner original de `HEAD`, em um bundle temporário,
produziu esta sequência real:

```text
Unknown component type: spinner
componentStack: at h2 ... DefaultErrorComponent ... RenderErrorBoundary
Text must be created inside of a text node
0 pass / 1 fail / exit 1
```

O import de `opentui-spinner/react` usado somente por efeito colateral desaparece
no bundle Bun. O spinner só monta depois do envio, quando `loading` passa a true.
O erro inicial de registro aciona o fallback DOM do React Router: o texto de
`Unexpected Application Error!` é filho de `h2`, e o stack é renderizado em `pre`.
Esses elementos não são nós de texto do OpenTUI, que gera o erro secundário mostrado.

A chamada explícita a `registerSpinner()` **já existia no working tree recebido**.
Ela foi preservada e sua eficácia foi confirmada: o mesmo teste empacotado passa
com ela e falha com o import original. Não atribuo essa alteração a esta entrega.
Foi adicionado `RouteError`, com `<box>`/`<text>` e Ctrl+C, como `errorElement` da
rota raiz. Ele mostra a mensagem original de uma exceção, evitando que um erro
futuro seja substituído pelo erro de texto do fallback DOM.

Não confirmei que mudar apenas o cwd cause a falha na entrada `src/cli.ts` original.
O código recebido já continha a correção do spinner. A cadeia acima foi reproduzida
no bundle antigo; não há evidência para atribuí-la à ausência de Git ou Docker.
Um stack em node_modules do repo também pode vir de um bundle executado nesse
checkout. As três verificações finais de mensagem passaram sem o erro.

## Publicação e empacotamento

Não foi reproduzida uma falha de publicação: o dry-run inicial já passou. Não é
possível concluir a causa das tentativas anteriores sem os erros dessas tentativas.
Foram encontrados e corrigidos estes problemas concretos:

- O bundle de desenvolvimento chamava `jsxDEV`, ausente com
  `NODE_ENV=production`. O tarball instalado falhou com `jsxDEV29 is not a function`.
  O build agora define produção explicitamente, emitindo `jsx/jsxs`. A reinstalação
  e o envio de mensagem com React de produção passaram.
- A instalação npm inicialmente escolheu React 19.3.1, enquanto o checkout testado
  usa 19.2.8. React foi fixado em 19.2.8 e OpenTUI em 0.4.5. A instalação final tem
  uma cópia física de React e uma de @opentui/react, com reconciler 0.33.0.
- `prepublishOnly` reconstruía no publish, mas não no pack. Foi substituído por
  `prepack`, evitando testar um tarball desatualizado. Publicar deve ser feito a
  partir de `packages/myagent` dentro do monorepo preparado.
- `files` agora enumera os três arquivos runtime; `publishConfig.access` é public.
  README foi ampliado em português. O lockfile mudou apenas para refletir os pins
  e a normalização do caminho do bin pelo Bun; nenhuma dependência nova foi adicionada.

O exame dos imports estáticos dos três bundles encontrou **zero dependências
externas não declaradas**. O CLI importa apenas builtins, libsql, adapter/Prisma,
React e OpenTUI (incluindo os subpaths SQLite do Prisma). Workers não deixam
imports externos. Não há jsx-dev-runtime no CLI final.

`SessionContext` já está na baseline SQLite. O runner importa somente as duas
migrations SQLite; migrations PostgreSQL arquivadas não entram no runner nem no
tarball. Não foi necessário alterar schemas ou migrations. Os prompts ativos já
anunciam os nomes reais das ferramentas e os limites da sandbox; foram preservados.
O limite de 16.384 tokens estimados e os pares chamada/resultado continuam cobertos
pelos testes existentes. A documentação de contexto agora distingue os comandos
Prisma de desenvolvimento do runner automático do aplicativo instalado.

## P1 de interface

A lista de `/agents` recebe `initialSelectedKey`; abrir em PLAN e pressionar Enter
mantém PLAN. O InputBar respeita `isTopLayer("base")` e perde foco sob diálogos.
Cada sessão deriva seu modo da última mensagem USER/ASSISTANT, ignorando ERROR;
o modelo selecionado continua compartilhado. Não há campo novo no banco.
Mudanças de modo ainda não enviadas não são persistidas ao sair da sessão.
Durante a geração, a UI mostra o modo capturado na chamada e o modo da próxima
mensagem separadamente, sem trocar as ferramentas em execução.

## Saídas e verificações

A sequência inicial solicitada foi executada antes das alterações de empacotamento:

| Comando | Saída/resultado inicial real |
| --- | --- |
| `bun install --frozen-lockfile` | Checked 214 installs across 225 packages, no changes; exit 0 |
| `bun run --cwd packages/database db.generate` | Prisma Client 7.4.0 gerado; exit 0; sem aplicar migrations |
| `bun run build` | CLI + dois workers, 3 arquivos; exit 0 |
| `bun test` | Na sandbox: 280 pass, 2 skip, 9 fail; 291 testes, 41 arquivos. As falhas envolviam EPERM nos ancestrais do perfil e EBUSY na limpeza. Repetição autorizada: 289 pass, 2 skip, 0 fail, 81,85 s |
| `bun run typecheck` | Cinco pacotes; exit 0 |
| `npm pack --dry-run` | 5 arquivos, aproximadamente 2 MB; exit 0 após liberar acesso ao cache |
| `npm pack` | my-code-agent-0.1.0.tgz, 5 arquivos; exit 0 |
| `npm publish --dry-run --access public` | + my-code-agent@0.1.0 (dry-run); exit 0 |

A verificação final, após as correções, foi:

| Verificação | Resultado real |
| --- | --- |
| `bun install --frozen-lockfile` | Exit 0; 214 installs/225 packages, sem mudanças |
| `bun test` | **295 pass, 2 skip, 0 fail; 297 testes, 44 arquivos; 84,64 s** |
| `bun run typecheck` | Cinco pacotes; exit 0 |
| `bun run build` | Prisma gerado e 3 bundles Bun; exit 0 |
| `git diff --check` | Sem erros de whitespace |
| Regressão contra spinner original | 0 pass, 1 fail, exit 1; mesma mensagem de texto observada |
| Regressão de sessão nova | 4 cenários internos em source e 4 no bundle, API simulada e providers reais, ambos aprovados |
| Guarda estática de texto JSX | 2 testes aprovados; cobre literais, espaços explícitos, números, fragmentos, condicionais e map simples; não substitui testes de expressões dinâmicas |
| `npm pack --dry-run` final | 5 arquivos revisados, listados abaixo |
| Instalação npm global isolada | 51 pacotes instalados em prefixo temporário externo com espaços; exit 0 |
| `myagent.cmd --version` | 0.1.0; exit 0 |
| `myagent.cmd doctor` | Bun 1.3.13, diretório gravável, SQLite aberto/migrado, Docker indisponível; exit 0; sem valores de chaves |
| Workers instalados | Grep retornou linha 1; análise AST retornou função fixture exportada na linha 1 |
| Binários opcionais Windows | @opentui/core-win32-x64 e @libsql/win32-x64-msvc instalados; arm64 não instalado nesta máquina x64 |
| Registro npm | `npm view my-code-agent version versions --json`: E404, pacote não encontrado na consulta; não houve versão pública observada |
| `npm publish --dry-run --access public` final | + my-code-agent@0.1.0; exit 0; nenhuma publicação |

Os testes novos precisaram isolar imports e build em subprocessos porque os mocks
globais dos testes de diálogos contaminavam o cliente HTTP/bundler. Uma execução
intermediária falhou nesse harness; o isolamento foi corrigido e a suíte final passou.

Os três testes interativos usaram um provedor determinístico em loopback,
compatível com Ollama/OpenAI, selecionando llama3.1 em `/models`:

| Modo | Workspace | Envio/resposta | Ctrl+C e SQLite |
| --- | --- | --- | --- |
| Fonte do repo, cwd externo | Pasta sem Git e com espaços | Resposta local simulada recebida; 12 tokens simulados | 0 leases, 2 mensagens |
| Tarball instalado, shim .cmd, React produção | Pasta externa com Git e espaços | Resposta local simulada recebida; 12 tokens simulados | 0 leases, 2 mensagens |
| Fonte, cwd do repo | Repositório atual com Git | Resposta local simulada recebida; 12 tokens simulados | 0 leases, 2 mensagens |

Nas três chamadas, o aviso de Docker foi exibido e `bash`, `type_check` e `test_run`
não foram enviados ao provedor. Um segundo processo foi recusado tanto na fonte
externa quanto no pacote instalado, com `Esta pasta já está aberta em outro terminal.`
e exit 1. Os bancos usados foram exclusivamente homes temporários, sem tocar nos
dados pessoais. A primeira fixture Git foi recusada por pertencer ao usuário da
sandbox; uma fixture criada pelo usuário real resolveu a falha, sem desativar
`safe.directory` nem mudar a política Git.

## Conteúdo exato do tarball final

| Arquivo | Bytes |
| --- | ---: |
| README.md | 3.283 |
| dist/cli.js | 3.168.042 |
| dist/grep-worker.js | 791 |
| dist/source-worker.js | 8.799.420 |
| package.json | 922 |

Compactado: **2.040.711 bytes**. Descompactado: **11.972.458 bytes**.
SHA-1: `966781fdad927aee8e6cc0af6dea14b21a9e9825`.
Não há .env, config.env, models.json local, .myagent, documentação interna,
migrations PostgreSQL ou código de testes nessa lista. O build não embute valores
de ambiente; somente NODE_ENV=production e MYAGENT_BUNDLED são definidos.
O bin começa com `#!/usr/bin/env bun` e não tem CRLF. O build chama chmod(0755).
O tar criado no Windows reporta modo 0644; o shim .cmd instalado funciona.
Permissões de execução após instalação npm em POSIX não foram verificadas localmente.

## Limitações e riscos restantes

- Docker real, pull real de imagem e matriz com daemon ativo: **não executados**;
  os dois testes de integração foram ignorados. Políticas e pull sob aprovação
  continuam testados com mocks, sem execução de comandos do modelo no host.
- Linux/macOS e binários de outras arquiteturas: **não executados**. Dependências
  nativas opcionais precisam existir para a plataforma; não usar --omit=optional.
- Providers reais: **não executados**, sem teste de qualidade/capacidade do modelo.
- Login, autorização real de publicação e 2FA: **não executados**. Um dry-run bem
  sucedido não autentica nem garante permissão para um publish real. Não houve
  erro de autenticação/2FA observado no dry-run; não se atribui a ele a falha anterior.
- A causa exclusiva de cwd na execução original em source não foi confirmada;
  a cadeia spinner/fallback foi reproduzida em bundle, e source atual passou.
- Não foi feita migração de bases SQLite antigas já existentes fora dos testes;
  nenhuma migration aplicada foi editada nesta entrega.

## Arquivos da entrega e trabalho preexistente

Preexistentes e preservados: `.audit-cui.ts`, a chamada registerSpinner em
`packages/cui/src/components/spinner.tsx` e
`packages/cui/src/components/session-shell.test.tsx`. Nesse spinner, esta entrega
somente passou a importar Mode pelo export público de enums.

Arquivos alterados nesta entrega:

- `bun.lock`
- `docs/CLI_GLOBAL.md`
- `docs/JANELA_CONTEXTO_E_PROMPTS.md`
- `packages/cui/src/components/dialog-search-list.tsx`
- `packages/cui/src/components/input-bar.tsx`
- `packages/cui/src/components/messages/bot-message.tsx` (somente import público de enums)
- `packages/cui/src/components/session-shell.tsx`
- `packages/cui/src/components/spinner.tsx` (preservando a alteração recebida)
- `packages/cui/src/dialogs/agents-dialog.tsx`
- `packages/cui/src/index.tsx`
- `packages/cui/src/providers/prompt-config/index.tsx`
- `packages/cui/src/screens/session.tsx`
- `packages/myagent/README.md`
- `packages/myagent/build.ts`
- `packages/myagent/package.json`

Arquivos novos: este relatório, `packages/cui/src/components/route-error.tsx`,
`packages/cui/src/dialogs/agents-dialog.test.tsx`,
`packages/cui/src/screens/session-render.test.tsx` e `scripts/cui-text.test.ts`.
A fixture local de provider e arquivos de depuração criados nesta tarefa foram
removidos. O tarball fica em `packages/myagent/my-code-agent-0.1.0.tgz` (ignorado
pelo Git). Os prefixos/homes de verificação ficam em `%TEMP%/myagent release check`.

## Checklist de publicação manual

Na raiz do checkout revisado, usando Bun no PATH:

```sh
bun install --frozen-lockfile
bun run build
bun test
bun run typecheck
cd packages/myagent
npm login
npm whoami
npm pkg get name version
npm view my-code-agent versions --json
npm pack --dry-run
npm publish --dry-run --access public
npm publish --access public
```

Na consulta de versões, E404 é esperado se o pacote continuar inexistente.
Se 0.1.0 já tiver sido publicada por outra execução, escolha nova versão, atualize
o lockfile com Bun e repita build/pack/instalação. Não tente sobrescrever versão.
Conclua qualquer desafio de autenticação/2FA solicitado pelo npm. No PowerShell
que bloqueia npm.ps1, substitua `npm` por `npm.cmd` nesses comandos.

Depois, em máquina limpa com Bun >= 1.3.13 no PATH:

```sh
bun --version
npm i -g my-code-agent
myagent --version
myagent doctor
mkdir projeto-teste
cd projeto-teste
myagent
```

Configure um modelo em `/models`, envie uma mensagem e confira a resposta.
Abra um segundo terminal na mesma pasta e confirme a recusa; encerre o primeiro
com Ctrl+C, reabra `myagent` e confira a retomada. Repita numa pasta com espaços,
com e sem Git, e valide Linux/macOS antes de anunciar suporte verificado a eles.
