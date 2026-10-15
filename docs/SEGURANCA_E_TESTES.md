# Segurança local e testes

Esta implementação atende à proteção da API/execução de ferramentas e ao controle
de arquivos descritos nos pontos 1 e 2 da análise. A aplicação continua sendo
um agente local de um usuário; não é um serviço multiusuário.

## API e configuração

O servidor escuta somente em 127.0.0.1:3000. Todas as rotas, inclusive modelos,
chat, sessões e aprovações, exigem Authorization: Bearer com um token local.
Requisições com Origin de navegador ou Host externo são recusadas. O corpo das
requisições tem limite de 1 MiB.

Ao iniciar, o servidor cria um token aleatório em ~/.myagent/api-token. A CUI lê
esse mesmo arquivo automaticamente, sem exibir ou enviar o token ao modelo.
Em POSIX, o diretório é criado com 0700 e o arquivo com 0600; no Windows, mantenha
o diretório no perfil privado do usuário, protegido pelas ACLs do sistema.
Links e arquivos de token com múltiplos hard links são recusados.

Variáveis opcionais:

| Variável | Comportamento |
| --- | --- |
| MYAGENT_API_TOKEN | Substitui o token do arquivo; mínimo de 32 caracteres alfanuméricos, _ ou - |
| MYAGENT_CONFIG_DIR | Diretório privado do arquivo de autenticação; padrão ~/.myagent |
| MYAGENT_WORKSPACE_ROOTS | Array JSON de diretórios absolutos autorizados; padrão: diretório de execução do servidor |
| MYAGENT_SANDBOX_IMAGE | Imagem Docker Linux local e confiável para bash e type_check |
| MYAGENT_TEST_DOCKER_IMAGE | Imagem local para executar os testes reais de container |
| API_URL | URL HTTP de loopback da API para a CUI; destinos remotos são recusados |

Para trabalhar em vários projetos, configure as raízes no ambiente do servidor.
Exemplo PowerShell:

~~~powershell
$env:MYAGENT_WORKSPACE_ROOTS='["C:/projetos"]'
bun run dev:server
~~~

Criar uma sessão e executar uma ferramenta revalidam a autorização do workspace.
Sessões antigas também são verificadas antes de iniciar uma nova geração.
A CUI deve rodar no mesmo usuário do servidor, ou usar o mesmo token configurado
explicitamente. Para rotacionar o token, substitua-o de forma privada e reinicie
servidor e cliente.

## Aprovação das ferramentas

A política fica em packages/server/src/security/tool-policy.ts e permissions.ts.

- Leitura de arquivos seguros, buscas locais, Git de leitura e todos são permitidos.
- Escrita, edição, remoção, movimentação, patch e commit exigem aprovação em BUILD.
- Shell, type_check e ferramentas de rede também exigem aprovação.
- PLAN não oferece ferramentas de mutação do projeto.
- Ferramentas desconhecidas são negadas por padrão.

A CUI mostra a ferramenta e seus argumentos. Y permite aquela ação; N a nega;
Esc interrompe a geração. Aprovações expiram em dois minutos, não são reutilizáveis,
pertencem à sessão e são descartadas em caso de cancelamento/desconexão.
Não há opção de aprovação global silenciosa.

A verificação de orçamento de chamadas agora ocorre antes do executor da tool.
Erros de ferramenta, incluindo negação, são associados à chamada no stream.

## Isolamento de comandos

Não existe fallback para shell do host. Sem imagem configurada, bash e type_check
retornam erro. A imagem deve existir localmente: a execução usa --pull=never.

O servidor cria um snapshot temporário filtrado do projeto, sem credenciais,
metadata Git, node_modules ou symlinks. Esse snapshot é o único bind mount e fica
somente leitura. O container não recebe o socket Docker nem variáveis do servidor.

O container usa rede desativada, root filesystem somente leitura, usuário não
root, capabilities removidas, no-new-privileges e limites de CPU/memória/processos.
Um /tmp privado permite arquivos temporários. Timeout e cancelamento encerram
o processo/container e limpam o snapshot.

As opções seguem a [referência oficial de docker run](https://docs.docker.com/reference/cli/docker/container/run/).
Containers dependem da segurança do Docker, da imagem e do sistema operacional;
não fornecem uma garantia absoluta contra falhas do kernel/runtime.

Para disponibilizar um shell mínimo:

~~~powershell
docker pull alpine:3
$env:MYAGENT_SANDBOX_IMAGE='alpine:3'
bun run dev:server
~~~

Alpine serve para comandos shell e para os testes de isolamento. Para executar
compiladores/testes de um projeto, prepare uma imagem confiável com suas ferramentas
e dependências. O container não instala dependências pela rede nem reutiliza
executáveis do node_modules do host. Se a ferramenta precisar produzir artefatos,
use /tmp; alterações do container não são aplicadas ao projeto.
Use as tools dedicadas de arquivo para alterações aprovadas no workspace.

## Arquivos e Git

A proteção central rejeita:

- Traversal, outros volumes/UNC, nomes de dispositivos Windows, alternate data
  streams e componentes ambíguos com espaço/ponto final.
- Symlinks/junctions, mesmo internos, e arquivos com múltiplos hard links.
- Arquivos .env (exceto .env.example), chaves privadas, diretórios de credenciais,
  configuração de autenticação local e metadata .git. O arquivo api-token é
  protegido mesmo quando MYAGENT_CONFIG_DIR aponta para uma pasta personalizada.
- Acessos com raiz inválida ou erros de filesystem que não sejam ausência de arquivo.

Todos os ancestrais existentes são verificados mesmo quando vários níveis do
destino ainda não existem. Busca, glob e listagens excluem links e caminhos
sensíveis. Movimentação e exclusão de árvores recusam descendentes protegidos.
A raiz não pode ser removida ou movida.

A política identifica caminhos sensíveis; ela não detecta todo segredo possível
escrito em um arquivo comum. Os acessos dedicados no host também não constituem
uma sandbox contra outro processo local malicioso trocando diretórios durante
operações de filesystem. Evite concorrência desse tipo; a execução de código
não confiável deve permanecer no container.

Git usa metadata local, worktree explícita e ambiente reduzido. Hooks, filtros
clean/smudge/process, assinatura, pager, fsmonitor e diffs externos são desativados.
Diffs só incluem arquivos permitidos. Commit exige uma lista de arquivos e
preserva mudanças staged fora dela. Repositórios com metadata externo, links,
alternates ou arquivos .git de worktrees são recusados nesta versão.
Patches binários, symlinks, rename/copy e paths com espaços/escape devem usar as
ferramentas dedicadas em vez de apply_patch.

## Execução dos testes

Instale as dependências e gere o cliente Prisma, sem aplicar migrations:

~~~sh
bun install --frozen-lockfile --ignore-scripts
bun run --cwd packages/database db.generate
bun test
bun run typecheck
~~~

A geração Prisma usa DATABASE_URL na configuração. Pode ser uma URL fictícia
para geração/typecheck; esses comandos não precisam conectar ao banco.
Os testes normais usam arquivos temporários, banco/IA simulados e rede simulada.
Eles não chamam providers nem usam créditos. Os testes de processo/Git executam
binários locais com comandos fixos em fixtures, não comandos produzidos por IA.

Cobertura funcional incluída:

- Schemas de mensagens, catálogo e configuração de modelos, gravação de ambiente.
- Sessões: listagem, histórico, criação, validação e workspace autorizado.
- Geração: deltas, partes, persistência, interrupção, erros e associação de tools.
- CUI: leitura SSE fragmentada, aprovação, validação e EOF sem conclusão.
- Arquivos: criação, leitura, limites, edição, backup, move e delete.
- Glob, grep, diretórios, isolamento de todos por sessão e orçamento de tools.
- Git: status/diff/log, commit seletivo, hooks/filtros, patches e escopo de worktree.
- Web: busca e fetch com rede simulada, HTML, limites e bloqueio de destinos internos.
- Segurança: token, origem/Host, corpo, política, aprovação, expiração/cancelamento,
  traversal, volumes Windows, links/junctions e arquivos protegidos.
- Processos: saída limitada, timeout, cancelamento e execução acima de cinco segundos.

Para os testes reais de isolamento:

~~~powershell
docker pull alpine:3
$env:MYAGENT_TEST_DOCKER_IMAGE='alpine:3'
bun run test:integration
~~~

Eles confirmam, dentro do container, usuário não root, capabilities zeradas,
ausência de credenciais/ambiente do servidor, rede desativada, recusa de escrita
e timeout. Sem MYAGENT_TEST_DOCKER_IMAGE, esses dois testes ficam ignorados em
bun test; isso é explícito e não conta como uma execução aprovada da integração.

O CI executa testes/typecheck em Linux e Windows. Um job Linux separado executa
os testes reais de Docker. A interface interativa e o comportamento de providers
reais não são validados pelos mocks; não há alegação de cobertura total.
