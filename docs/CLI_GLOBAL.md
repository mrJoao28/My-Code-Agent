# CLI global com Bun e SQLite

O pacote é `my-code-agent`, versão inicial `0.1.0`, e instala o comando `myagent`.
O runtime necessário é Bun >= 1.3.13. O pacote ainda precisa ser publicado pelo
mantenedor; nenhuma publicação faz parte desta mudança.

## Uso

Após publicar:

```sh
npm i -g my-code-agent
cd caminho/do/projeto
myagent
```

`myagent` retoma a sessão mais recente do workspace; `--new` cria outra.
`myagent resume` lista as sessões da pasta com opção de ver todas. Ao selecionar
uma sessão de outra pasta, o launcher valida aquela pasta e inicia o servidor
autorizando somente o workspace escolhido. `resume --all` abre diretamente essa
lista completa. A seleção requer terminal interativo.

`--help` e `--version` funcionam sem abrir banco, servidor ou CUI.
`doctor` verifica Bun, escrita no diretório global, abertura e migrations do
SQLite, Docker, imagem e presença das variáveis de chave por modelo. Os valores
das chaves nunca são exibidos. Docker ausente é uma capacidade opcional; falhas
no banco/diretório global ou Bun incompatível produzem código de saída não zero.

## Workspace e isolamento

A raiz é obtida com `git rev-parse --show-toplevel`; sem Git/repositório, usa-se
a pasta atual. Os caminhos passam por realpath e pela proteção de arquivos.
Symlinks/junctions e ancestrais inexistentes são recusados. No Windows, a chave
da pasta fica em minúsculas; o título mantém o caminho absoluto exibível.

O servidor usa token aleatório por execução, loopback, porta livre e apenas um
workspace autorizado. Todas as rotas continuam protegidas contra navegador e
acesso sem token. A listagem da CUI filtra pela pasta atual. Carregamento e chat
conferem proprietário local e workspace, além do id da sessão.

Os locks de sessão ficam no SQLite, têm proprietário aleatório, heartbeat a cada
5 segundos e timeout de 30 segundos. Outro processo recebe a mensagem de pasta
aberta em outro terminal. Após falha abrupta, o lock pode ser recuperado depois
do timeout. `--new` permite outra sessão na mesma pasta. Encerramento normal
cancela gerações e libera servidor, timer de limpeza, locks e banco.

## Diretório global

O padrão é `~/.myagent/`; `MYAGENT_HOME` aceita um caminho alternativo absoluto
ou relativo, resolvido na inicialização. `MYAGENT_CONFIG_DIR` continua como alias
antigo quando `MYAGENT_HOME` não estiver definido.

O SQLite fica em `myagent.db`. WAL, busy timeout de 5000 ms e foreign keys são
ativados na abertura. As migrations SQL são importadas como texto no bundle,
executadas numa transação e registradas em `PRAGMA user_version`. Falhas
revertem toda a sequência pendente. Não há dependência do Prisma CLI no app
instalado, nem db.push, reset ou importação automática de dados do PostgreSQL.

Chaves e Ollama são salvos em `config.env`; modelos personalizados, em
`models.json`; tema, em `preferences.json`. Credenciais ChatGPT continuam em
arquivo privado próprio. Não copie o diretório global para repositórios.
Variáveis já presentes no ambiente têm precedência. A API de desenvolvimento
continua usando token privado persistido, e o launcher entrega seu token
diretamente à CUI sem gravá-lo.

## Docker e imagem

A inicialização consulta `docker info` com timeout de três segundos e
cancelamento. Sem daemon/CLI, o app continua disponível e omite bash,
type_check e test_run da lista real de ferramentas. PLAN continua sem mutações.

A imagem padrão é `oven/bun:1.3.13`; altere `MYAGENT_SANDBOX_IMAGE` para uma
imagem de confiança com compiladores e dependências do projeto. O pull acontece
somente após aprovação da primeira ferramenta que precisar dela. Uma falha de
rede é explicada sem executar comandos no host. A imagem padrão contém Bun;
ela não contém automaticamente as dependências de cada projeto nem tsc.

O container executa sem rede, com root filesystem somente leitura, usuário não
root, limites de recursos e `/tmp` descartável. O snapshot ignora credenciais,
Git, node_modules e diretórios de build; arquivos acima de 5 MiB são omitidos.
O limite total é 200 MiB e 20 mil entradas, conferido durante a leitura. As
proteções do host não eliminam corridas com outro processo trocando arquivos.

## Build e instalação local

Na raiz:

```sh
bun install --frozen-lockfile
bun run build
bun test
bun run typecheck
cd packages/myagent
npm pack
```

O build usa target Bun, inclui os pacotes do monorepo, migrations e workers de
grep/análise. Libsql, adapter/Prisma runtime, OpenTUI e React são dependências
externas declaradas. O manifest publicável não contém referências workspace.
O cliente Prisma continua gerado e ignorado pelo Git.

Na verificação inicial, Prisma, cliente e adapter estavam na versão 7.4.0.
Essa versão suporta enum/Json em SQLite, não exige o preview driverAdapters e
usa engine de cliente. O export instalado é PrismaLibSql. A baseline foi gerada
com `prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script`:
no Prisma 7, --to-schema substitui o antigo --to-schema-datamodel.

Para testar em uma pasta temporária com espaços no Windows, ajuste caminhos:

```powershell
npm i -g --prefix 'C:/temp/myagent install' --package-lock=false ./my-code-agent-0.1.0.tgz
$env:MYAGENT_HOME='C:/temp/myagent home'
Set-Location 'C:/temp/projeto com espaços'
& 'C:/temp/myagent install/myagent.cmd' --version
& 'C:/temp/myagent install/myagent.cmd' doctor
& 'C:/temp/myagent install/myagent.cmd'
```

No POSIX, o executável fica em `<prefix>/bin/myagent`. Bun precisa estar no
PATH; no Windows, o shim `.cmd` criado pelo npm o utiliza pelo shebang.
Não use target Node nem `bun build --compile` neste fluxo.

## Publicação manual

Depois de revisar o conteúdo de `npm pack --dry-run`, validar a instalação do
tarball e conferir a versão:

```sh
cd packages/myagent
npm login
npm publish --access public
```

Não publique o workspace inteiro nem inclua configurações/chaves. As migrations
PostgreSQL antigas ficam somente no repositório, fora do runner e do pacote.

## Validação registrada em 16/10/2026

Ambiente local: Windows, Bun 1.3.13. Antes das alterações, instalação com
lockfile congelado e typecheck passaram; a suíte tinha 259 aprovados e 6
ignorados, sem falhas. Ao final, `bun test` teve 278 aprovados, 2 ignorados e
nenhuma falha. O typecheck dos cinco pacotes e o build passaram separadamente.

O `npm pack` gerou um tarball de aproximadamente 2 MB, com README, manifest,
CLI e dois workers. O manifest não contém workspace:*; as migrations estão no
JavaScript. O tarball foi instalado com npm global em prefixo temporário
isolado, com espaços no caminho. Fora do repositório, o shim myagent.cmd passou
em --version e doctor, abrindo/migrando um home temporário sem PostgreSQL.
Os workers de grep e análise também executaram fora do repositório.

A CUI instalada abriu o workspace temporário, exibiu seu caminho e o aviso de
Docker ausente. Um segundo processo foi recusado pela mesma sessão. Após
Ctrl+C, uma consulta ao banco confirmou zero locks e a chave do workspace em
minúsculas. As cinco migrations/arquivos legados foram comparados ao conteúdo
original, normalizando somente CRLF/LF, sem mudanças no SQL.

As restrições da sandbox bloquearam cache npm/temporários e inspeção dos
ancestrais do perfil; as verificações correspondentes passaram com execução
autorizada fora dela. Docker real não estava disponível: os dois testes de
container foram ignorados, não aprovados. Pull e detecção de Docker foram
validados com mocks. Não houve chamadas pagas a providers, teste local em
Linux/macOS, publicação npm, commit ou push.

## Revisão de publicação — 17/10/2026

Consulte [PREPARACAO_PUBLICACAO_NPM.md](PREPARACAO_PUBLICACAO_NPM.md) para o diagnóstico,
correções, saídas verificadas, limitações e checklist manual atualizados.
