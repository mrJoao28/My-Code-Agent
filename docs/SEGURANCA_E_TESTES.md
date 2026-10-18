# Segurança local e testes

Esta implementação atende à proteção da API/execução de ferramentas e ao controle
de arquivos descritos nos pontos 1 e 2 da análise. A aplicação continua sendo
um agente local de um usuário; não é um serviço multiusuário.

## API e configuração

O launcher escuta somente em 127.0.0.1, numa porta livre; o modo de desenvolvimento
usa a porta 3000. Todas as rotas, inclusive modelos,
chat, sessões e aprovações, exigem Authorization: Bearer com um token local.
Requisições com Origin de navegador ou Host externo são recusadas. O corpo das
requisições tem limite de 1 MiB.

O launcher gera um token aleatório em memória por execução e o entrega à CUI.
No desenvolvimento, o servidor cria o token em ~/.myagent/api-token e a CUI o lê,
sem exibir ou enviar o token ao modelo.
Em POSIX, o diretório é criado com 0700 e o arquivo com 0600; no Windows, mantenha
o diretório no perfil privado do usuário, protegido pelas ACLs do sistema.
Links e arquivos de token com múltiplos hard links são recusados.

Variáveis opcionais:

| Variável | Comportamento |
| --- | --- |
| MYAGENT_API_TOKEN | Substitui o token do arquivo; mínimo de 32 caracteres alfanuméricos, _ ou - |
| MYAGENT_CONFIG_DIR | Diretório privado do arquivo de autenticação; padrão ~/.myagent |
| MYAGENT_HOME | Diretório global do banco, chaves, modelos e preferências; precede MYAGENT_CONFIG_DIR |
| MYAGENT_WORKSPACE_ROOTS | Array JSON de diretórios absolutos autorizados; padrão: diretório de execução do servidor |
| MYAGENT_SANDBOX_IMAGE | Override da imagem padrão oven/bun:1.3.13; pull na primeira execução |
| MYAGENT_SANDBOX_DEPENDENCIES | 1 habilita cópia filtrada de node_modules e .venv; padrão 0 |
| MYAGENT_SANDBOX_DEPENDENCY_MIB | Limite total das dependências por snapshot: padrão 512 MiB, entre 1 e 2048 |
| MYAGENT_SANDBOX_TMPFS_MIB | Tamanho máximo de /tmp: padrão 64 MiB, entre 1 e 4096; uso real também limitado à memória do container (512 MiB) |
| MYAGENT_TEST_BUN_DOCKER_IMAGE | Imagem Bun local para integração de testes com dependências |
| MYAGENT_TEST_DOCKER_IMAGE | Imagem local para executar os testes reais de container |
| API_URL | URL HTTP de loopback da API para a CUI; destinos remotos são recusados |

Para trabalhar em outro projeto com o launcher, abra aquela pasta e execute
`myagent`. O servidor embutido autoriza somente o workspace escolhido. Exemplo
de variável de desenvolvimento (não amplia o workspace fixado pelo launcher):

~~~powershell
$env:MYAGENT_WORKSPACE_ROOTS='["C:/projetos"]'
bun run dev:server
~~~

Criar/carregar uma sessão e executar uma ferramenta revalidam a autorização do
workspace. Carregamento e chat comparam workspacePath e proprietário local.
Locks entre processos ficam no SQLite com heartbeat e expiração; locks em memória
continuam protegendo gerações concorrentes dentro do processo.
A CUI deve rodar no mesmo usuário do servidor, ou usar o mesmo token configurado
explicitamente. Para rotacionar o token, substitua-o de forma privada e reinicie
servidor e cliente.

## Aprovação das ferramentas

A política fica em packages/server/src/security/tool-policy.ts e permissions.ts.

- Leitura de arquivos seguros, buscas locais, Git de leitura e todos são permitidos.
- Escrita, edição, remoção, movimentação, patch e commit exigem consentimento em BUILD.
  Permissões A valem somente para a mesma ferramenta, sessão, workspace e caminhos.
  Exclusão e commit sempre exigem aprovação individual.
- Com sandbox disponível, bash em BUILD, type_check e test_run são permitidos sem aprovação.
- bash continua negado em PLAN; sem sandbox, os três comandos são negados.
- web_search e web_fetch continuam exigindo aprovação.
- PLAN não oferece ferramentas de mutação do projeto.
- Ferramentas desconhecidas são negadas por padrão.

A CUI mostra comando, diff, caminho/prévia, movimentação ou URL completa. Y permite
uma vez, A permite nesta sessão e no escopo exibido, N nega; Esc/Ctrl+C interrompem
a geração. Enter não aprova. Há rolagem por setas e PgUp/PgDn. A não aparece para
git_commit e delete_file. Aprovações expiram em dois minutos, não são reutilizáveis,
pertencem à sessão e são descartadas em caso de cancelamento/desconexão.
Não há aprovação global silenciosa: o servidor guarda somente as permissões A
aprovadas no ApprovalManager, por sessionId, até o processo encerrar ou a sessão
expirar. web_fetch limita o domínio/origem (protocolo e porta incluídos); um
redirecionamento para outra origem exige uma nova chamada/aprovação.
Veja [aprovações e desfazer](APROVACOES_E_UNDO.md) para checkpoints e /undo.

A verificação de orçamento de chamadas agora ocorre antes do executor da tool.
Erros de ferramenta, incluindo negação, são associados à chamada no stream.

## Isolamento de comandos

Não existe fallback para shell do host. A inicialização verifica Docker com
timeout/cancelamento. Sem Docker, bash, type_check e test_run não são registrados;
a interface avisa que comandos estão desativados. A primeira execução
baixa a imagem padrão ou configurada se necessário, mostrando progresso. Depois
da preparação, o container usa --pull=never e roda sem rede.

O servidor cria um snapshot temporário filtrado do projeto, sem credenciais,
metadata Git ou links. Dependências são omitidas por padrão; há opt-in descrito abaixo.
Esse snapshot é o único bind mount e fica somente leitura. Arquivos acima de 5 MiB e diretórios de build são omitidos; a
leitura impõe limite de 200 MiB e 20 mil entradas. O container não recebe o socket
Docker nem variáveis do servidor.

O container usa rede desativada, root filesystem somente leitura, usuário não
root, capabilities removidas, no-new-privileges e limites de CPU/memória/processos.
Um /tmp privado permite arquivos temporários. Timeout e cancelamento encerram
o processo/container. Snapshots sem sessão são removidos ao terminar; os da sessão
expiram após cinco minutos sem uso.

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
compatíveis. O container não instala dependências pela rede. Com opt-in, CLIs
locais podem ser executadas somente dentro do container. Se a ferramenta precisar produzir artefatos,
use /tmp; alterações do container não são aplicadas ao projeto.
Use as tools dedicadas de arquivo para alterações aprovadas no workspace.

## Dependências locais e reaproveitamento do snapshot

Ative explicitamente no ambiente do launcher/servidor:

~~~powershell
$env:MYAGENT_SANDBOX_DEPENDENCIES='1'
$env:MYAGENT_SANDBOX_DEPENDENCY_MIB='512'
$env:MYAGENT_SANDBOX_TMPFS_MIB='256'
myagent doctor
myagent
~~~

O desenho usa cópia filtrada, em vez de montar diretórios mutáveis do host.
node_modules e .venv (inclusive em subpastas) entram no mesmo mount somente leitura.
O limite é de 512 MiB por padrão, 64 MiB por arquivo de dependência, 100 mil
entradas totais e 64 níveis de profundidade. Ultrapassar limites interrompe a
preparação; não se apresenta uma instalação parcial como pronta. Código mantém
os limites de 200 MiB e 5 MiB por arquivo. Nomes sensíveis continuam excluídos.
Dist/build dentro de dependências são mantidos, pois podem ser o código publicado.

Links e junctions de pacotes não são seguidos, inclusive links para workspaces
ou stores externos do pnpm. Hard links são recusados. A exceção restrita de .bin
lê o destino imediato: apenas um arquivo regular, sem outros links, seguro e
incluído no snapshot pode virar shim executável. O shim chama o original em
/workspace, preservando imports relativos; links externos, encadeados ou para
conteúdo filtrado são omitidos. Shims regulares de instalações Windows são
copiados como arquivos. Dependências nativas, scripts CRLF, shebangs absolutos e
.venv instalados no Windows/host podem não funcionar em Linux: use instalações
compatíveis com a imagem. O doctor avisa sobre executáveis ausentes na imagem;
não certifica ABI nem integridade das dependências.

Cada sessão/workspace reaproveita um snapshot. Antes de cada comando é feita
uma nova varredura de nomes, caminhos seguros, tamanho, mtime, ctime, inode e modo;
adição, remoção, mudança de configuração ou metadados invalida a cópia inteira.
Isso evita reler/copiar os bytes em comandos consecutivos sem alterações. Não é
um hash de conteúdo: alterações que preservem todos os metadados não são detectadas.
Comandos da mesma sessão usam leases serializados, sem substituir um mount ativo.
Até oito snapshots ociosos/retidos são conservados, com descarte dos ociosos quando
há pressão; entradas ativas só são liberadas depois do comando. O prazo de
inatividade é de cinco minutos. Encerramento abrupto pode deixar temporários no
sistema; não há reutilização desses diretórios por outro processo do aplicativo.

O test_run copia código para /tmp e cria referências para dependências do mount
somente leitura. Assim dependências não consomem o tmpfs nem ficam graváveis.
PATH inclui os diretórios .bin e .venv/bin da raiz e do caminho de teste. O type_check
busca tsc local antes do global. bash continua usando a área /workspace somente
leitura; use /tmp para saídas descartáveis. Nada é aplicado de volta ao host.
Todos os limites de processos, saída, tempo e rede permanecem ativos.

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

A geração Prisma não exige DATABASE_URL e não aplica migrations. O runtime usa
SQLite/libsql em ~/.myagent/myagent.db, com override por MYAGENT_HOME.
Os testes normais usam SQLite em memória/arquivos temporários, IA e rede simuladas.
Eles não chamam providers nem usam créditos. Os testes de processo/Git executam
binários locais com comandos fixos em fixtures, não comandos produzidos por IA.

Cobertura funcional incluída:

- Schemas de mensagens, catálogo e configuração de modelos, gravação de ambiente.
- Sessões: listagem, histórico, criação, validação e workspace autorizado.
- SQLite: baseline, reexecução idempotente, rollback, enums/JSON e cascatas.
- Launcher: argumentos, porta livre, autenticação e liberação dos locks.
- Workspace: raiz Git/subpastas, espaços, caixa Windows e recusa de junctions.
- Docker: ferramentas omitidas sem daemon, pull sob demanda e falha de rede simulada.
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
docker pull oven/bun:1.3.13
$env:MYAGENT_TEST_BUN_DOCKER_IMAGE='oven/bun:1.3.13'
$env:MYAGENT_TEST_DOCKER_IMAGE='alpine:3'
bun run test:integration
~~~

Eles confirmam, dentro do container, usuário não root, capabilities zeradas,
ausência de credenciais/ambiente do servidor, rede desativada, recusa de escrita
e timeout. A integração Bun verifica import de dependência instalada, escrita temporária,
dependências somente leitura e ausência de aprovação em PLAN. O caso Linux cobre
também o shim de .bin com imports relativos. Sem MYAGENT_TEST_DOCKER_IMAGE, os testes de isolamento ficam ignorados em
bun test; isso é explícito e não conta como uma execução aprovada da integração.

O CI executa testes/typecheck em Linux e Windows. Um job Linux separado executa
os testes reais de Docker. A interface interativa e o comportamento de providers
reais não são validados pelos mocks; não há alegação de cobertura total.
